package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"net"
	"strconv"
	"time"
)

// listenPlainDNSTCP serves RFC 1035 length-prefixed DNS on the LAN listener.
func (rt *runtime) listenPlainDNSTCP(listenerCfg listenCfg) error {
	if listenerCfg.Port == 0 {
		return nil
	}
	address := net.JoinHostPort(listenerCfg.Host, strconv.Itoa(listenerCfg.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen TCP DNS %s: %w", address, err)
	}
	profile := normalizeProfile(listenerCfg.Profile)
	log.Printf("TCP DNS listening %s profile=%s", address, profile)
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				log.Printf("tcp dns accept: %v", acceptErr)
				continue
			}
			go rt.handlePlainDNSConn(connection, profile)
		}
	}()
	return nil
}

// handlePlainDNSConn resolves sequential queries from one TCP DNS connection.
func (rt *runtime) handlePlainDNSConn(connection net.Conn, profile string) {
	defer connection.Close()
	peerIP := normalizeIP(connection.RemoteAddr().String())
	if host, _, err := net.SplitHostPort(connection.RemoteAddr().String()); err == nil {
		peerIP = normalizeIP(host)
	}
	clientID := rt.clientByIP(peerIP)
	if clientID == "" {
		return
	}
	lengthBuffer := make([]byte, 2)
	for {
		_ = connection.SetReadDeadline(time.Now().Add(30 * time.Second))
		if _, err := io.ReadFull(connection, lengthBuffer); err != nil {
			return
		}
		queryLength := int(binary.BigEndian.Uint16(lengthBuffer))
		if queryLength < 12 || queryLength > 4096 {
			return
		}
		query := make([]byte, queryLength)
		if _, err := io.ReadFull(connection, query); err != nil {
			return
		}
		response, err := rt.resolve(query, clientID, normalizeProfile(profile)+"-tcp", peerIP, profile)
		if err != nil {
			log.Printf("tcp dns error %s: %v", clientID, err)
			response = makeErrorResponse(query, 2)
		}
		frame := make([]byte, 2+len(response))
		binary.BigEndian.PutUint16(frame[:2], uint16(len(response)))
		copy(frame[2:], response)
		_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if _, err := connection.Write(frame); err != nil {
			return
		}
	}
}
