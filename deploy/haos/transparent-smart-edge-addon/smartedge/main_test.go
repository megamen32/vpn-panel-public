package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"net"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// testConfig snapshots every package level knob a test may move so the suite
// cannot leak state into the next test.
type testConfig struct {
	proxyHost    string
	proxyPort    int
	proxyUpstrm  string
	handshake    time.Duration
	totalTimeout time.Duration
	probeThresh  int
	failThresh   int
	cdInitial    time.Duration
	cdMax        time.Duration
	dial         func(string, string, time.Duration) (net.Conn, error)
	lookup       func(context.Context, string) ([]net.IP, error)
	localAddrs   []net.Addr
	upstreamList []*upstream
	upstreamSig  string
	cache        map[string]dnsCacheEntry
	inflight     map[string]*dnsInflight
}

func saveConfig() testConfig {
	return testConfig{
		proxyHost:    proxyHost,
		proxyPort:    proxyPort,
		proxyUpstrm:  proxyUpstream,
		handshake:    handshakeIdle,
		totalTimeout: connectTotal,
		probeThresh:  probeFailThreshold,
		failThresh:   failThreshold,
		cdInitial:    cooldownInitial,
		cdMax:        cooldownMax,
		dial:         dialTCP,
		lookup:       lookupIPv4,
		localAddrs:   localAddresses,
		upstreamList: upstreams,
		upstreamSig:  upstreamConfigSig,
		cache:        resolveCache,
		inflight:     resolveCalls,
	}
}

func restoreConfig(c testConfig) {
	proxyHost = c.proxyHost
	proxyPort = c.proxyPort
	proxyUpstream = c.proxyUpstrm
	handshakeIdle = c.handshake
	connectTotal = c.totalTimeout
	probeFailThreshold = c.probeThresh
	failThreshold = c.failThresh
	cooldownInitial = c.cdInitial
	cooldownMax = c.cdMax
	dialTCP = c.dial
	lookupIPv4 = c.lookup
	localAddresses = c.localAddrs
	upstreamMu.Lock()
	upstreams = c.upstreamList
	upstreamConfigSig = c.upstreamSig
	upstreamMu.Unlock()
	resolveMu.Lock()
	resolveCache = c.cache
	resolveCalls = c.inflight
	resolveMu.Unlock()
}

// resetCaches clears DNS state so a test starts from a cold cache.
func resetCaches() {
	resolveMu.Lock()
	resolveCache = map[string]dnsCacheEntry{}
	resolveCalls = map[string]*dnsInflight{}
	resolveMu.Unlock()
}

// configure sets the upstream surface directly and forces a rebuild.
func configure(spec, host string, port int) {
	proxyUpstream = spec
	proxyHost = host
	proxyPort = port
	upstreamMu.Lock()
	upstreams = nil
	upstreamConfigSig = ""
	upstreamMu.Unlock()
}

// fakeProxy is an HTTP CONNECT proxy served over an in-memory pipe. It answers
// status (empty means: accept, answer 200, then say nothing at all), and
// optionally writes payload once the tunnel is established.
type fakeProxy struct {
	addr     string
	status   string
	payload  []byte
	hangUp   bool // answer CONNECT 200, then never write anything again
	direct   bool // no HTTP CONNECT: a plain resolved-address destination
	requests int
	mu       sync.Mutex
	stop     chan struct{}
}

// drain consumes whatever the edge writes upstream so that a client hello
// never blocks on an unbuffered net.Pipe while we are writing the response.
func (p *fakeProxy) drain(server net.Conn) {
	buf := make([]byte, 4096)
	for {
		select {
		case <-p.stop:
			return
		default:
		}
		if _, err := server.Read(buf); err != nil {
			return
		}
	}
}

func (p *fakeProxy) serve(server net.Conn) {
	defer server.Close()
	buf := make([]byte, 4096)
	request := []byte{}
	for !p.direct && !strings.Contains(string(request), "\r\n\r\n") {
		n, err := server.Read(buf)
		if err != nil {
			return
		}
		request = append(request, buf[:n]...)
	}
	if p.direct {
		// A direct destination receives the raw ClientHello, not CONNECT.
		if _, err := server.Read(buf); err != nil {
			return
		}
	}
	if !p.direct && !strings.Contains(string(request), "CONNECT ") {
		return
	}
	p.mu.Lock()
	p.requests++
	p.mu.Unlock()

	go p.drain(server)
	if p.direct {
		_, _ = server.Write(p.payload)
		<-p.stop
		return
	}
	response := p.status
	if response == "" {
		response = "HTTP/1.1 200 Connection established\r\n\r\n"
	}
	// A hangUp still answers 200: the tunnel is established and then the exit
	// carries nothing, which is exactly the black hole we must detect.
	if _, err := server.Write([]byte(response)); err != nil {
		return
	}
	if !p.hangUp && len(p.payload) > 0 {
		if _, err := server.Write(p.payload); err != nil {
			return
		}
	}
	<-p.stop
}

func (p *fakeProxy) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.requests
}

// installProxies wires dialTCP so that dialing one of the given addresses
// serves the matching fakeProxy, and any other address fails.
func installProxies(t *testing.T, proxies ...*fakeProxy) *dialLog {
	t.Helper()
	byAddr := map[string]*fakeProxy{}
	for _, p := range proxies {
		byAddr[p.addr] = p
		p.stop = make(chan struct{})
	}
	log := &dialLog{byAddr: byAddr}
	dialTCP = func(network, address string, timeout time.Duration) (net.Conn, error) {
		log.record(address)
		p, ok := byAddr[address]
		if !ok {
			return nil, errors.New("synthetic dial refusal: " + address)
		}
		client, server := net.Pipe()
		go p.serve(server)
		return client, nil
	}
	t.Cleanup(func() {
		for _, p := range proxies {
			if p.stop != nil {
				close(p.stop)
			}
		}
	})
	return log
}

type dialLog struct {
	mu       sync.Mutex
	dials    []string
	byAddr   map[string]*fakeProxy
	deadline time.Time
}

func (d *dialLog) record(address string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.dials = append(d.dials, address)
}

func (d *dialLog) countFor(address string) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	n := 0
	for _, a := range d.dials {
		if a == address {
			n++
		}
	}
	return n
}

func (d *dialLog) total() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.dials)
}

func TestParseSNIRejectsTruncatedRecordsWithoutPanic(t *testing.T) {
	cases := [][]byte{
		{0x16, 0x03, 0x01, 0x00, 0x00},
		{0x16, 0x03, 0x01, 0x00, 0x01, 0x01},
		{0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00},
	}
	for _, record := range cases {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Fatalf("parseSNI panicked for %x: %v", record, recovered)
				}
			}()
			if got := parseSNI(record); got != "" {
				t.Fatalf("parseSNI(%x) = %q, want empty", record, got)
			}
		}()
	}
}

func TestParseSNIReadsARealClientHello(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	tlsClient := tls.Client(client, &tls.Config{ServerName: "example.com", InsecureSkipVerify: true})
	go func() { _ = tlsClient.Handshake() }()
	_ = server.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, readHelloMax)
	n, err := server.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if got := parseSNI(buf[:n]); got != "example.com" {
		t.Fatalf("parseSNI(real ClientHello) = %q, want example.com", got)
	}
}

func TestResolveCachesSuccessfulIPv4Lookup(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	dnsCacheTTL = time.Minute
	lookups := 0
	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		lookups++
		return []net.IP{net.IPv4(192, 0, 2, 10)}, nil
	}
	for i := 0; i < 3; i++ {
		ip, err := resolve("cache.example")
		if err != nil {
			t.Fatal(err)
		}
		if got := ip.String(); got != "192.0.2.10" {
			t.Fatalf("resolve = %s", got)
		}
	}
	if lookups != 1 {
		t.Fatalf("lookups = %d, want 1", lookups)
	}
}

func TestResolveCacheHitIsNotBlockedByAnotherHostnameLookup(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	resolveMu.Lock()
	resolveCache = map[string]dnsCacheEntry{
		"fast.example": {ip: net.IPv4(192, 0, 2, 20), expires: time.Now().Add(time.Minute)},
	}
	resolveCalls = map[string]*dnsInflight{}
	resolveMu.Unlock()
	started := make(chan struct{})
	release := make(chan struct{})
	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		close(started)
		<-release
		return []net.IP{net.IPv4(192, 0, 2, 21)}, nil
	}
	done := make(chan struct{})
	go func() {
		_, _ = resolve("slow.example")
		close(done)
	}()
	<-started
	before := time.Now()
	ip, err := resolve("fast.example")
	if err != nil || ip.String() != "192.0.2.20" {
		t.Fatalf("fast cache hit = %v, %v", ip, err)
	}
	if elapsed := time.Since(before); elapsed > 100*time.Millisecond {
		t.Fatalf("cache hit blocked for %s", elapsed)
	}
	close(release)
	<-done
}

func TestConnectRetryInvalidatesCachedAddressAfterDialFailure(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	proxyHost = ""
	lookups := 0
	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		lookups++
		return []net.IP{net.IPv4(192, 0, 2, byte(30+lookups))}, nil
	}
	dials := 0
	dialTCP = func(string, string, time.Duration) (net.Conn, error) {
		dials++
		if dials == 1 {
			return nil, errors.New("synthetic dial failure")
		}
		client, server := net.Pipe()
		_ = server.Close()
		return client, nil
	}
	conn, ip, err := connectWithRetry("retry.example")
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if lookups != 2 || dials != 2 || ip != "192.0.2.32" {
		t.Fatalf("lookups=%d dials=%d ip=%s", lookups, dials, ip)
	}
}

func TestConnectUsesHTTPProxyAndPreservesBufferedTunnelBytes(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	configure("", "127.0.0.1", 3128)
	client, server := net.Pipe()
	defer server.Close()
	dialTCP = func(network, address string, timeout time.Duration) (net.Conn, error) {
		if network != "tcp" || address != "127.0.0.1:3128" {
			t.Fatalf("dial %s %s", network, address)
		}
		return client, nil
	}

	done := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		n, err := server.Read(buf)
		if err != nil {
			done <- err
			return
		}
		request := string(buf[:n])
		if request != "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\nProxy-Connection: keep-alive\r\n\r\n" {
			done <- errors.New("unexpected CONNECT request: " + request)
			return
		}
		// A TLS record header: enough forward progress to be believed, and it
		// arrives buffered behind the CONNECT reply rather than as a later read.
		_, err = server.Write([]byte("HTTP/1.1 200 Connection established\r\n\r\n\x16\x03\x03\x00\x9c"))
		done <- err
	}()

	conn, upstream, err := connectUpstream("example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if upstream != "127.0.0.1:3128" {
		t.Fatalf("upstream=%q", upstream)
	}
	// These bytes are read during the handshake wait and handed back through
	// the prefixed reader, so they must be the first bytes of the download
	// stream, byte for byte, with the CONNECT reply stripped.
	got := make([]byte, 5)
	if _, err := readFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if want := []byte("\x16\x03\x03\x00\x9c"); !bytes.Equal(got, want) {
		t.Fatalf("buffered bytes=%x, want %x", got, want)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// --- multi upstream ------------------------------------------------------

func TestProxyHostAndPortAloneRemainTheOnlyUpstream(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	configure("", "127.0.0.1", 3128)
	list := currentUpstreams()
	if len(list) != 1 || list[0].addr != "127.0.0.1:3128" {
		t.Fatalf("back-compat upstream list = %v", upstreamAddrs(list))
	}
}

func TestFailsOverToTheNextUpstreamAndDeliversBytes(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	good := &fakeProxy{addr: "127.0.0.1:3127", payload: []byte("hello-tunnel")}
	log := installProxies(t, good) // 3128 is not installed, so it refuses

	conn, addr, err := connectUpstream("example.com", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if addr != "127.0.0.1:3127" {
		t.Fatalf("served by %s, want 127.0.0.1:3127", addr)
	}
	got := make([]byte, len("hello-tunnel"))
	if _, err := readFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "hello-tunnel" {
		t.Fatalf("client bytes = %q", got)
	}
	if log.countFor("127.0.0.1:3128") != 1 || log.countFor("127.0.0.1:3127") != 1 {
		t.Fatalf("one attempt per upstream, got %v", log.dials)
	}
}

func TestFailingUpstreamIsQuarantinedAndSkippedEvenWhenFirst(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	failThreshold = 2
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	good := &fakeProxy{addr: "127.0.0.1:3127", payload: []byte("alive")}
	log := installProxies(t, good)

	// Two connections: the dead German exit is tried, then quarantined.
	for i := 0; i < 2; i++ {
		conn, addr, err := connectUpstream("example.com", []byte("hi"))
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
		if addr != "127.0.0.1:3127" {
			t.Fatalf("attempt %d served by %s", i, addr)
		}
	}
	if !currentUpstreams()[0].quarantined(time.Now()) {
		t.Fatal("first upstream should be quarantined after reaching the threshold")
	}

	// Third connection must not touch the quarantined upstream at all.
	log.mu.Lock()
	log.dials = nil
	log.mu.Unlock()
	conn, addr, err := connectUpstream("example.com", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if addr != "127.0.0.1:3127" {
		t.Fatalf("served by %s", addr)
	}
	if log.countFor("127.0.0.1:3128") != 0 {
		t.Fatalf("quarantined upstream was dialed: %v", log.dials)
	}
}

func TestRecoveredUpstreamRejoinsAfterCooldown(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	failThreshold = 1
	cooldownInitial = 60 * time.Millisecond
	cooldownMax = time.Second
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	good := &fakeProxy{addr: "127.0.0.1:3127", payload: []byte("alive")}
	log := installProxies(t, good)

	conn, _, err := connectUpstream("example.com", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if !currentUpstreams()[0].quarantined(time.Now()) {
		t.Fatal("expected the failing upstream to be quarantined")
	}

	// While cooling down the dead upstream stays out of the rotation.
	log.mu.Lock()
	log.dials = nil
	log.mu.Unlock()
	conn, addr, err := connectUpstream("example.com", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if addr != "127.0.0.1:3127" || log.countFor("127.0.0.1:3128") != 0 {
		t.Fatalf("quarantine not honoured: addr=%s dials=%v", addr, log.dials)
	}

	// After expiry the upstream is eligible again and is probed first, in
	// configured order, so a recovered exit rejoins on its own.
	time.Sleep(2 * cooldownInitial)
	log.mu.Lock()
	log.dials = nil
	log.mu.Unlock()
	conn, addr, err = connectUpstream("example.com", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if addr != "127.0.0.1:3127" {
		t.Fatalf("served by %s", addr)
	}
	if log.countFor("127.0.0.1:3128") != 1 {
		t.Fatalf("recovered upstream was not re-probed: %v", log.dials)
	}
}

func TestEveryUpstreamFailingBoundsTheNumberOfAttempts(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	configure("a=127.0.0.1:3128, b=127.0.0.1:3127, c=127.0.0.1:3129", "", 0)
	log := installProxies(t) // nothing installed: every dial is refused

	conn, addr, err := connectUpstream("example.com", []byte("hi"))
	if err == nil {
		t.Fatal("expected an error when every upstream fails")
	}
	if conn != nil {
		_ = conn.Close()
		t.Fatal("expected no connection when every upstream fails")
	}
	if addr != "" {
		t.Fatalf("expected no upstream address, got %q", addr)
	}
	// One attempt per upstream: bounded, and a bug cannot loop forever.
	if log.total() != 3 {
		t.Fatalf("attempts = %d, want exactly 3", log.total())
	}
	if log.total() > 8 {
		t.Fatalf("attempt count is not bounded: %d", log.total())
	}
}

// --- black holed tunnels -------------------------------------------------

func TestHandshakeIdleFailsOverToTheNextUpstream(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 80 * time.Millisecond
	failThreshold = 2
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	// 3128 answers CONNECT 200 and then stays silent forever: the classic
	// black hole of an urltest group that picked a broken exit.
	stuck := &fakeProxy{addr: "127.0.0.1:3128", hangUp: true}
	good := &fakeProxy{addr: "127.0.0.1:3127", payload: []byte("live-bytes")}
	installProxies(t, stuck, good)

	hello := []byte("client-hello")
	conn, addr, err := connectUpstream("example.com", hello)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if addr != "127.0.0.1:3127" {
		t.Fatalf("black holed tunnel was not failed over, served by %s", addr)
	}
	got := make([]byte, len("live-bytes"))
	if _, err := readFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "live-bytes" {
		t.Fatalf("client bytes = %q", got)
	}

	dead := currentUpstreams()[0]
	dead.mu.Lock()
	idles, fails, streak := dead.handshakeIdles, dead.connectFails, dead.consecFails
	dead.mu.Unlock()
	if idles != 1 {
		t.Fatalf("handshake idle count = %d, want 1", idles)
	}
	if fails != 0 {
		t.Fatalf("a black hole must not be counted as a connect failure (%d)", fails)
	}
	if streak != 1 {
		t.Fatalf("failure streak = %d, want 1", streak)
	}
}

func TestFirstUpstreamByteIsHandedToTheClientNotSwallowed(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	configure("de=127.0.0.1:3128", "", 0)
	// Answers CONNECT 200 and then forwards enough to prove it is not a black
	// hole. The payload is longer than handshakeProofBytes on purpose.
	terse := &fakeProxy{addr: "127.0.0.1:3128", payload: []byte("Zabcd")}
	installProxies(t, terse)

	conn, _, err := connectUpstream("example.com", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	one := make([]byte, 1)
	n, err := conn.Read(one)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || one[0] != 'Z' {
		t.Fatalf("read %d bytes %q, want the leading byte 'Z'", n, one[:n])
	}
	// The proof bytes must be handed over in full, not just the one read here.
	rest := make([]byte, 4)
	if _, err := readFull(conn, rest); err != nil {
		t.Fatal(err)
	}
	if string(rest) != "abcd" {
		t.Fatalf("remaining proof bytes = %q, want %q", rest, "abcd")
	}
}

func TestPartialForwardThenStallIsTreatedAsBlackHole(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 80 * time.Millisecond
	connectTotal = 5 * time.Second
	failThreshold = 2
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	// Answers CONNECT 200, writes exactly one byte - a real TLS record header
	// type - and then stalls forever. A one byte wait scored this as a full
	// success, lifted the quarantine and left the client on a one byte stream.
	truncated := &fakeProxy{addr: "127.0.0.1:3128", payload: []byte{clientHello}}
	good := &fakeProxy{addr: "127.0.0.1:3127", payload: []byte("live-bytes")}
	installProxies(t, truncated, good)

	hello := []byte("client-hello")
	conn, addr, err := connectUpstream("example.com", hello)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if addr != "127.0.0.1:3127" {
		t.Fatalf("a half forward was scored as success, served by %s", addr)
	}
	got := make([]byte, len("live-bytes"))
	if _, err := readFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "live-bytes" {
		t.Fatalf("client bytes = %q, want only the healthy upstream's bytes", got)
	}

	dead := currentUpstreams()[0]
	dead.mu.Lock()
	idles, connFails, stalled, streak, successes := dead.handshakeIdles, dead.connectFails, dead.stallBytes, dead.consecFails, dead.successes
	dead.mu.Unlock()
	if successes != 0 {
		t.Fatalf("a stalled tunnel was scored as %d success(es)", successes)
	}
	if idles != 1 || connFails != 0 {
		t.Fatalf("partial forward: hsidle=%d connfail=%d, want 1 and 0", idles, connFails)
	}
	if streak != 1 {
		t.Fatalf("failure streak = %d, want 1", streak)
	}
	if stalled != 1 {
		t.Fatalf("hsidle_bytes = %d, want the single byte that did arrive", stalled)
	}
	line := dead.statsLine()
	if !strings.Contains(line, "hsidle=1") || !strings.Contains(line, "hsidle_bytes=1") {
		t.Fatalf("stats line hides the truncated forward: %s", line)
	}
}

func TestHandshakeIdleIsCountedSeparatelyFromConnectFailures(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 50 * time.Millisecond
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	installProxies(t,
		&fakeProxy{addr: "127.0.0.1:3128", hangUp: true},
		&fakeProxy{addr: "127.0.0.1:3127", status: "HTTP/1.1 502 Bad Gateway\r\n\r\n"},
	)
	if _, _, err := connectUpstream("example.com", []byte("hi")); err == nil {
		t.Fatal("expected failure when a tunnel stalls and the next refuses CONNECT")
	}
	list := currentUpstreams()
	dead, refusing := list[0], list[1]
	dead.mu.Lock()
	deadIdles, deadConnFails := dead.handshakeIdles, dead.connectFails
	dead.mu.Unlock()
	refusing.mu.Lock()
	refuseIdles, refuseConnFails := refusing.handshakeIdles, refusing.connectFails
	refusing.mu.Unlock()
	if deadIdles != 1 || deadConnFails != 0 {
		t.Fatalf("black hole: hsidle=%d connfail=%d", deadIdles, deadConnFails)
	}
	if refuseConnFails != 1 || refuseIdles != 0 {
		t.Fatalf("non-2xx CONNECT: hsidle=%d connfail=%d", refuseIdles, refuseConnFails)
	}
	if !strings.Contains(dead.statsLine(), "hsidle=1") {
		t.Fatalf("stats line hides the stall: %s", dead.statsLine())
	}
}

func TestTotalDeadlineBoundsAttemptsAndTimeWhenEveryUpstreamBlackHoles(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	// A total outage pays the handshake wait once per upstream, so with three
	// black holes the unbounded search would take 6s before the client learns
	// anything. The connection-wide deadline has to cut that short.
	connectTotal = 400 * time.Millisecond
	configure("a=127.0.0.1:3128, b=127.0.0.1:3127, c=127.0.0.1:3129", "", 0)
	log := installProxies(t,
		&fakeProxy{addr: "127.0.0.1:3128", hangUp: true},
		&fakeProxy{addr: "127.0.0.1:3127", hangUp: true},
		&fakeProxy{addr: "127.0.0.1:3129", hangUp: true},
	)

	started := time.Now()
	conn, addr, err := connectUpstream("example.com", []byte("hi"))
	elapsed := time.Since(started)
	if err == nil {
		t.Fatal("expected failure when every upstream black holes")
	}
	if conn != nil {
		_ = conn.Close()
		t.Fatal("expected no connection when every upstream black holes")
	}
	if addr != "" {
		t.Fatalf("expected no upstream address, got %q", addr)
	}
	// The deadline, not the per upstream wait, decides the wait.
	if elapsed > 2*time.Second {
		t.Fatalf("client waited %s, want the %s deadline to fail fast", elapsed, connectTotal)
	}
	if elapsed < 100*time.Millisecond {
		t.Fatalf("gave up after %s without spending the deadline", elapsed)
	}
	if log.total() == 0 {
		t.Fatal("no upstream was tried at all")
	}
	// The deadline also caps the number of attempts rather than merely the
	// time, and one black hole is always affordable.
	if log.total() > 2 {
		t.Fatalf("attempt count not bounded by the deadline: %d", log.total())
	}
}

// --- parsing -------------------------------------------------------------

func TestParseUpstreamsAcceptsLabelsWhitespaceAndSkipsGarbage(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	configure("de=127.0.0.1:3128,  us = 127.0.0.1:3127 ,\tnonsense, , fi=127.0.0.1:3129, =1.2.3.4:1, bad=1.2.3.4:0, worse=1.2.3.4:99999", "", 0)
	list := currentUpstreams()
	want := []string{"127.0.0.1:3128", "127.0.0.1:3127", "127.0.0.1:3129"}
	if got := upstreamAddrs(list); !equalStrings(got, want) {
		t.Fatalf("parsed upstreams = %v, want %v", got, want)
	}
	labels := []string{"de", "us", "fi"}
	for i, u := range list {
		if u.label != labels[i] {
			t.Fatalf("label[%d] = %q, want %q", i, u.label, labels[i])
		}
	}
}

func TestUnparsableUpstreamListFallsBackToProxyHostAndPort(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	for _, spec := range []string{"garbage", ",,,", "=1.2.3.4:5", "no-port-here"} {
		configure(spec, "127.0.0.1", 3128)
		list := currentUpstreams()
		if len(list) != 1 || list[0].addr != "127.0.0.1:3128" {
			t.Fatalf("spec %q fell back to %v, want the single PROXY_HOST:PROXY_PORT", spec, upstreamAddrs(list))
		}
	}
}

func TestConfiguredOrderIsNeverReorderedByLatency(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	configure("first=127.0.0.1:3128, second=127.0.0.1:3127, third=127.0.0.1:3129", "", 0)
	list := currentUpstreams()
	// Give the first upstream the worst latency of all. Order must not move.
	list[0].recordSuccess(900 * time.Millisecond)
	list[1].recordSuccess(time.Millisecond)
	list[2].recordSuccess(time.Millisecond)
	got := upstreamAddrs(candidateUpstreams())
	want := []string{"127.0.0.1:3128", "127.0.0.1:3127", "127.0.0.1:3129"}
	if !equalStrings(got, want) {
		t.Fatalf("order changed with latency: %v", got)
	}
}

// --- direct mode ---------------------------------------------------------

func TestDirectModeResolvesAndDialsWithoutAnHTTPProxy(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second
	configure("", "", 0)
	if list := currentUpstreams(); len(list) != 0 {
		t.Fatalf("empty PROXY_HOST must yield no upstreams, got %v", upstreamAddrs(list))
	}
	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.IPv4(198, 51, 100, 7)}, nil
	}
	log := installProxies(t, &fakeProxy{addr: "198.51.100.7:443", payload: []byte("direct"), direct: true})

	conn, addr, err := connectUpstream("direct.example", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if addr != "198.51.100.7" {
		t.Fatalf("direct address = %s", addr)
	}
	if log.total() != 1 {
		t.Fatalf("direct mode dials = %v, want one dial to the resolved IP", log.dials)
	}
	got := make([]byte, len("direct"))
	if _, err := readFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "direct" {
		t.Fatalf("direct bytes = %q", got)
	}
}

// --- forwarding loop guard ----------------------------------------------

func TestLocalDestinationIsRefusedWithoutDialing(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	configure("", "", 0)

	ownIP := net.IPv4(192, 168, 1, 50)
	localAddresses = []net.Addr{
		&net.IPNet{IP: ownIP, Mask: net.CIDRMask(24, 32)},
		&net.IPAddr{IP: net.IPv4(10, 0, 0, 7)},
	}
	for _, ip := range []net.IP{net.IPv4(127, 0, 0, 1), net.IPv4(0, 0, 0, 0), ownIP, net.IPv4(10, 0, 0, 7)} {
		if !isLocalDestination(ip) {
			t.Fatalf("isLocalDestination(%s) = false, want true", ip)
		}
	}
	if isLocalDestination(net.IPv4(198, 51, 100, 7)) {
		t.Fatal("isLocalDestination(public ip) = true, want false")
	}

	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		return []net.IP{ownIP}, nil
	}
	dials := 0
	dialTCP = func(string, string, time.Duration) (net.Conn, error) {
		dials++
		return nil, errors.New("should not be called")
	}
	conn, addr, err := connectUpstream("public.example", []byte("hi"))
	if err == nil || !strings.Contains(err.Error(), "forwarding loop") {
		t.Fatalf("err = %v, want a forwarding loop refusal", err)
	}
	if conn != nil {
		_ = conn.Close()
		t.Fatal("expected no connection for a local destination")
	}
	if addr != "" {
		t.Fatalf("addr = %q, want empty", addr)
	}
	if dials != 0 {
		t.Fatalf("local destination was dialed %d times", dials)
	}
}

func TestLocalDestinationRefusalDoesNotMarkAnUpstreamFailing(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	handshakeIdle = 2 * time.Second

	ownIP := net.IPv4(192, 168, 1, 50)
	localAddresses = []net.Addr{&net.IPNet{IP: ownIP, Mask: net.CIDRMask(24, 32)}}

	// Direct mode: the guard fires before anything is dialed.
	configure("", "", 0)
	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		return []net.IP{ownIP}, nil
	}
	dials := 0
	dialTCP = func(string, string, time.Duration) (net.Conn, error) {
		dials++
		return nil, errors.New("must not dial a local destination")
	}
	if _, _, err := connectUpstream("public.example", []byte("hi")); err == nil {
		t.Fatal("expected a forwarding loop refusal")
	}
	if dials != 0 {
		t.Fatalf("local destination was dialed %d times", dials)
	}

	// A healthy upstream configured afterwards must carry no failure from the
	// refusal: the direct branch belongs to no upstream and the proxy branch
	// dials its upstream literally, never a resolved SNI address.
	configure("us=127.0.0.1:3127", "127.0.0.1", 3128)
	installProxies(t, &fakeProxy{addr: "127.0.0.1:3127", payload: []byte("alive")})
	conn, _, err := connectUpstream("example.com", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()

	u := currentUpstreams()[0]
	u.mu.Lock()
	streak, connFails := u.consecFails, u.connectFails
	u.mu.Unlock()
	quarantined := u.quarantined(time.Now())
	if streak != 0 || connFails != 0 || quarantined {
		t.Fatalf("refusal on the direct path marked a healthy upstream failing: streak=%d connectFails=%d quarantined=%v",
			streak, connFails, quarantined)
	}
}

// --- liveness prober -----------------------------------------------------

func TestLivenessProbeCannotClearAFailureStreak(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	failThreshold = 2
	cooldownInitial = time.Minute
	cooldownMax = time.Minute
	configure("de=127.0.0.1:3128", "", 0)
	installProxies(t, &fakeProxy{addr: "127.0.0.1:3128", payload: []byte("alive")})

	u := currentUpstreams()[0]
	u.recordConnectFailure()
	u.recordConnectFailure()
	u.mu.Lock()
	streak, okBefore := u.consecFails, u.successes
	u.mu.Unlock()
	if streak != 2 || !u.quarantined(time.Now()) {
		t.Fatalf("setup: streak=%d quarantined=%v", streak, u.quarantined(time.Now()))
	}
	_ = okBefore

	// The prober's TCP dial succeeds, which proves only that something is
	// listening. It must not be treated as a success that clears the streak.
	probeUpstream(u)

	u.mu.Lock()
	streakAfter, probesOK, cooldownLeft := u.consecFails, u.probeOK, u.cooldownUntil.Sub(time.Now())
	u.mu.Unlock()
	if streakAfter != streak {
		t.Fatalf("probe cleared the failure streak: %d -> %d", streak, streakAfter)
	}
	if cooldownLeft <= 0 {
		t.Fatal("probe lifted the quarantine")
	}
	if probesOK != 1 {
		t.Fatalf("probe successes = %d, want 1", probesOK)
	}
	if !u.quarantined(time.Now()) {
		t.Fatal("upstream left rotation after a successful TCP dial alone")
	}
}

func TestLivenessProbeFailureFeedsTheFailureStreak(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	failThreshold = 1
	cooldownInitial = time.Minute
	cooldownMax = time.Minute
	configure("de=127.0.0.1:3128", "", 0)
	// Probe loss reaches the shared streak on its own threshold, so a single
	// dropped probe is counted but is not on its own grounds for quarantine.
	probeFailThreshold = 1
	installProxies(t) // nothing listening: every dial is refused
	u := currentUpstreams()[0]
	probeUpstream(u)
	u.mu.Lock()
	streak, probes := u.consecFails, u.probeFails
	u.mu.Unlock()
	if probes != 1 || streak != 1 || !u.quarantined(time.Now()) {
		t.Fatalf("probes=%d streak=%d quarantined=%v", probes, streak, u.quarantined(time.Now()))
	}
}

func TestTwoDroppedProbesDoNotQuarantineButRealFailuresDo(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	// A real failure quarantines immediately; probe loss needs three.
	failThreshold = 1
	probeFailThreshold = 3
	cooldownInitial = time.Minute
	cooldownMax = time.Minute
	configure("de=127.0.0.1:3128, us=127.0.0.1:3127", "", 0)
	installProxies(t) // nothing listening: every dial is refused
	u := currentUpstreams()[0]

	// Two dropped SYNs in a row are routine and must leave a working exit alone.
	for i := 0; i < 2; i++ {
		probeUpstream(u)
	}
	u.mu.Lock()
	probes, probeStreak, streak := u.probeFails, u.consecProbeFails, u.consecFails
	u.mu.Unlock()
	if quarantined := u.quarantined(time.Now()); quarantined {
		t.Fatal("two dropped probes quarantined a working exit")
	}
	if probes != 2 || probeStreak != 2 || streak != 0 {
		t.Fatalf("probes=%d probe_streak=%d traffic_streak=%d, want 2, 2 and 0", probes, probeStreak, streak)
	}

	// The third consecutive drop is the documented threshold.
	probeUpstream(u)
	if !u.quarantined(time.Now()) {
		t.Fatal("three consecutive probe failures must quarantine")
	}

	// A real traffic failure quarantines on the traffic threshold alone. Take
	// an upstream with no probe history at all, so the streak cannot have come
	// from the probes above.
	untouched := currentUpstreams()[1]
	untouched.recordConnectFailure()
	if !untouched.quarantined(time.Now()) {
		t.Fatal("a real failure must quarantine on its own")
	}
	untouched.mu.Lock()
	probesAfter, streakAfter, probeStreakAfter := untouched.probeFails, untouched.consecFails, untouched.consecProbeFails
	untouched.mu.Unlock()
	if probesAfter != 0 || probeStreakAfter != 0 || streakAfter != 1 {
		t.Fatalf("after a real failure: probes=%d probe_streak=%d traffic_streak=%d, want 0, 0 and 1",
			probesAfter, probeStreakAfter, streakAfter)
	}
}

func TestSuccessDecaysTheCooldownEscalation(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	failThreshold = 1
	cooldownInitial = 10 * time.Millisecond
	cooldownMax = 80 * time.Millisecond
	configure("de=127.0.0.1:3128", "", 0)
	installProxies(t, &fakeProxy{addr: "127.0.0.1:3128", payload: []byte("alive")})
	u := currentUpstreams()[0]

	// Four failures in a row drive the escalation to the cap.
	for i := 0; i < 4; i++ {
		u.markFailure()
	}
	u.mu.Lock()
	escalated := u.cooldownCur
	u.mu.Unlock()
	if escalated != cooldownMax {
		t.Fatalf("escalation = %s, want the %s cap", escalated, cooldownMax)
	}

	// A handshake decays it. Without this the cap is permanent: an upstream
	// driven to it once quarantines for the cap forever.
	u.recordSuccess(time.Millisecond)
	u.mu.Lock()
	after := u.cooldownCur
	u.mu.Unlock()
	if after != cooldownInitial {
		t.Fatalf("cooldown escalation after a success = %s, want the base %s", after, cooldownInitial)
	}

	// The next bad episode must therefore be short again.
	u.markFailure()
	if left := u.cooldownLeft(time.Now()); left > cooldownInitial+50*time.Millisecond {
		t.Fatalf("quarantine after a recovery = %s, want about %s", left, cooldownInitial)
	}
}

// --- env contract --------------------------------------------------------

func TestEnvironmentDefinesThreeUpstreamsInConfiguredOrder(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)

	for k, v := range map[string]string{
		"PROXY_UPSTREAMS":                    "de=127.0.0.1:3128, us = 127.0.0.1:3127,fi=127.0.0.1:3129",
		"PROXY_HOST":                         "10.99.99.99",
		"PROXY_PORT":                         "9999",
		"HANDSHAKE_IDLE_TIMEOUT":             "7",
		"CONNECT_TOTAL_TIMEOUT":              "25",
		"UPSTREAM_FAILURE_THRESHOLD":         "4",
		"UPSTREAM_PROBE_FAILURE_THRESHOLD":   "5",
		"UPSTREAM_COOLDOWN_SECONDS":          "11",
		"UPSTREAM_COOLDOWN_MAX_SECONDS":      "22",
		"UPSTREAM_LIVENESS_ENABLED":          "false",
		"UPSTREAM_LIVENESS_INTERVAL_SECONDS": "33",
	} {
		t.Setenv(k, v)
	}

	// Exactly how the process starts: read the environment, nothing else.
	loadConfigFromEnv()
	upstreamMu.Lock()
	upstreams = nil
	upstreamConfigSig = ""
	upstreamMu.Unlock()

	list := currentUpstreams()
	want := []string{"127.0.0.1:3128", "127.0.0.1:3127", "127.0.0.1:3129"}
	if got := upstreamAddrs(list); !equalStrings(got, want) {
		t.Fatalf("env upstreams = %v, want %v", got, want)
	}
	labels := []string{"de", "us", "fi"}
	for i, u := range list {
		if u.label != labels[i] {
			t.Fatalf("label[%d] = %q, want %q", i, u.label, labels[i])
		}
	}
	if handshakeIdle != 7*time.Second {
		t.Fatalf("HANDSHAKE_IDLE_TIMEOUT = %s, want 7s", handshakeIdle)
	}
	if connectTotal != 25*time.Second {
		t.Fatalf("CONNECT_TOTAL_TIMEOUT = %s, want 25s", connectTotal)
	}
	if failThreshold != 4 {
		t.Fatalf("UPSTREAM_FAILURE_THRESHOLD = %d, want 4", failThreshold)
	}
	if probeFailThreshold != 5 {
		t.Fatalf("UPSTREAM_PROBE_FAILURE_THRESHOLD = %d, want 5", probeFailThreshold)
	}
	if cooldownInitial != 11*time.Second || cooldownMax != 22*time.Second {
		t.Fatalf("cooldown = %s/%s, want 11s/22s", cooldownInitial, cooldownMax)
	}
	if livenessEnabled {
		t.Fatal("UPSTREAM_LIVENESS_ENABLED=false was ignored")
	}
	if livenessInterval != 33*time.Second {
		t.Fatalf("UPSTREAM_LIVENESS_INTERVAL_SECONDS = %s, want 33s", livenessInterval)
	}
}

func TestEnvironmentWithoutUpstreamListKeepsTheLegacySingleProxy(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)

	t.Setenv("PROXY_UPSTREAMS", "")
	t.Setenv("PROXY_HOST", "127.0.0.1")
	t.Setenv("PROXY_PORT", "3128")
	t.Setenv("HANDSHAKE_IDLE_TIMEOUT", "")
	t.Setenv("CONNECT_TOTAL_TIMEOUT", "")
	t.Setenv("UPSTREAM_FAILURE_THRESHOLD", "")
	t.Setenv("UPSTREAM_PROBE_FAILURE_THRESHOLD", "")
	t.Setenv("UPSTREAM_COOLDOWN_SECONDS", "")
	t.Setenv("UPSTREAM_COOLDOWN_MAX_SECONDS", "")
	t.Setenv("UPSTREAM_LIVENESS_INTERVAL_SECONDS", "")

	loadConfigFromEnv()
	upstreamMu.Lock()
	upstreams = nil
	upstreamConfigSig = ""
	upstreamMu.Unlock()

	list := currentUpstreams()
	if len(list) != 1 || list[0].addr != "127.0.0.1:3128" {
		t.Fatalf("legacy upstreams = %v, want a single 127.0.0.1:3128", upstreamAddrs(list))
	}
	if handshakeIdle != 10*time.Second || connectTotal != 20*time.Second || failThreshold != 2 ||
		probeFailThreshold != 3 || cooldownInitial != 60*time.Second {
		t.Fatalf("defaults lost: idle=%s total=%s threshold=%d probe_threshold=%d cooldown=%s",
			handshakeIdle, connectTotal, failThreshold, probeFailThreshold, cooldownInitial)
	}
}

func TestEmptyProxyHostViaEnvironmentSelectsDirectMode(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	resetCaches()
	// Only PROXY_HOST is set. PROXY_PORT is left at its default 3128 on purpose:
	// with PROXY_PORT=0 this test passed even while PROXY_HOST="" still
	// synthesised a proxy upstream, so it certified nothing.
	t.Setenv("PROXY_UPSTREAMS", "")
	t.Setenv("PROXY_HOST", "")
	loadConfigFromEnv()
	upstreamMu.Lock()
	upstreams = nil
	upstreamConfigSig = ""
	upstreamMu.Unlock()

	if proxyHost != "" || proxyPort != 3128 {
		t.Fatalf("env read gave %s:%d, want an empty host beside the default port", proxyHost, proxyPort)
	}
	if list := currentUpstreams(); len(list) != 0 {
		t.Fatalf("direct mode should have no upstreams, got %v", upstreamAddrs(list))
	}

	// And the mode really is direct resolution: one dial to the resolved SNI
	// address, no HTTP CONNECT to any proxy.
	handshakeIdle = 2 * time.Second
	connectTotal = 5 * time.Second
	lookupIPv4 = func(context.Context, string) ([]net.IP, error) {
		return []net.IP{net.IPv4(198, 51, 100, 9)}, nil
	}
	log := installProxies(t, &fakeProxy{addr: "198.51.100.9:443", payload: []byte("direct"), direct: true})

	conn, addr, err := connectUpstream("direct.example", []byte("hi"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if addr != "198.51.100.9" {
		t.Fatalf("direct address = %s", addr)
	}
	if log.total() != 1 {
		t.Fatalf("direct mode dials = %v, want one dial to the resolved IP", log.dials)
	}
	got := make([]byte, len("direct"))
	if _, err := readFull(conn, got); err != nil {
		t.Fatal(err)
	}
	if string(got) != "direct" {
		t.Fatalf("direct bytes = %q", got)
	}
}

func TestUnsetProxyHostStillTakesTheDefaultProxy(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	// The other half of the contract: an absent variable takes the default, so
	// the direct mode is opt in and never silently inherited.
	if v, ok := os.LookupEnv("PROXY_HOST"); ok {
		t.Cleanup(func() { _ = os.Setenv("PROXY_HOST", v) })
	}
	if err := os.Unsetenv("PROXY_HOST"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PROXY_UPSTREAMS", "")
	loadConfigFromEnv()
	upstreamMu.Lock()
	upstreams = nil
	upstreamConfigSig = ""
	upstreamMu.Unlock()
	if proxyHost != "127.0.0.1" {
		t.Fatalf("unset PROXY_HOST gave %q, want the 127.0.0.1 default", proxyHost)
	}
	list := currentUpstreams()
	if len(list) != 1 || list[0].addr != "127.0.0.1:3128" {
		t.Fatalf("unset PROXY_HOST upstreams = %v, want a single 127.0.0.1:3128", upstreamAddrs(list))
	}
}

func TestEnvironmentIsTheOnlyConfigSurface(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	// Guard against the binary growing a homegrown config surface: every knob
	// must have a default that applies when the env var is absent. Absent, not
	// empty: PROXY_HOST="" is a meaningful value of its own and has its own
	// test, so an empty string here must not be used as a stand in for unset.
	for _, k := range []string{
		"LISTEN_HOST", "LISTEN_PORT", "CONNECT_PORT", "PROXY_HOST", "PROXY_PORT",
		"PROXY_UPSTREAMS", "HANDSHAKE_IDLE_TIMEOUT", "CONNECT_TOTAL_TIMEOUT",
		"UPSTREAM_FAILURE_THRESHOLD", "UPSTREAM_PROBE_FAILURE_THRESHOLD",
		"UPSTREAM_COOLDOWN_SECONDS", "UPSTREAM_COOLDOWN_MAX_SECONDS",
		"UPSTREAM_LIVENESS_ENABLED", "UPSTREAM_LIVENESS_INTERVAL_SECONDS",
		"DNS_CACHE_TTL_SECONDS", "STATS_INTERVAL_SECONDS",
	} {
		if v, ok := os.LookupEnv(k); ok {
			t.Cleanup(func() { _ = os.Setenv(k, v) })
		}
		if err := os.Unsetenv(k); err != nil {
			t.Fatalf("unset %s: %v", k, err)
		}
	}
	loadConfigFromEnv()
	if listenHost != "127.0.0.1" || listenPort != 9443 || connectPort != 443 {
		t.Fatalf("listen defaults drifted: listen=%s:%d connect_port=%d", listenHost, listenPort, connectPort)
	}
	if proxyHost != "127.0.0.1" || proxyPort != 3128 {
		t.Fatalf("proxy defaults drifted: %s:%d", proxyHost, proxyPort)
	}
	if handshakeIdle != 10*time.Second || connectTotal != 20*time.Second {
		t.Fatalf("timeout defaults drifted: idle=%s total=%s", handshakeIdle, connectTotal)
	}
}

func TestNonPositiveTimeoutsFallBackToTheDefault(t *testing.T) {
	c := saveConfig()
	defer restoreConfig(c)
	for _, tc := range []struct{ name, idle, total string }{
		{"zero", "0", "0"},
		{"negative", "-5", "-30"},
		{"garbage", "soon", "later"},
		{"empty", "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("HANDSHAKE_IDLE_TIMEOUT", tc.idle)
			t.Setenv("CONNECT_TOTAL_TIMEOUT", tc.total)
			loadConfigFromEnv()
			// A zero idle timeout would make every tunnel instantly idle and a
			// zero total would fail every connection before the first dial.
			if handshakeIdle != 10*time.Second {
				t.Fatalf("HANDSHAKE_IDLE_TIMEOUT=%q gave %s, want the 10s default", tc.idle, handshakeIdle)
			}
			if connectTotal != 20*time.Second {
				t.Fatalf("CONNECT_TOTAL_TIMEOUT=%q gave %s, want the 20s default", tc.total, connectTotal)
			}
		})
	}
	t.Run("total-below-one-handshake", func(t *testing.T) {
		t.Setenv("HANDSHAKE_IDLE_TIMEOUT", "10")
		t.Setenv("CONNECT_TOTAL_TIMEOUT", "5")
		loadConfigFromEnv()
		want := handshakeIdle + connectTimeout
		if connectTotal != want {
			t.Fatalf("CONNECT_TOTAL_TIMEOUT=5 gave %s, want it raised to one handshake budget %s", connectTotal, want)
		}
	})
}

// --- helpers -------------------------------------------------------------

func upstreamAddrs(list []*upstream) []string {
	out := make([]string, 0, len(list))
	for _, u := range list {
		out = append(out, u.addr)
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

func FuzzParseSNINeverPanics(f *testing.F) {
	f.Add([]byte{0x16, 0x03, 0x01, 0x00, 0x00})
	f.Add([]byte{0x16, 0x03, 0x03, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00})
	f.Add([]byte("not tls"))
	f.Fuzz(func(t *testing.T, record []byte) {
		_ = parseSNI(record)
	})
}
