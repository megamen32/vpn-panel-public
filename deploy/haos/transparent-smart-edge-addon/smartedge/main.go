// smart-edge: TLS ClientHello SNI proxy.
//
// Reads the SNI from an incoming TLS ClientHello and forwards the raw TCP
// stream through an HTTP CONNECT proxy (HAOS sing-box by default). Direct
// resolution remains available when PROXY_HOST is explicitly empty.
//
// When several HTTP proxy inbounds are reachable, PROXY_UPSTREAMS lists them
// in preference order and a connection is failed over to the next one when the
// current upstream is unusable, instead of retrying the same dead exit.
// Configured order is a static preference and is never reordered by latency:
// quarantine only takes an upstream out of rotation temporarily.
//
// Environment variables:
//
//	LISTEN_HOST   (default 127.0.0.1)
//	LISTEN_PORT   (default 9443)
//	CONNECT_PORT  (default 443)
//	PROXY_HOST    (default 127.0.0.1)
//	PROXY_PORT    (default 3128)
//	PROXY_UPSTREAMS (default empty) ordered comma separated upstreams,
//	               each host:port or label=host:port. When empty or when it
//	               yields no valid entry, PROXY_HOST:PROXY_PORT is used as the
//	               single upstream, exactly as before.
//	HANDSHAKE_IDLE_TIMEOUT (seconds, default 10) how long to wait for real
//	               forward progress on an established tunnel before declaring
//	               it a black hole and failing over to the next upstream.
//	               Must be positive.
//	CONNECT_TOTAL_TIMEOUT (seconds, default 20) deadline for the whole upstream
//	               search of one client connection, so a total outage fails fast
//	               instead of paying the per-upstream wait once per upstream.
//	               Bounds both the connect and the handshake wait of every
//	               attempt. Must be positive, and is raised to one full
//	               handshake budget when configured below that.
//	UPSTREAM_FAILURE_THRESHOLD (default 2) consecutive failures before an
//	               upstream is quarantined.
//	UPSTREAM_PROBE_FAILURE_THRESHOLD (default 3) consecutive failed liveness
//	               probes before probe loss alone may quarantine an upstream.
//	               Deliberately above the traffic threshold: two dropped
//	               probes must not take a working exit out of rotation.
//	UPSTREAM_COOLDOWN_SECONDS (default 60) initial quarantine length.
//	UPSTREAM_COOLDOWN_MAX_SECONDS (default 300) quarantine growth cap.
//	UPSTREAM_LIVENESS_ENABLED (default true) background TCP liveness prober.
//	UPSTREAM_LIVENESS_INTERVAL_SECONDS (default 15)
//	DNS_CACHE_TTL_SECONDS (default 60)
//	STATS_INTERVAL_SECONDS (default 60)
//	VERBOSE       (1 enables verbose logging)
//
// Drop-in replacement for vpn_diag/smart-edge.py.patched, but as a single
// static Go binary suitable for systemd.
package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
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
	proxyHost     = envOrAllowEmpty("PROXY_HOST", "127.0.0.1")
	proxyPort     = envInt("PROXY_PORT", 3128)
	proxyUpstream = os.Getenv("PROXY_UPSTREAMS")
	// handshakeIdle bounds how long an established tunnel may stay silent
	// before it is treated as a black hole. The upstream sing-box group is an
	// urltest selector, so a dead exit usually still answers CONNECT 200 and
	// then delivers nothing: without this the connection hangs forever.
	handshakeIdle      = envSeconds("HANDSHAKE_IDLE_TIMEOUT", 10*time.Second)
	connectTotal       = floorTotalTimeout(envSeconds("CONNECT_TOTAL_TIMEOUT", 20*time.Second), handshakeIdle)
	probeFailThreshold = envInt("UPSTREAM_PROBE_FAILURE_THRESHOLD", 3)
	failThreshold      = envInt("UPSTREAM_FAILURE_THRESHOLD", 2)
	cooldownInitial    = time.Duration(envInt("UPSTREAM_COOLDOWN_SECONDS", 60)) * time.Second
	cooldownMax        = time.Duration(envInt("UPSTREAM_COOLDOWN_MAX_SECONDS", 300)) * time.Second
	livenessEnabled    = envBool("UPSTREAM_LIVENESS_ENABLED", true)
	livenessInterval   = time.Duration(envInt("UPSTREAM_LIVENESS_INTERVAL_SECONDS", 15)) * time.Second
	dnsCacheTTL        = time.Duration(envInt("DNS_CACHE_TTL_SECONDS", 60)) * time.Second
	statsInterval      = time.Duration(envInt("STATS_INTERVAL_SECONDS", 60)) * time.Second
	verbose            = os.Getenv("VERBOSE") != ""
	resolveMu          sync.Mutex
	resolveCache       = map[string]dnsCacheEntry{}
	resolveCalls       = map[string]*dnsInflight{}
	upstreamMu         sync.Mutex
	upstreams          []*upstream
	upstreamConfigSig  = ""
	lookupIPv4         = func(ctx context.Context, host string) ([]net.IP, error) {
		return (&net.Resolver{PreferGo: true}).LookupIP(ctx, "ip4", host)
	}
	dialTCP = net.DialTimeout
	// localAddresses is captured once at init. InterfaceAddrs() failing is not
	// worth killing a working proxy over, so we degrade to refusing loopback and
	// unspecified addresses only and log why.
	localAddresses = func() []net.Addr {
		addresses, err := net.InterfaceAddrs()
		if err != nil {
			log.Printf("warning: cannot enumerate local addresses (%v); only loopback and unspecified destinations will be refused", err)
			return nil
		}
		return addresses
	}()
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
	failoverCount  int64
)

const (
	resolveTimeout  = 3 * time.Second
	connectTimeout  = 3 * time.Second
	livenessTimeout = 2 * time.Second
	idleTimeout     = 10 * time.Minute
	// handshakeProofBytes is how much real forward progress an established
	// tunnel must show before it is credited with a success. Five bytes cover
	// a TLS record header, so an exit that emits one fragment and then stalls
	// is still caught as a black hole instead of scoring a full success.
	handshakeProofBytes = 5
	maxRetries          = 2
	readHelloMax        = 8192
	clientHello         = 0x16
	blockSuffixes       = ".local .lan"
	maxDNSCacheEntries  = 4096
	// ewmaAlpha is the weight of the newest successful-connect sample.
	ewmaAlpha = 0.3
)

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// envOrAllowEmpty tells an unset variable from one explicitly set to the empty
// string. PROXY_HOST="" is the documented way to ask for direct resolution,
// so envOr's "empty means unset" rule would silently hide that whole mode.
func envOrAllowEmpty(k, def string) string {
	if v, ok := os.LookupEnv(k); ok {
		return v
	}
	return def
}

// envSeconds reads a duration expressed in seconds and rejects non-positive
// values. HANDSHAKE_IDLE_TIMEOUT=0 would make every tunnel instantly idle and
// CONNECT_TOTAL_TIMEOUT=0 would fail every connection before the first dial, so
// a non-positive value falls back to the default instead of silently disabling
// the thing it configures.
func envSeconds(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
		log.Printf("warning: %s=%q is not a positive number of seconds, using %s", k, v, def)
	}
	return def
}

// floorTotalTimeout keeps the connection-wide deadline above one full handshake
// budget, so a total that is too small cannot fail traffic that would otherwise
// have been carried.
func floorTotalTimeout(total, idle time.Duration) time.Duration {
	if floor := idle + connectTimeout; total < floor {
		log.Printf("warning: CONNECT_TOTAL_TIMEOUT %s is below one handshake budget (%s), raising it", total, floor)
		return floor
	}
	return total
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envBool(k string, def bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(k))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

// upstream is one HTTP proxy inbound plus the health state observed on it.
// Every field below the mutex is touched from handle() goroutines and from the
// liveness prober, so it is guarded.
type upstream struct {
	label string
	addr  string

	mu             sync.Mutex
	consecFails    int
	consecOKs      int
	cooldownUntil  time.Time
	cooldownCur    time.Duration
	successes      int64
	connectFails   int64
	handshakeIdles int64
	// stallBytes sums the bytes that did arrive on tunnels that stalled
	// anyway. Zero per event proves a pure black hole; one to four per event
	// points at an exit that half answers and then dies.
	stallBytes int64
	probeOK    int64
	probeFails int64
	// consecProbeFails counts failed liveness dials only. Real traffic never
	// touches it and a probe success never resets it into the traffic streak,
	// so probe loss and traffic loss stay separable.
	consecProbeFails int
	ewmaLatency      time.Duration
}

// quarantined reports whether the upstream is currently out of rotation.
func (u *upstream) quarantined(now time.Time) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return now.Before(u.cooldownUntil)
}

// cooldownLeft is the remaining quarantine, zero when the upstream is usable.
func (u *upstream) cooldownLeft(now time.Time) time.Duration {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !now.Before(u.cooldownUntil) {
		return 0
	}
	return u.cooldownUntil.Sub(now)
}

// markFailure records one observed failure and grows the quarantine when the
// streak reaches the threshold. Used by dial errors, non-2xx CONNECT replies
// and handshake idle timeouts alike, because all three mean "this exit cannot
// carry a tunnel right now".
func (u *upstream) markFailure() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.consecFails++
	u.consecOKs = 0
	if u.cooldownCur <= 0 {
		u.cooldownCur = cooldownInitial
	}
	if u.consecFails >= failThreshold {
		u.cooldownUntil = time.Now().Add(u.cooldownCur)
		if u.cooldownCur < cooldownMax {
			u.cooldownCur *= 2
			if u.cooldownCur > cooldownMax {
				u.cooldownCur = cooldownMax
			}
		}
	}
}

// adoptHealth copies the observed health of a previous incarnation of the same
// address, so reconfiguring the list does not throw away failure streaks. It
// copies field by field because the mutex itself must never be assigned.
func (u *upstream) adoptHealth(old *upstream) {
	old.mu.Lock()
	defer old.mu.Unlock()
	u.mu.Lock()
	defer u.mu.Unlock()
	u.consecFails = old.consecFails
	u.consecOKs = old.consecOKs
	u.cooldownUntil = old.cooldownUntil
	u.cooldownCur = old.cooldownCur
	u.successes = old.successes
	u.connectFails = old.connectFails
	u.handshakeIdles = old.handshakeIdles
	u.stallBytes = old.stallBytes
	u.probeOK = old.probeOK
	u.probeFails = old.probeFails
	u.consecProbeFails = old.consecProbeFails
	u.ewmaLatency = old.ewmaLatency
}

// recordConnectFailure counts a failure to obtain a usable tunnel (dial error,
// bad CONNECT response, or a failed ClientHello write).
func (u *upstream) recordConnectFailure() {
	u.mu.Lock()
	u.connectFails++
	u.mu.Unlock()
	u.markFailure()
}

// recordHandshakeIdle counts a tunnel that was established but could not prove
// it forwards anything: nothing at all, or fewer bytes than a TLS record
// header before the deadline. received is how much did arrive, which is what
// separates a black hole from a truncated exit. Kept apart from connectFails
// so the operator can tell a dead listener from a stalled tunnel.
func (u *upstream) recordHandshakeIdle(received int) {
	u.mu.Lock()
	u.handshakeIdles++
	u.stallBytes += int64(received)
	u.mu.Unlock()
	u.markFailure()
}

// recordSuccess clears the failure state at once: an upstream that just carried
// a handshake is worth trusting immediately.
func (u *upstream) recordSuccess(latency time.Duration) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.consecFails = 0
	u.consecOKs++
	u.successes++
	u.cooldownUntil = time.Time{}
	// Decay the escalation. This exit has just carried a handshake, so its next
	// bad episode starts from the base cooldown again instead of inheriting a
	// cap-length quarantine earned by an outage that is long over.
	u.cooldownCur = cooldownInitial
	if u.ewmaLatency == 0 {
		u.ewmaLatency = latency
	} else {
		u.ewmaLatency = time.Duration((1-ewmaAlpha)*float64(u.ewmaLatency) + ewmaAlpha*float64(latency))
	}
}

// recordProbeOK counts a successful liveness dial.
//
// A TCP dial only proves that something is listening on host:port. It says
// nothing about whether the CONNECT tunnel works, so it is deliberately NOT
// treated as a success for health purposes: it must never clear a failure
// streak or lift a quarantine. Only a real handshake may do that.
func (u *upstream) recordProbeOK() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.probeOK++
	// Clears the probe streak only. A reachable listener is precisely the
	// evidence the failed probe claimed was missing, so this is not the same
	// as treating the probe as a traffic success.
	u.consecProbeFails = 0
}

// recordProbeFail counts an unreachable listener. A liveness dial can be lost
// for reasons that have nothing to do with the exit carrying traffic: a busy
// box, a dropped SYN, a probe tick landing mid reconnect. Probe failures
// therefore accumulate in their own streak and only reach the shared failure
// streak once probeFailThreshold of them line up, so transient probe loss can
// never quarantine a working exit on its own.
func (u *upstream) recordProbeFail() {
	u.mu.Lock()
	u.probeFails++
	u.consecProbeFails++
	tripped := probeFailThreshold > 0 && u.consecProbeFails >= probeFailThreshold
	u.mu.Unlock()
	if tripped {
		u.markFailure()
	}
}

func (u *upstream) statsLine() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	left := time.Duration(0)
	if now := time.Now(); now.Before(u.cooldownUntil) {
		left = u.cooldownUntil.Sub(now)
	}
	label := u.label
	if label == "" {
		label = "upstream"
	}
	ewma := "n/a"
	if u.ewmaLatency > 0 {
		ewma = u.ewmaLatency.Round(time.Millisecond).String()
	}
	return fmt.Sprintf("%s=%s(ok=%d connfail=%d hsidle=%d hsidle_bytes=%d streak=%d streak_ok=%d quarantine=%s cooldown_esc=%s ewma_connect=%s probe_ok=%d probe_fail=%d probe_streak=%d)",
		label, u.addr, u.successes, u.connectFails, u.handshakeIdles, u.stallBytes,
		u.consecFails, u.consecOKs, left.Round(time.Second), u.cooldownCur.Round(time.Second), ewma,
		u.probeOK, u.probeFails, u.consecProbeFails)
}

// parseUpstreams turns the PROXY_UPSTREAMS value into upstream descriptors.
// Entries are comma separated, each either host:port or label=host:port.
// Whitespace around an entry or around a label is tolerated. Malformed entries
// are skipped with a warning instead of aborting, as long as at least one valid
// upstream survives.
func parseUpstreams(spec string) []*upstream {
	var out []*upstream
	for _, raw := range strings.Split(spec, ",") {
		entry := strings.TrimSpace(raw)
		if entry == "" {
			continue
		}
		label := ""
		if eq := strings.Index(entry, "="); eq >= 0 {
			label = strings.TrimSpace(entry[:eq])
			entry = strings.TrimSpace(entry[eq+1:])
			if label == "" {
				log.Printf("upstream warning: entry %q has an empty label, skipping", raw)
				continue
			}
		}
		host, portStr, err := net.SplitHostPort(entry)
		if err != nil || host == "" {
			log.Printf("upstream warning: entry %q is not host:port, skipping", raw)
			continue
		}
		port, err := strconv.Atoi(portStr)
		if err != nil || port < 1 || port > 65535 {
			log.Printf("upstream warning: entry %q has an invalid port, skipping", raw)
			continue
		}
		out = append(out, &upstream{label: label, addr: net.JoinHostPort(host, strconv.Itoa(port))})
	}
	return out
}

// currentUpstreams returns the ordered upstream list. It is rebuilt whenever
// the effective configuration changes, carrying over the health state of
// upstreams whose address survived the change. When PROXY_UPSTREAMS yields no
// valid entry it falls back to the single PROXY_HOST:PROXY_PORT pair, and when
// PROXY_HOST is empty the list is empty and direct resolution is used.
func currentUpstreams() []*upstream {
	sig := proxyUpstream + "\x00" + proxyHost + "\x00" + strconv.Itoa(proxyPort) +
		"\x00" + strconv.Itoa(failThreshold) + "\x00" + cooldownInitial.String() + "\x00" + cooldownMax.String()
	upstreamMu.Lock()
	defer upstreamMu.Unlock()
	if upstreams != nil && sig == upstreamConfigSig {
		return upstreams
	}
	previous := upstreams
	next := parseUpstreams(proxyUpstream)
	if len(next) == 0 {
		if proxyHost != "" && proxyPort > 0 {
			next = []*upstream{{label: "proxy", addr: net.JoinHostPort(proxyHost, strconv.Itoa(proxyPort))}}
			log.Printf("upstream: PROXY_UPSTREAMS yielded no valid entry, falling back to %s", next[0].addr)
		} else {
			next = nil
		}
	}
	for _, u := range next {
		for _, old := range previous {
			if old.addr == u.addr {
				u.adoptHealth(old)
				break
			}
		}
	}
	upstreams = next
	upstreamConfigSig = sig
	return next
}

// candidateUpstreams lists the upstreams a new connection may try, in the
// configured order with quarantined ones moved to the end. The order is a
// static preference and is never reshuffled by latency: a score that races
// lanes on speed flaps and causes exactly the churn this code avoids.
func candidateUpstreams() []*upstream {
	all := currentUpstreams()
	now := time.Now()
	var ready, cooling []*upstream
	for _, u := range all {
		if u.quarantined(now) {
			cooling = append(cooling, u)
			continue
		}
		ready = append(ready, u)
	}
	if len(ready) == 0 {
		// Everything is cooling down. Rather than fail the client outright, try
		// them all once in order: a cooled down listener that refuses a dial
		// costs almost nothing and this is the only chance a recovered exit
		// gets to prove itself.
		return all
	}
	return append(ready, cooling...)
}

// probeUpstream dials host:port and closes it immediately: no TLS, no payload.
// See recordProbeOK for why a good answer here is not a success.
func probeUpstream(u *upstream) {
	conn, err := dialTCP("tcp", u.addr, livenessTimeout)
	if err != nil {
		u.recordProbeFail()
		return
	}
	_ = conn.Close()
	u.recordProbeOK()
}

// startLivenessProber discovers a dead upstream even when traffic happens to be
// flowing through another one. A TCP dial proves only that the listener is up,
// so its result feeds the failure streak on failure and is counted for
// information only on success.
func startLivenessProber() {
	if !livenessEnabled || livenessInterval <= 0 || len(currentUpstreams()) == 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(livenessInterval)
		defer ticker.Stop()
		for range ticker.C {
			for _, u := range currentUpstreams() {
				probeUpstream(u)
			}
		}
	}()
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

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) {
	return c.reader.Read(p)
}

// prefixedConn replays bytes that were already read from the upstream before
// the pipe loop existed, then reads from the connection itself. It is used to
// hand the first upstream byte to the client without swallowing it.
type prefixedConn struct {
	net.Conn
	r io.Reader
}

func (c *prefixedConn) Read(p []byte) (int, error) {
	return c.r.Read(p)
}

// connectThroughHTTPProxy opens an RFC 7231 CONNECT tunnel through the proxy
// listening on addr while retaining bytes the proxy may have already buffered
// after its response headers.
//
// budget is what is left of the connection-wide deadline. It clamps both the
// dial and the CONNECT reply read, so a black holed upstream cannot spend more
// of the client's patience than the deadline still has.
func connectThroughHTTPProxy(addr, host string, budget time.Duration) (net.Conn, error) {
	conn, err := dialTCP("tcp", addr, shorterDuration(connectTimeout, budget))
	if err != nil {
		return nil, err
	}
	closeOnError := true
	defer func() {
		if closeOnError {
			_ = conn.Close()
		}
	}()

	target := net.JoinHostPort(host, strconv.Itoa(connectPort))
	if _, err := fmt.Fprintf(conn, "CONNECT %s HTTP/1.1\r\nHost: %s\r\nProxy-Connection: keep-alive\r\n\r\n", target, target); err != nil {
		return nil, err
	}
	_ = conn.SetReadDeadline(time.Now().Add(shorterDuration(connectTimeout, budget)))
	reader := bufio.NewReaderSize(conn, 8192)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		return nil, fmt.Errorf("proxy response: %w", err)
	}
	fields := strings.Fields(statusLine)
	if len(fields) < 2 {
		return nil, fmt.Errorf("invalid proxy response %q", strings.TrimSpace(statusLine))
	}
	status, err := strconv.Atoi(fields[1])
	if err != nil || status < 200 || status >= 300 {
		return nil, fmt.Errorf("proxy CONNECT failed: %s", strings.TrimSpace(statusLine))
	}
	total := len(statusLine)
	for {
		line, err := reader.ReadString('\n')
		total += len(line)
		if total > 8192 {
			return nil, errors.New("proxy response headers too large")
		}
		if err != nil {
			return nil, fmt.Errorf("proxy response headers: %w", err)
		}
		if line == "\r\n" || line == "\n" {
			break
		}
	}
	_ = conn.SetReadDeadline(time.Time{})
	closeOnError = false
	return &bufferedConn{Conn: conn, reader: reader}, nil
}

// awaitUpstreamForward waits for proof that the tunnel really forwards.
//
// A single byte is not proof. An exit can accept CONNECT, emit one byte of
// TLS record header and then stall forever, which a one byte wait scored as a
// full success: the quarantine was lifted and the client was left hanging on a
// one byte stream until the idle timeout. Requiring a TLS record header's worth
// of forward progress turns that case back into the black hole it is.
//
// Bytes are returned even when the wait fails, both because the caller counts a
// partial forward separately from a total black hole and because every byte of
// a healthy upstream must still reach the client as the first bytes of the
// download pipe. Discarding them on failover is safe: nothing has been written
// to the client until connectUpstream returns.
func awaitUpstreamForward(conn net.Conn, budget time.Duration) ([]byte, error) {
	wait := shorterDuration(handshakeIdle, budget)
	if err := conn.SetReadDeadline(time.Now().Add(wait)); err != nil {
		return nil, err
	}
	buf := make([]byte, handshakeProofBytes)
	n, err := io.ReadFull(conn, buf)
	if err != nil {
		return buf[:n], fmt.Errorf("no upstream forward within %s (%d/%d bytes): %w", wait, n, handshakeProofBytes, err)
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		return buf[:n], err
	}
	return buf[:n], nil
}

// shorterDuration returns whichever of the two waits is smaller.
func shorterDuration(a, b time.Duration) time.Duration {
	if b < a {
		return b
	}
	return a
}

// remainingBudget is what is left of a deadline, never negative.
func remainingBudget(deadline time.Time) time.Duration {
	if left := time.Until(deadline); left > 0 {
		return left
	}
	return 0
}

// A direct SNI destination must not return to this host's public TLS ingress.
// Otherwise nginx -> smart-edge -> nginx recirculates one ClientHello forever.
func isLocalDestination(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsUnspecified() {
		return true
	}
	for _, address := range localAddresses {
		if network, ok := address.(*net.IPNet); ok && network.IP.Equal(ip) {
			return true
		}
		if address, ok := address.(*net.IPAddr); ok && address.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// connectWithRetry dials upstream:CONNECT_PORT up to maxRetries times.
// Returns the connection, the chosen IP, and any error. This is the direct
// resolution path used when PROXY_HOST is explicitly empty.
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
		if isLocalDestination(ip) {
			return nil, "", errors.New("refusing local destination: forwarding loop")
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

// connectUpstream obtains a tunnel for host, fails over between upstreams and
// returns a connection that already yielded its first response byte, ready to
// be piped to the client.
//
// hello is replayed unchanged on every attempt. That is safe because nothing
// has been written to the client at this point: the only writer to the client
// socket is the download pipe, which starts only after this function returns,
// and a failed attempt never touches the client at all.
func connectUpstream(host string, hello []byte) (net.Conn, string, error) {
	// One deadline for the entire search. Without it the client pays the full
	// handshake wait once per upstream, so a total outage of black holes costs
	// len(candidates) * handshakeIdle before it learns anything at all.
	deadline := time.Now().Add(connectTotal)
	candidates := candidateUpstreams()
	if len(candidates) == 0 {
		conn, addr, err := connectWithRetry(host)
		if err != nil {
			return nil, "", err
		}
		// An empty ClientHello would still emit a zero length write, which on
		// an in-memory pipe blocks until someone reads it.
		if len(hello) > 0 {
			if _, err := conn.Write(hello); err != nil {
				_ = conn.Close()
				return nil, "", fmt.Errorf("upstream write failed: %w", err)
			}
		}
		first, err := awaitUpstreamForward(conn, remainingBudget(deadline))
		if err != nil {
			_ = conn.Close()
			return nil, "", err
		}
		return &prefixedConn{Conn: conn, r: io.MultiReader(bytes.NewReader(first), conn)}, addr, nil
	}

	var lastErr error
	for _, u := range candidates {
		budget := remainingBudget(deadline)
		if budget <= 0 {
			lastErr = fmt.Errorf("upstream search exceeded %s", connectTotal)
			break
		}
		started := time.Now()
		conn, err := connectThroughHTTPProxy(u.addr, host, budget)
		if err == nil && len(hello) > 0 {
			_, err = conn.Write(hello)
		}
		if err == nil {
			first, forwardErr := awaitUpstreamForward(conn, budget)
			if forwardErr == nil {
				u.recordSuccess(time.Since(started))
				return &prefixedConn{Conn: conn, r: io.MultiReader(bytes.NewReader(first), conn)}, u.addr, nil
			}
			// Too few bytes to be a real forward: exactly a black hole. Mark
			// it, drop the buffered bytes on the floor (the client has not
			// seen anything yet) and try the next upstream.
			u.recordHandshakeIdle(len(first))
			_ = conn.Close()
			err = forwardErr
			lastErr = err
			atomic.AddInt64(&failoverCount, 1)
			continue
		}
		u.recordConnectFailure()
		lastErr = err
		atomic.AddInt64(&failoverCount, 1)
	}
	if lastErr == nil {
		lastErr = errors.New("no upstream available")
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

	// Returns only once the upstream produced its first response byte, so
	// nothing has been written to client yet and a failover cannot duplicate
	// or corrupt anything the client has already seen.
	upstreamConn, upstreamAddress, err := connectUpstream(sni, hello)
	if err != nil {
		atomic.AddInt64(&errorCount, 1)
		log.Printf("error client=%s sni=%q type=%T msg=%s", peer, sni, err, err.Error())
		return
	}
	defer upstreamConn.Close()
	if verbose {
		log.Printf("connect client=%s sni=%s upstream=%s", peer, sni, upstreamAddress)
	}
	atomic.AddInt64(&proxiedCount, 1)

	var upBytes, downBytes int64
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		// client ← upstream: response direction (download). The first upstream
		// byte, already read during the handshake wait, is delivered here.
		pipe(client, upstreamConn, &downBytes)
		close(done)
	}()
	go func() {
		defer wg.Done()
		// upstream ← client: request direction (upload)
		pipe(upstreamConn, client, &upBytes)
	}()
	<-done
	upstreamConn.Close()
	client.Close()
	wg.Wait()
	if verbose {
		log.Printf("done client=%s sni=%s up_bytes=%d down_bytes=%d", peer, sni, upBytes, downBytes)
	}
}

func logStats() {
	for range time.NewTicker(statsInterval).C {
		log.Printf("stats accepted=%d proxied=%d completed=%d rejected=%d errors=%d active=%d failovers=%d dns_cache=%d",
			atomic.SwapInt64(&acceptedCount, 0),
			atomic.SwapInt64(&proxiedCount, 0),
			atomic.SwapInt64(&completedCount, 0),
			atomic.SwapInt64(&rejectedCount, 0),
			atomic.SwapInt64(&errorCount, 0),
			atomic.LoadInt64(&activeCount),
			atomic.SwapInt64(&failoverCount, 0),
			func() int { resolveMu.Lock(); defer resolveMu.Unlock(); return len(resolveCache) }())
		for _, u := range currentUpstreams() {
			log.Printf("upstream %s", u.statsLine())
		}
	}
}

// loadConfigFromEnv (re)reads the whole configuration from the environment.
// main calls it at startup; tests call it after mutating the environment so the
// documented env contract is exercised end to end instead of by poking package
// internals. There is no config file and no state file: everything is env vars
// with defaults, so the binary stays portable to a plain systemd host.
func loadConfigFromEnv() {
	listenHost = envOr("LISTEN_HOST", "127.0.0.1")
	listenPort = envInt("LISTEN_PORT", 9443)
	connectPort = envInt("CONNECT_PORT", 443)
	proxyHost = envOrAllowEmpty("PROXY_HOST", "127.0.0.1")
	proxyPort = envInt("PROXY_PORT", 3128)
	proxyUpstream = os.Getenv("PROXY_UPSTREAMS")
	handshakeIdle = envSeconds("HANDSHAKE_IDLE_TIMEOUT", 10*time.Second)
	connectTotal = floorTotalTimeout(envSeconds("CONNECT_TOTAL_TIMEOUT", 20*time.Second), handshakeIdle)
	probeFailThreshold = envInt("UPSTREAM_PROBE_FAILURE_THRESHOLD", 3)
	failThreshold = envInt("UPSTREAM_FAILURE_THRESHOLD", 2)
	cooldownInitial = time.Duration(envInt("UPSTREAM_COOLDOWN_SECONDS", 60)) * time.Second
	cooldownMax = time.Duration(envInt("UPSTREAM_COOLDOWN_MAX_SECONDS", 300)) * time.Second
	livenessEnabled = envBool("UPSTREAM_LIVENESS_ENABLED", true)
	livenessInterval = time.Duration(envInt("UPSTREAM_LIVENESS_INTERVAL_SECONDS", 15)) * time.Second
	dnsCacheTTL = time.Duration(envInt("DNS_CACHE_TTL_SECONDS", 60)) * time.Second
	statsInterval = time.Duration(envInt("STATS_INTERVAL_SECONDS", 60)) * time.Second
}

func main() {
	loadConfigFromEnv()
	addr := net.JoinHostPort(listenHost, strconv.Itoa(listenPort))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("listen %s: %v", addr, err)
	}
	descr := "direct (no HTTP proxy)"
	if ups := currentUpstreams(); len(ups) > 0 {
		parts := make([]string, 0, len(ups))
		for _, u := range ups {
			parts = append(parts, u.addr)
		}
		descr = strings.Join(parts, ",")
	}
	log.Printf("listening %s upstream=%s connect_timeout=%ds handshake_idle=%s connect_total=%s fail_threshold=%d probe_fail_threshold=%d cooldown=%s liveness=%v/%s",
		addr, descr, int(connectTimeout.Seconds()), handshakeIdle, connectTotal, failThreshold, probeFailThreshold, cooldownInitial,
		livenessEnabled, livenessInterval)
	go logStats()
	startLivenessProber()
	// TODO: health state is intentionally in-memory only, so a restart clears
	// every streak and quarantine. If an operator ever needs it to survive a
	// restart, persist it here to a path supplied by a new env var. No state
	// file is written today on purpose: this binary has no filesystem layout
	// of its own and must stay runnable under any service manager.
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
