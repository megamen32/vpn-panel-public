// test-telegram-https.go — e2e test for the smartdns-go architecture.
//
// Verifies the two layers independently:
//   1. DNS layer (the primary test): DoU / DoT / DoH all resolve the
//      EDGE_HOST (default: t.me) to a Smart-Edge synthesized IP, and
//      bezrabotnyi.com to a direct IP.
//   2. HTTPS layer (best-effort): if smart-edge is reachable, opening
//      HTTPS_URL via the synthesized IP returns real content. Skipped
//      gracefully when smart-edge is down — that is NOT a smartdns bug.
//   3. Direct HTTPS sanity: independent check that the host has working
//      internet + DNS + TLS — does NOT depend on smart-edge.
//
// Why pure Go (no bash / python / dig):
//   - Single static binary; no alpine `apk add` for curl/dig/python3.
//   - DoT works on hosts without BIND ≥ 9.20 (was a long-standing SKIP).
//   - No risk of DPI messing with our test packet encoding (FORMERR class
//     of bugs — qname label-length mistakes etc — are caught at compile
//     time here, not by hex-edited hardcoded base64 strings).
//
// Usage:
//   go run ./test-telegram-https.go
//   SMARTDNS_HOST=10.0.0.5 go run ./test-telegram-https.go
//   EDGE_HOST=t.me HTTPS_URL=https://example.com/ go run ./test-telegram-https.go
//   SKIP_DOCKER=1 ./test-telegram-https            # after `make build`
//
// Env:
//   SMARTDNS_HOST  IP/host of smartdns-go (default: 192.168.2.5)
//   SMARTDNS_PUB   base DNS name for SNI (default: dns.bezrabotnyi.com)
//   CID            client id (default below)
//   EDGE_HOST      hostname used for the DNS routing test — must be in
//                  smartdns edge-map (default: t.me)
//   HTTPS_URL      URL for the HTTPS layer (default: https://ifconfig.me/)
//   DIRECT_HOST    host for the Direct HTTPS sanity phase (default:
//                  1.1.1.1 — known good, neutral)
//   SKIP_DOCKER    unused; the binary runs anywhere directly
//
//go:build ignore

package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Smart-Edge IPs (must match main.go edge-map).
var edgeIPs = []string{"212.192.31.128", "185.240.120.152"}

type counter struct{ pass, fail, skip int }

func (c *counter) PASS(msg string) {
	c.pass++
	fmt.Printf("  PASS  %s\n", msg)
}
func (c *counter) FAIL(msg string) {
	c.fail++
	fmt.Printf("  FAIL  %s\n", msg)
}
func (c *counter) SKIP(msg string) {
	c.skip++
	fmt.Printf("  SKIP  %s\n", msg)
}

type cfg struct {
	smartHost   string
	smartPub    string
	cid         string
	edgeHost    string
	httpsURL    string
	directHost  string
	doHPort     int
	doTPort     int
	doUPort     int
	edgeTimeout time.Duration
}

func loadCfg() cfg {
	get := func(key, def string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return def
	}
	c := cfg{
		smartHost:   get("SMARTDNS_HOST", "192.168.2.5"),
		smartPub:    get("SMARTDNS_PUB", "dns.bezrabotnyi.com"),
		cid:         get("SMARTDNS_CID", get("CID", "4cdywvixjwy4v5vzwns366ouzvufazd24hx4j6i")),
		edgeHost:    get("EDGE_HOST", "t.me"),
		httpsURL:    get("HTTPS_URL", "https://ifconfig.me/"),
		directHost:  get("DIRECT_HOST", "1.1.1.1"),
		doHPort:     8053,
		doTPort:     8853,
		doUPort:     5354,
		edgeTimeout: 8 * time.Second,
	}
	return c
}

// buildQuery builds a DNS A query for `name` with TXID 0x1234 (wire format).
func buildQuery(name string) []byte {
	var q []byte
	q = make([]byte, 12)
	binary.BigEndian.PutUint16(q[0:2], 0x1234) // TXID
	binary.BigEndian.PutUint16(q[2:4], 0x0100) // FLAGS: standard query, RD=1
	binary.BigEndian.PutUint16(q[4:6], 1)      // QDCOUNT
	for _, label := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if label == "" {
			continue
		}
		q = append(q, byte(len(label)))
		q = append(q, label...)
	}
	q = append(q, 0x00)       // root label
	q = append(q, 0x00, 0x01) // QTYPE=A
	q = append(q, 0x00, 0x01) // QCLASS=IN
	return q
}

// parseAnswers parses a DNS response and returns A-record IPs plus the
// RCODE in the low 4 bits of FLAGS.
func parseAnswers(resp []byte) (ips []string, rcode uint8, qname string, err error) {
	if len(resp) < 12 {
		return nil, 0, "", fmt.Errorf("short response (%d bytes)", len(resp))
	}
	flags := binary.BigEndian.Uint16(resp[2:4])
	rcode = uint8(flags & 0xF)
	qd := binary.BigEndian.Uint16(resp[4:6])
	an := binary.BigEndian.Uint16(resp[6:8])
	off := 12

	skipName := func() error {
		for off < len(resp) {
			l := resp[off]
			if l == 0 {
				off++
				return nil
			}
			if l&0xC0 == 0xC0 {
				if off+1 >= len(resp) {
					return errors.New("truncated name pointer")
				}
				off += 2
				return nil
			}
			off += 1 + int(l)
		}
		return errors.New("name overrun")
	}

	// Skip question section; capture the qname for display.
	for i := uint16(0); i < qd; i++ {
		startOff := off
		for off < len(resp) {
			l := resp[off]
			if l == 0 {
				off++
				break
			}
			if l&0xC0 == 0xC0 {
				off += 2
				break
			}
			off += 1 + int(l)
		}
		// Decode qname from startOff (without following pointers, just labels).
		var labels []string
		cur := startOff
		for cur < off && resp[cur] != 0 && resp[cur]&0xC0 != 0xC0 {
			l := int(resp[cur])
			cur++
			if cur+l > off {
				break
			}
			labels = append(labels, string(resp[cur:cur+l]))
			cur += l
		}
		qname = strings.Join(labels, ".")
		if off+4 > len(resp) {
			return nil, rcode, qname, errors.New("qclass overrun")
		}
		off += 4 // QTYPE + QCLASS
	}

	for i := uint16(0); i < an; i++ {
		if off >= len(resp) {
			break
		}
		if err := skipName(); err != nil {
			return ips, rcode, qname, err
		}
		if off+10 > len(resp) {
			break
		}
		rtype := binary.BigEndian.Uint16(resp[off : off+2])
		off += 8 // TYPE(2) + CLASS(2) + TTL(4)
		rdlen := int(binary.BigEndian.Uint16(resp[off : off+2]))
		off += 2
		if off+rdlen > len(resp) {
			break
		}
		if rtype == 1 && rdlen == 4 {
			ips = append(ips, net.IP(resp[off:off+4]).String())
		}
		off += rdlen
	}
	return ips, rcode, qname, nil
}

// containsEdge returns the matching edge IP, or "".
func containsEdge(ips []string) string {
	for _, ip := range ips {
		for _, e := range edgeIPs {
			if ip == e {
				return ip
			}
		}
	}
	return ""
}

// queryUDP sends a plain DNS query over UDP.
func queryUDP(host string, port int, q []byte, timeout time.Duration) ([]byte, error) {
	addr := &net.UDPAddr{IP: net.ParseIP(host), Port: port}
	conn, err := net.DialUDP("udp", nil, addr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))
	if _, err := conn.Write(q); err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

// queryDoT sends DNS-over-TLS query with TCP length-prefix framing.
func queryDoT(host string, port int, sni string, q []byte, timeout time.Duration) ([]byte, error) {
	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	rawConn, err := net.DialTimeout("tcp", addr, timeout)
	if err != nil {
		return nil, err
	}
	defer rawConn.Close()
	rawConn.SetDeadline(time.Now().Add(timeout))
	tlsConn := tls.Client(rawConn, &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	if err := tlsConn.Handshake(); err != nil {
		return nil, fmt.Errorf("TLS handshake: %w", err)
	}
	defer tlsConn.Close()
	frame := make([]byte, 2+len(q))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(q)))
	copy(frame[2:], q)
	if _, err := tlsConn.Write(frame); err != nil {
		return nil, err
	}
	var lenbuf [2]byte
	if _, err := io.ReadFull(tlsConn, lenbuf[:]); err != nil {
		return nil, fmt.Errorf("read response length: %w", err)
	}
	rlen := int(binary.BigEndian.Uint16(lenbuf[:]))
	if rlen == 0 || rlen > 4096 {
		return nil, fmt.Errorf("bad response length %d", rlen)
	}
	resp := make([]byte, rlen)
	if _, err := io.ReadFull(tlsConn, resp); err != nil {
		return nil, err
	}
	return resp, nil
}

// queryDoH sends DoH GET to /dns-query/<cid>?dns=<base64url>.
func queryDoH(host string, port int, sni string, cid string, q []byte, timeout time.Duration) ([]byte, error) {
	b64 := base64.RawURLEncoding.EncodeToString(q)
	u := url.URL{
		Scheme:   "http",
		Host:     net.JoinHostPort(sni, fmt.Sprintf("%d", port)),
		Path:     fmt.Sprintf("/dns-query/%s", cid),
		RawQuery: "dns=" + b64,
	}
	req, err := http.NewRequest("GET", u.String(), nil)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
		},
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4096))
}

// checkEdgeReach returns the first reachable Smart-Edge IP (TLS handshake
// only, no HTTP request — just confirms the relay accepts connections).
func checkEdgeReach(timeout time.Duration) string {
	for _, ip := range edgeIPs {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip, "443"), timeout)
		if err != nil {
			continue
		}
		conn.SetDeadline(time.Now().Add(timeout))
		tlsConn := tls.Client(conn, &tls.Config{ServerName: "t.me", InsecureSkipVerify: true})
		if err := tlsConn.Handshake(); err != nil {
			tlsConn.Close()
			continue
		}
		tlsConn.Close()
		return ip
	}
	return ""
}

// fetchHTTPS does a TLS GET to urlStr but dials edgeIP. Mirrors curl's
// `--resolve HOST:443:EDGE_IP`. Returns status code and bytes received.
func fetchHTTPS(urlStr, edgeIP string, timeout time.Duration) (int, int64, error) {
	u, err := url.Parse(urlStr)
	if err != nil {
		return 0, 0, err
	}
	host := u.Hostname()
	port := u.Port()
	if port == "" {
		port = "443"
	}
	dialer := &net.Dialer{Timeout: timeout}
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{ServerName: host},
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, "tcp", net.JoinHostPort(edgeIP, port))
		},
	}
	defer tr.CloseIdleConnections()
	req, err := http.NewRequest("GET", urlStr, nil)
	if err != nil {
		return 0, 0, err
	}
	req.Host = host
	client := &http.Client{Transport: tr, Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	return resp.StatusCode, n, nil
}

// fetchDirectHTTPS does a plain HTTPS GET to host (no edge routing).
// Used for the Direct HTTPS sanity phase.
func fetchDirectHTTPS(host string, timeout time.Duration) (int, int64, error) {
	tr := &http.Transport{
		TLSClientConfig: &tls.Config{ServerName: host},
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: timeout}
	req, err := http.NewRequest("GET", "https://"+host+"/", nil)
	if err != nil {
		return 0, 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer resp.Body.Close()
	n, _ := io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	return resp.StatusCode, n, nil
}

// rcodeName maps RCODE to a human label.
func rcodeName(r uint8) string {
	switch r {
	case 0:
		return "NOERROR"
	case 1:
		return "FORMERR"
	case 2:
		return "SERVFAIL"
	case 3:
		return "NXDOMAIN"
	case 4:
		return "NOTIMP"
	case 5:
		return "REFUSED"
	default:
		return fmt.Sprintf("RCODE=%d", r)
	}
}

// dnsCheck is the shared body for DoU/DoT/DoH layers (legacy helper, kept
// for reference — see runDNSLayer below for the actual implementation).

// --- main ---

func main() {
	c := loadCfg()
	cnt := &counter{}

	fmt.Printf("\nsmartdns target: %s  CID: %s…  EDGE_HOST: %s\n",
		c.smartHost, c.cid[:min(8, len(c.cid))], c.edgeHost)

	// --- Pre-flight: TCP / UDP reachability ---
	fmt.Println("\n=== Pre-flight ===")
	for _, p := range []int{c.doHPort, c.doTPort} {
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(c.smartHost, fmt.Sprintf("%d", p)), 5*time.Second)
		if err != nil {
			cnt.FAIL(fmt.Sprintf("smartdns TCP/%d NOT reachable: %v", p, err))
		} else {
			conn.Close()
			cnt.PASS(fmt.Sprintf("smartdns TCP/%d reachable", p))
		}
	}
	resp, err := queryUDP(c.smartHost, c.doUPort, buildQuery("example.com"), 5*time.Second)
	if err != nil || len(resp) < 12 {
		cnt.FAIL(fmt.Sprintf("smartdns UDP/%d (DoU) NOT reachable: %v", c.doUPort, err))
	} else {
		cnt.PASS(fmt.Sprintf("smartdns UDP/%d (DoU) reachable", c.doUPort))
	}
	if cnt.fail > 0 {
		fmt.Println("\nPre-flight failed — fix network first")
		os.Exit(1)
	}

	// --- Pre-flight: smart-edge reachability ---
	edgeReach := checkEdgeReach(c.edgeTimeout)
	if edgeReach == "" {
		cnt.SKIP("smart-edge unreachable — HTTPS phase will be best-effort")
	} else {
		cnt.PASS(fmt.Sprintf("smart-edge %s:443 reachable (TLS)", edgeReach))
	}

	// --- Layer 1: DoU ---
	runDNSLayer(cnt, c, "DoU", c.doUPort, "", func(q []byte) ([]byte, error) {
		return queryUDP(c.smartHost, c.doUPort, q, 10*time.Second)
	})

	// --- Layer 2: DoT ---
	sni := fmt.Sprintf("%s.%s", c.cid, c.smartPub)
	runDNSLayer(cnt, c, "DoT", c.doTPort, sni, func(q []byte) ([]byte, error) {
		return queryDoT(c.smartHost, c.doTPort, sni, q, 10*time.Second)
	})

	// --- Layer 3: DoH ---
	runDNSLayer(cnt, c, "DoH", c.doHPort, sni, func(q []byte) ([]byte, error) {
		return queryDoH(c.smartHost, c.doHPort, sni, c.cid, q, 15*time.Second)
	})

	// --- Layer 4: Direct HTTPS sanity (independent of smart-edge) ---
	fmt.Println("\n=== Direct HTTPS sanity (independent of smart-edge) ===")
	if status, n, err := fetchDirectHTTPS(c.directHost, 15*time.Second); err != nil {
		cnt.FAIL(fmt.Sprintf("Direct HTTPS to %s: %v", c.directHost, err))
	} else {
		cnt.PASS(fmt.Sprintf("Direct HTTPS to %s: HTTP %d (%d bytes)", c.directHost, status, n))
	}

	// --- Summary ---
	fmt.Println("\n=============================================")
	fmt.Printf("DNS+HTTPS e2e for %s (EDGE_HOST=%s)\n", c.httpsURL, c.edgeHost)
	fmt.Printf("  %d pass / %d fail / %d skip\n", cnt.pass, cnt.fail, cnt.skip)
	fmt.Println("=============================================")
	if cnt.fail > 0 {
		os.Exit(1)
	}
}

// runDNSLayer runs a single DNS transport layer (DoU/DoT/DoH).
//
// For each layer we run two queries: EDGE_HOST (must hit Smart-Edge) and
// bezrabotnyi.com (must hit direct upstream — confirms the routing split
// is working, not blanket-proxying everything).
func runDNSLayer(cnt *counter, c cfg, label string, port int, sni string,
	send func([]byte) ([]byte, error)) {

	fmt.Printf("\n=== %s (→ smartdns :%d) ===\n", label, port)

	// --- EDGE_HOST (proxy-routed → Smart-Edge IP) ---
	qEdge := buildQuery(c.edgeHost)
	resp, err := send(qEdge)
	if err != nil {
		cnt.FAIL(fmt.Sprintf("%s %s query error: %v", label, c.edgeHost, err))
	} else {
		ips, rcode, qname, perr := parseAnswers(resp)
		fmt.Printf("--- A %s (qname=%s) ---\n", c.edgeHost, qname)
		for _, ip := range ips {
			fmt.Printf("  %s\n", ip)
		}
		fmt.Printf("  RCODE=%s (%d)\n", rcodeName(rcode), rcode)
		if perr != nil {
			cnt.FAIL(fmt.Sprintf("%s %s parse error: %v", label, c.edgeHost, perr))
		} else if rcode != 0 {
			cnt.FAIL(fmt.Sprintf("%s %s returned %s", label, c.edgeHost, rcodeName(rcode)))
		} else if edge := containsEdge(ips); edge != "" {
			cnt.PASS(fmt.Sprintf("%s %s → Smart-Edge %s (proxy route)", label, c.edgeHost, edge))
			// HTTPS phase via this synthesized edge.
			if status, n, herr := fetchHTTPS(c.httpsURL, edge, 20*time.Second); herr != nil {
				cnt.FAIL(fmt.Sprintf("%s HTTPS fetch: %v", label, herr))
			} else {
				cnt.PASS(fmt.Sprintf("%s HTTPS fetch: HTTP %d (%d bytes)", label, status, n))
			}
		} else if len(ips) > 0 {
			cnt.FAIL(fmt.Sprintf("%s %s did NOT resolve to Smart-Edge (got %v)", label, c.edgeHost, ips))
		} else {
			cnt.FAIL(fmt.Sprintf("%s %s returned 0 answers", label, c.edgeHost))
		}
	}

	// --- bezrabotnyi.com (direct upstream, not proxied) ---
	qDirect := buildQuery("bezrabotnyi.com")
	resp, err = send(qDirect)
	if err != nil {
		cnt.FAIL(fmt.Sprintf("%s bezrabotnyi.com query error: %v", label, err))
		return
	}
	ips, rcode, qname, perr := parseAnswers(resp)
	fmt.Printf("--- A bezrabotnyi.com (qname=%s) ---\n", qname)
	for _, ip := range ips {
		fmt.Printf("  %s\n", ip)
	}
	fmt.Printf("  RCODE=%s (%d)\n", rcodeName(rcode), rcode)
	if perr != nil {
		cnt.FAIL(fmt.Sprintf("%s bezrabotnyi.com parse error: %v", label, perr))
	} else if rcode != 0 {
		cnt.FAIL(fmt.Sprintf("%s bezrabotnyi.com returned %s", label, rcodeName(rcode)))
	} else if edge := containsEdge(ips); edge != "" {
		cnt.FAIL(fmt.Sprintf("%s bezrabotnyi.com should NOT resolve to Smart-Edge (got %s)", label, edge))
	} else if len(ips) > 0 {
		cnt.PASS(fmt.Sprintf("%s bezrabotnyi.com resolves directly (%d answers)", label, len(ips)))
	} else {
		cnt.FAIL(fmt.Sprintf("%s bezrabotnyi.com returned 0 answers", label))
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
