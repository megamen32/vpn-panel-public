// smart-edge: TLS ClientHello SNI proxy.
//
// Reads the SNI from an incoming TLS ClientHello and forwards the raw TCP
// stream to upstream (default port 443) on the IP the SNI resolves to.
//
// Environment variables:
//
//	LISTEN_HOST   (default 127.0.0.1)
//	LISTEN_PORT   (default 9443)
//	CONNECT_PORT  (default 443)
//	DNS_CACHE_TTL_SECONDS (default 60)
//	STATS_INTERVAL_SECONDS (default 60)
//	VERBOSE       (1 enables verbose logging)
//
// Drop-in replacement for vpn_diag/smart-edge.py.patched, but as a single
// static Go binary suitable for systemd.
package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	listenHost    = envOr("LISTEN_HOST", "127.0.0.1")
	listenPort    = envInt("LISTEN_PORT", 9443)
	connectPort   = envInt("CONNECT_PORT", 443)
	dnsCacheTTL   = time.Duration(envInt("DNS_CACHE_TTL_SECONDS", 60)) * time.Second
	statsInterval = time.Duration(envInt("STATS_INTERVAL_SECONDS", 60)) * time.Second
	verbose       = os.Getenv("VERBOSE") != ""
	resolveMu     sync.Mutex
	resolveCache  = map[string]dnsCacheEntry{}
	resolveCalls  = map[string]*dnsInflight{}
	lookupIPv4    = func(ctx context.Context, host string) ([]net.IP, error) {
		return (&net.Resolver{PreferGo: true}).LookupIP(ctx, "ip4", host)
	}
	dialTCP    = net.DialTimeout
	localIPSet = discoverLocalIPs()
)

type dnsCacheEntry struct {
	ip      net.IP
	expires time.Time
}

type dnsInflight struct {
	done chan struct{}
	ip   net.IP
	err  error
}

var (
	acceptedCount  int64
	completedCount int64
	proxiedCount   int64
	rejectedCount  int64
	errorCount     int64
	activeCount    int64
)

const (
	resolveTimeout     = 3 * time.Second
	connectTimeout     = 3 * time.Second
	idleTimeout        = 10 * time.Minute
	maxRetries         = 2
	readHelloMax       = 8192
	clientHello        = 0x16
	blockSuffixes      = ".local .lan"
	maxDNSCacheEntries = 4096
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func discoverLocalIPs() map[string]struct{} {
	result := map[string]struct{}{
		"127.0.0.1": {},
		"::1":       {},
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return result
	}
	for _, addr := range addrs {
		var ip net.IP
		switch value := addr.(type) {
		case *net.IPNet:
			ip = value.IP
		case *net.IPAddr:
			ip = value.IP
		}
		if ip != nil {
			result[ip.String()] = struct{}{}
		}
	}
	return result
}

// parseSNI extracts the server name (extension type 0) from an unencrypted
// TLS ClientHello. The shape is: record | handshake | [random | sid | cs | comp | exts]
func parseSNI(b []byte) string {
	if len(b) < 5 || b[0] != clientHello {
		return ""
	}
	recLen := int(b[3])<<8 | int(b[4])
	recordEnd := 5 + recLen
	if recLen < 4 || len(b) < recordEnd {
		return ""
	}
	pos := 5
	if pos+4 > recordEnd {
		return ""
	}
	if b[pos] != 0x01 { // ClientHello
		return ""
	}
	hsLen := int(b[pos+1])<<16 | int(b[pos+2])<<8 | int(b[pos+3])
	end := pos + 4 + hsLen
	if end > recordEnd || end > len(b) {
		return ""
	}
	pos += 4
	// legacy_version(2) + random(32)
	if pos+34 > end {
		return ""
	}
	pos += 2 + 32
	if pos+1 > end {
		return ""
	}
	sidLen := int(b[pos])
	pos++
	if pos+sidLen > end {
		return ""
	}
	pos += sidLen
	if pos+2 > end {
		return ""
	}
	csLen := int(b[pos])<<8 | int(b[pos+1])
	pos += 2
	if pos+csLen > end {
		return ""
	}
	pos += csLen
	if pos+1 > end {
		return ""
	}
	compLen := int(b[pos])
	pos++
	if pos+compLen > end {
		return ""
	}
	pos += compLen
	if pos+2 > end {
		return ""
	}
	extLen := int(b[pos])<<8 | int(b[pos+1])
	pos += 2
	extEnd := pos + extLen
	if extEnd > end {
		extEnd = end
	}
	for pos+4 <= extEnd {
		etype := int(b[pos])<<8 | int(b[pos+1])
		elen := int(b[pos+2])<<8 | int(b[pos+3])
		pos += 4
		eend := pos + elen
		if eend > extEnd {
			break
		}
		if etype == 0 { // server_name
			q := pos + 2 // list_length
			if q+3 > eend || b[q] != 0 {
				return ""
			}
			q++
			nameLen := int(b[q])<<8 | int(b[q+1])
			q += 2
			if q+nameLen > eend {
				return ""
			}
			return strings.TrimSuffix(strings.ToLower(string(b[q:q+nameLen])), ".")
		}
		pos = eend
	}
	return ""
}

// allowedHost mirrors Python's `allowed_host` rules.
func allowedHost(host string) bool {
	if host == "" || len(host) > 253 {
		return false
	}
	for _, s := range strings.Fields(blockSuffixes) {
		if strings.HasSuffix(host, s) {
			return false
		}
	}
	numeric := true
	for _, ch := range host {
		if ch != '.' && (ch < '0' || ch > '9') {
			numeric = false
			break
		}
	}
	if numeric {
		return false
	}
	for _, p := range strings.Split(host, ".") {
		if p == "" || len(p) > 63 {
			return false
		}
	}
	return true
}

// readHello reads bytes from c until it has the SNI or the full first record.
// Only consumes the headers, never any application data.
func readHello(c net.Conn) ([]byte, string, error) {
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for len(buf) < readHelloMax {
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		n, err := c.Read(tmp)
		if err != nil {
			if len(buf) == 0 {
				return nil, "", err
			}
			break
		}
		buf = append(buf, tmp[:n]...)
		if sni := parseSNI(buf); sni != "" {
			return buf, sni, nil
		}
		if len(buf) >= 5 {
			rLen := int(buf[3])<<8 | int(buf[4])
			if len(buf) >= 5+rLen {
				break
			}
		}
	}
	return buf, parseSNI(buf), nil
}

// resolve returns the first IPv4 address for host.
func resolve(host string) (net.IP, error) {
	resolveMu.Lock()
	now := time.Now()
	if cached, ok := resolveCache[host]; ok && now.Before(cached.expires) {
		resolveMu.Unlock()
		return append(net.IP(nil), cached.ip...), nil
	}
	delete(resolveCache, host)
	if call, ok := resolveCalls[host]; ok {
		resolveMu.Unlock()
		<-call.done
		return append(net.IP(nil), call.ip...), call.err
	}
	call := &dnsInflight{done: make(chan struct{})}
	resolveCalls[host] = call
	resolveMu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), resolveTimeout)
	defer cancel()
	ips, err := lookupIPv4(ctx, host)
	var ip net.IP
	if err == nil {
		if len(ips) == 0 {
			err = errors.New("no A record")
		} else {
			ip = append(net.IP(nil), ips[0]...)
		}
	}

	resolveMu.Lock()
	if err == nil {
		now = time.Now()
		if len(resolveCache) >= maxDNSCacheEntries {
			for key, cached := range resolveCache {
				if !now.Before(cached.expires) {
					delete(resolveCache, key)
				}
			}
		}
		if len(resolveCache) < maxDNSCacheEntries {
			resolveCache[host] = dnsCacheEntry{ip: append(net.IP(nil), ip...), expires: now.Add(dnsCacheTTL)}
		}
	}
	call.ip = append(net.IP(nil), ip...)
	call.err = err
	delete(resolveCalls, host)
	close(call.done)
	resolveMu.Unlock()
	return append(net.IP(nil), ip...), err
}

func invalidateResolve(host string) {
	resolveMu.Lock()
	delete(resolveCache, host)
	resolveMu.Unlock()
}

// connectWithRetry dials upstream:CONNECT_PORT up to maxRetries times.
// Returns the connection, the chosen IP, and any error.
func connectWithRetry(host string) (net.Conn, string, error) {
	var lastErr error
	for attempt := 1; attempt <= maxRetries; attempt++ {
		ip, err := resolve(host)
		if err != nil {
			lastErr = err
			if attempt < maxRetries {
				time.Sleep(200 * time.Millisecond)
			}
			continue
		}
		if _, self := localIPSet[ip.String()]; self {
			invalidateResolve(host)
			return nil, "", errors.New("refusing self-loop to " + ip.String())
		}
		addr := net.JoinHostPort(ip.String(), strconv.Itoa(connectPort))
		conn, err := dialTCP("tcp", addr, connectTimeout)
		if err != nil {
			lastErr = err
			invalidateResolve(host)
			if attempt < maxRetries {
				time.Sleep(200 * time.Millisecond)
			}
			continue
		}
		return conn, ip.String(), nil
	}
	if lastErr == nil {
		lastErr = errors.New("connect failed")
	}
	return nil, "", lastErr
}

// pipe copies src → dst in 64 KiB chunks with an idle timeout. Each side
// increments *counter with bytes copied.
func pipe(dst, src net.Conn, counter *int64) {
	defer dst.Close()
	buf := make([]byte, 65536)
	for {
		_ = src.SetReadDeadline(time.Now().Add(idleTimeout))
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
			atomic.AddInt64(counter, int64(n))
		}
		if err != nil {
			return
		}
	}
}

func handle(client net.Conn) {
	defer client.Close()
	atomic.AddInt64(&activeCount, 1)
	defer atomic.AddInt64(&activeCount, -1)
	defer atomic.AddInt64(&completedCount, 1)
	peer := client.RemoteAddr().String()

	hello, sni, err := readHello(client)
	if err != nil && len(hello) == 0 {
		if verbose {
			log.Printf("reject client=%s err=%v", peer, err)
		}
		atomic.AddInt64(&rejectedCount, 1)
		return
	}
	if !allowedHost(sni) {
		atomic.AddInt64(&rejectedCount, 1)
		if verbose {
			log.Printf("reject client=%s sni=%q", peer, sni)
		}
		return
	}

	upstream, ip, err := connectWithRetry(sni)
	if err != nil {
		atomic.AddInt64(&errorCount, 1)
		log.Printf("error client=%s sni=%q type=%T msg=%s", peer, sni, err, err.Error())
		return
	}
	defer upstream.Close()
	if verbose {
		log.Printf("connect client=%s sni=%s upstream=%s:%d", peer, sni, ip, connectPort)
	}

	if _, err := upstream.Write(hello); err != nil {
		atomic.AddInt64(&errorCount, 1)
		log.Printf("error client=%s sni=%s msg=upstream write failed: %v", peer, sni, err)
		return
	}
	atomic.AddInt64(&proxiedCount, 1)

	var upBytes, downBytes int64
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		// client ← upstream: response direction (download)
		pipe(client, upstream, &downBytes)
		close(done)
	}()
	go func() {
		defer wg.Done()
		// upstream ← client: request direction (upload)
		pipe(upstream, client, &upBytes)
	}()
	<-done
	upstream.Close()
	client.Close()
	wg.Wait()
	if verbose {
		log.Printf("done client=%s sni=%s up_bytes=%d down_bytes=%d", peer, sni, upBytes, downBytes)
	}
}

func logStats() {
	for range time.NewTicker(statsInterval).C {
		log.Printf("stats accepted=%d proxied=%d completed=%d rejected=%d errors=%d active=%d dns_cache=%d",
			atomic.SwapInt64(&acceptedCount, 0),
			atomic.SwapInt64(&proxiedCount, 0),
			atomic.SwapInt64(&completedCount, 0),
			atomic.SwapInt64(&rejectedCount, 0),
			atomic.SwapInt64(&errorCount, 0),
			atomic.LoadInt64(&activeCount),
			func() int { resolveMu.Lock(); defer resolveMu.Unlock(); return len(resolveCache) }())
	}
}

func main() {
	addr := net.JoinHostPort(listenHost, strconv.Itoa(listenPort))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
	log.Printf("listening %s retries=%d connect_timeout=%ds",
		addr, maxRetries, int(connectTimeout.Seconds()))
	go logStats()
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Printf("accept error: %v", err)
			continue
		}
		atomic.AddInt64(&acceptedCount, 1)
		go handle(c)
	}
}
