package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// proxyDoHResolver keeps HTTP proxy, CONNECT and TLS sessions reusable.
type proxyDoHResolver struct {
	client   *http.Client
	endpoint string
}

// newProxyDoHResolver constructs a pooled DoH client routed through an HTTP proxy.
func newProxyDoHResolver(doh proxyDoHCfg, proxy upstreamCfg) (*proxyDoHResolver, error) {
	if doh.URLHost == "" {
		doh.URLHost = "cloudflare-dns.com"
	}
	if doh.Path == "" {
		doh.Path = "/dns-query"
	}
	if doh.Port == 0 {
		doh.Port = 443
	}
	if doh.TimeoutMS <= 0 {
		doh.TimeoutMS = 7000
	}
	if proxy.Host == "" || proxy.Port <= 0 {
		return nil, fmt.Errorf("invalid HTTP proxy address %s:%d", proxy.Host, proxy.Port)
	}
	if proxy.TimeoutMS <= 0 {
		proxy.TimeoutMS = 5000
	}
	proxyURL := &url.URL{Scheme: "http", Host: net.JoinHostPort(proxy.Host, strconv.Itoa(proxy.Port))}
	dialer := &net.Dialer{Timeout: time.Duration(proxy.TimeoutMS) * time.Millisecond, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 http.ProxyURL(proxyURL),
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          64,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   time.Duration(proxy.TimeoutMS) * time.Millisecond,
		ResponseHeaderTimeout: time.Duration(doh.TimeoutMS) * time.Millisecond,
	}
	endpoint := "https://" + net.JoinHostPort(doh.URLHost, strconv.Itoa(doh.Port)) + doh.Path
	return &proxyDoHResolver{
		client:   &http.Client{Transport: transport, Timeout: time.Duration(doh.TimeoutMS) * time.Millisecond},
		endpoint: endpoint,
	}, nil
}

// query resolves one DNS wire message while reusing pooled upstream connections.
func (resolver *proxyDoHResolver) query(ctx context.Context, message []byte) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, resolver.endpoint, bytes.NewReader(message))
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/dns-message")
	request.Header.Set("content-type", "application/dns-message")
	response, err := resolver.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("DoH upstream returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8193))
	if err != nil {
		return nil, err
	}
	if len(body) == 0 || len(body) > 8192 {
		return nil, fmt.Errorf("DoH upstream returned %d bytes", len(body))
	}
	return body, nil
}
