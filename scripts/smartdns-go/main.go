// smartdns: per-client DNS gateway with Smart-Edge synthesis.
//
// Drop-in replacement for /opt/smart-dns/server.js (Node.js) and DoH/DoT
// gateway in front of the VPN panel.
//
// Provides:
//
//	DoH (HTTP)   on :8053     — /dns-query/<client-id>[?dns=base64] (GET/POST)
//	DoT (TLS)    on :8853     — SNI: <client-id>.dns.bezrabotnyi.com
//	UDP (plain)  on :5353     — best-effort CID from `clientsByIP` lookup
//	                              keyed on the requesting source IP (router
//	                              hands out unique IPs per device). Falls back
//	                              to defaultClientId.
//	Edge auth    /edge-auth, /edge-map, /edge-auth-debug (bearer token)
//
// Smart-Edge synthesis: when route == "proxy" for a client with mode
// "non_ru_via_proxy", A queries are answered with the configured Smart-Edge
// IPv4 set instead of being forwarded upstream. The requesting IP is then
// added to the in-memory edge allow-list so that smart-edge.go can verify it.
//
// Sync: optional periodic pull of clients/policy from the panel API.
//
// Configuration is loaded once at startup from SMART_DNS_CONFIG (default
// /opt/smart-dns/config.json). A short example is shipped alongside this
// source as config.example.json.
package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultConfigPath = "/opt/smart-dns/config.json"
)

type clientCfg struct {
	ID           string `json:"clientId"`
	Enabled      bool   `json:"enabled"`
	Mode         string `json:"mode"`
	DefaultRoute string `json:"defaultRoute"`
	AccountID    string `json:"accountId"`
	Login        string `json:"login"`
}

// routingRule is the DNS projection of the panel's canonical policy row.
// GeoIP/GeoSite selectors are VPN-only and intentionally never reach SmartDNS.
type routingRule struct {
	ID         string   `json:"id"`
	Text       string   `json:"text"`
	Match      string   `json:"match"`
	Through    []string `json:"through"`
	Conditions []string `json:"conditions"`
}

type config struct {
	DefaultClientID string                `json:"defaultClientId"`
	BaseDotName     string                `json:"baseDotName"`
	DoHListen       listenCfg             `json:"dohListen"`
	DoTListen       listenCfg             `json:"dotListen"`
	UDPListen       listenCfg             `json:"udpListen"` // optional plain DNS-over-UDP (default :5353)
	PublicDNSListen listenCfg             `json:"publicDnsListen"`
	StaticA         map[string][]string   `json:"staticA"`
	StaticASuffix   map[string][]string   `json:"staticASuffix"`
	StaticAExclude  []string              `json:"staticAExclude"`
	DirectDNS       upstreamCfg           `json:"directDns"`
	HTTPProxy       upstreamCfg           `json:"httpProxy"`
	ProxyDoH        proxyDoHCfg           `json:"proxyDoh"`
	TLS             tlsCfg                `json:"tls"`
	Clients         sync.Map              `json:"-"` // local clients map; populated from local+remote
	Rules           []routingRule         `json:"rules"`
	Sync            syncCfg               `json:"sync"`
	EdgeProfiles    map[string]*smartEdge `json:"edgeProfiles"`
	// SmartEdge is deprecated during the one-shot server-44 to server-100 migration.
	SmartEdge         *smartEdge `json:"smartEdge"`
	EdgeAuth          edgeAuth   `json:"edgeAuth"`
	EdgeUDP           edgeUDP    `json:"edgeUdp"`
	DefaultRoute      string     `json:"defaultRoute"`
	LocalDefaultRoute string     `json:"localDefaultRoute"`
	HardDirect        []string   `json:"hardDirectSuffixes"`
	HardDirectDom     []string   `json:"hardDirectDomains"`
	// ClientsByIP: optional map from source IP → client id. Used by the
	// plain-DNS UDP listener to multiplex clients when no SNI/path identifier
	// is available. Most useful for OpenWRT-style routers that hand out
	// static DHCP leases and can't speak DoH/DoT.
	ClientsByIP map[string]string `json:"clientsByIP"`
}

type listenCfg struct {
	Host    string `json:"host"`
	Port    int    `json:"port"`
	Profile string `json:"profile"`
}

type upstreamCfg struct {
	Host      string `json:"host"`
	Port      int    `json:"port"`
	TimeoutMS int    `json:"timeoutMs"`
}

type proxyDoHCfg struct {
	URLHost   string `json:"urlHost"`
	Path      string `json:"path"`
	Port      int    `json:"port"`
	TimeoutMS int    `json:"timeoutMs"`
}

type tlsCfg struct {
	CertFile string `json:"certFile"`
	KeyFile  string `json:"keyFile"`
}

type syncCfg struct {
	URL       string `json:"url"`
	Token     string `json:"token"`
	Interval  int    `json:"intervalMs"`
	TimeoutMS int    `json:"timeoutMs"`
}

type smartEdge struct {
	Enabled bool     `json:"enabled"`
	IPv4    string   `json:"ipv4"`
	IPv4s   []string `json:"ipv4s"`
	TTL     int      `json:"ttl"`
}

type edgeAuth struct {
	TTLMs     int    `json:"ttlMs"`
	LogDenied bool   `json:"logDenied"`
	Token     string `json:"token"`
	// InactivityMs — for permanent allow-list entries (added manually via
	// /edge-allowlist with source "panel:*"), drop the entry if no DNS
	// traffic has been seen from this IP for this many ms. 0 = never expire
	// (permanent forever). Default 30d if unset.
	InactivityMs int `json:"inactivityMs"`
}

type edgeUDP struct {
	Enabled bool `json:"enabled"`
	Port    int  `json:"port"`
	TTLMs   int  `json:"ttlMs"`
}

func parseListen(b []byte, dst listenCfg) listenCfg {
	var lc listenCfg
	if err := json.Unmarshal(b, &lc); err == nil && lc.Port != 0 {
		return lc
	}
	return dst
}

// runtime state (mutex-protected)
type runtime struct {
	mu                 sync.RWMutex
	clients            map[string]clientCfg // remote+local
	defaultRoute       string
	localDefaultRoute  string
	directSuffixes     []string
	proxySuffixes      []string
	directDomains      map[string]bool
	proxyDomains       map[string]bool
	localProxySuffixes []string
	localProxyDomains  map[string]bool
	vusaProxySuffixes  []string
	vusaProxyDomains   map[string]bool
	hardSuffixes       []string
	hardDomains        map[string]bool
	hardDirectDoms     []string
	clientsByIP        map[string]string // LAN IP → client id (for UDP-listener lookup)
	staticA            map[string][]string
	staticASuffix      map[string][]string
	staticAExclude     map[string]bool
	synthCfg           *smartEdge
	edgeProfiles       map[string]*smartEdge
	cache              *dnsCache
	proxyResolver      *proxyDoHResolver
	policyDefault      string
	rules              []routingRule

	edgeAllowedIPs map[string]ipEntry
	edgeUDPMap     map[string]domainEntry
}

type ipEntry struct {
	Until     int64
	Source    string
	LastSeen  int64 // unix-ms; updated on every successful /edge-auth lookup
	Permanent bool  // true for manual panel entries — Until is ignored, GC runs on LastSeen+inactivity
}

type domainEntry struct {
	Until  int64
	Domain string
	Port   int
	Source string
}

func newRuntime() *runtime {
	return &runtime{
		clients:           map[string]clientCfg{},
		defaultRoute:      "direct",
		localDefaultRoute: "direct",
		directDomains:     map[string]bool{},
		proxyDomains:      map[string]bool{},
		localProxyDomains: map[string]bool{},
		vusaProxyDomains:  map[string]bool{},
		edgeProfiles:      map[string]*smartEdge{},
		cache:             newDNSCache(10000),
		hardDomains:       map[string]bool{},
		clientsByIP:       map[string]string{},
		staticA:           map[string][]string{},
		staticASuffix:     map[string][]string{},
		staticAExclude:    map[string]bool{},
		edgeAllowedIPs:    map[string]ipEntry{},
		edgeUDPMap:        map[string]domainEntry{},
	}
}

// clientByIP looks up a client-id by source IP. Falls back to
// cfg.DefaultClientID if no match. If that's also empty, returns the first
// enabled client from runtime — at least one client is guaranteed by the
// `/api/internal/smart-dns/clients` sync (every account that generated a
// smart-dns client shows up here), so this never returns "".
func (rt *runtime) clientByIP(ip string) string {
	ip = normalizeIP(ip)
	if ip == "" {
		if c := currentConfig.DefaultClientID; c != "" {
			return c
		}
		return rt.firstEnabledClient()
	}
	rt.mu.RLock()
	cid, ok := rt.clientsByIP[ip]
	rt.mu.RUnlock()
	if ok {
		return cid
	}
	if c := currentConfig.DefaultClientID; c != "" {
		return c
	}
	return rt.firstEnabledClient()
}

// firstEnabledClient returns any enabled client id from runtime — used as
// the last-resort fallback when both clientsByIP and DefaultClientID are
// empty (e.g. during bootstrap or for an unknown LAN IP).
func (rt *runtime) firstEnabledClient() string {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	for _, c := range rt.clients {
		if c.Enabled {
			return c.ID
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// config loading
// ---------------------------------------------------------------------------

func loadConfig(path string) (*config, *runtime, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", path, err)
	}

	// Two-pass: first unmarshal into a generic struct so we can split
	// "clients" (local seed map) from runtime state, then into runtime.
	var rawCfg struct {
		DefaultClientID   string                    `json:"defaultClientId"`
		BaseDotName       string                    `json:"baseDotName"`
		DoHListen         listenCfg                 `json:"dohListen"`
		DoTListen         listenCfg                 `json:"dotListen"`
		UDPListen         listenCfg                 `json:"udpListen"`
		PublicDNSListen   listenCfg                 `json:"publicDnsListen"`
		StaticA           map[string][]string       `json:"staticA"`
		StaticASuffix     map[string][]string       `json:"staticASuffix"`
		StaticAExclude    []string                  `json:"staticAExclude"`
		DirectDNS         upstreamCfg               `json:"directDns"`
		HTTPProxy         upstreamCfg               `json:"httpProxy"`
		ProxyDoH          proxyDoHCfg               `json:"proxyDoh"`
		TLS               tlsCfg                    `json:"tls"`
		Clients           map[string]map[string]any `json:"clients"`
		Sync              syncCfg                   `json:"sync"`
		EdgeProfiles      map[string]*smartEdge     `json:"edgeProfiles"`
		SmartEdge         *smartEdge                `json:"smartEdge"`
		EdgeAuth          edgeAuth                  `json:"edgeAuth"`
		EdgeUDP           edgeUDP                   `json:"edgeUdp"`
		DefaultRoute      string                    `json:"defaultRoute"`
		LocalDefaultRoute string                    `json:"localDefaultRoute"`
		HardDirectSuf     []string                  `json:"hardDirectSuffixes"`
		HardDirectDom     []string                  `json:"hardDirectDomains"`
		ClientsByIP       map[string]string         `json:"clientsByIP"`
		Rules             []routingRule             `json:"rules"`
	}
	if err := json.Unmarshal(raw, &rawCfg); err != nil {
		return nil, nil, fmt.Errorf("parse %s: %w", path, err)
	}

	cfg := &config{
		DefaultClientID:   rawCfg.DefaultClientID,
		BaseDotName:       rawCfg.BaseDotName,
		DoHListen:         rawCfg.DoHListen,
		DoTListen:         rawCfg.DoTListen,
		UDPListen:         rawCfg.UDPListen,
		PublicDNSListen:   rawCfg.PublicDNSListen,
		StaticA:           rawCfg.StaticA,
		StaticASuffix:     rawCfg.StaticASuffix,
		StaticAExclude:    rawCfg.StaticAExclude,
		DirectDNS:         rawCfg.DirectDNS,
		HTTPProxy:         rawCfg.HTTPProxy,
		ProxyDoH:          rawCfg.ProxyDoH,
		TLS:               rawCfg.TLS,
		Sync:              rawCfg.Sync,
		EdgeProfiles:      rawCfg.EdgeProfiles,
		SmartEdge:         rawCfg.SmartEdge,
		EdgeAuth:          rawCfg.EdgeAuth,
		EdgeUDP:           rawCfg.EdgeUDP,
		DefaultRoute:      rawCfg.DefaultRoute,
		LocalDefaultRoute: rawCfg.LocalDefaultRoute,
		HardDirect:        rawCfg.HardDirectSuf,
		HardDirectDom:     rawCfg.HardDirectDom,
		ClientsByIP:       rawCfg.ClientsByIP,
		Rules:             rawCfg.Rules,
	}

	if cfg.DoHListen.Port == 0 {
		cfg.DoHListen = listenCfg{Host: "0.0.0.0", Port: 8053, Profile: "public"}
	}
	if cfg.DoHListen.Profile == "" {
		cfg.DoHListen.Profile = "public"
	}
	if cfg.DoTListen.Port == 0 {
		cfg.DoTListen = listenCfg{Host: "0.0.0.0", Port: 8853, Profile: "public"}
	}
	if cfg.DoTListen.Profile == "" {
		cfg.DoTListen.Profile = "public"
	}
	// UDP listener defaults: port 5353 to avoid conflicting with whatever
	// the host might use as its own resolver (and because plain DNS on
	// port 53 requires NET_BIND_SERVICE / caps for unprivileged users).
	// Override with `udpListen: {"host":"0.0.0.0","port":53}` if running
	// as root or with CAP_NET_BIND_SERVICE.
	if cfg.UDPListen.Port == 0 && cfg.UDPListen.Host == "" {
		cfg.UDPListen = listenCfg{Host: "127.0.0.1", Port: 5353}
	}
	if cfg.UDPListen.Host == "" {
		cfg.UDPListen.Host = "127.0.0.1"
	}
	if cfg.UDPListen.Profile == "" {
		cfg.UDPListen.Profile = "local"
	}
	if cfg.PublicDNSListen.Port != 0 {
		if cfg.PublicDNSListen.Host == "" {
			cfg.PublicDNSListen.Host = "127.0.0.1"
		}
		cfg.PublicDNSListen.Profile = "public"
	}
	if cfg.DirectDNS.Host == "" {
		cfg.DirectDNS = upstreamCfg{Host: "1.1.1.1", Port: 53, TimeoutMS: 3000}
	}
	if cfg.HTTPProxy.Host == "" {
		cfg.HTTPProxy = upstreamCfg{Host: "127.0.0.1", Port: 3128, TimeoutMS: 5000}
	}
	if cfg.ProxyDoH.URLHost == "" {
		cfg.ProxyDoH = proxyDoHCfg{URLHost: "cloudflare-dns.com", Path: "/dns-query", Port: 443, TimeoutMS: 7000}
	}
	if cfg.BaseDotName == "" {
		cfg.BaseDotName = "dns.bezrabotnyi.com"
	}
	if cfg.LocalDefaultRoute == "" {
		cfg.LocalDefaultRoute = "direct"
	}

	rt := newRuntime()
	proxyResolver, err := newProxyDoHResolver(cfg.ProxyDoH, cfg.HTTPProxy)
	if err != nil {
		return nil, nil, fmt.Errorf("proxy DoH config: %w", err)
	}
	rt.proxyResolver = proxyResolver
	for profile, edge := range cfg.EdgeProfiles {
		rt.edgeProfiles[strings.ToLower(profile)] = edge
	}
	if cfg.SmartEdge != nil {
		if _, exists := rt.edgeProfiles["public"]; !exists {
			log.Printf("deprecated smartEdge config: migrate to edgeProfiles.public")
			rt.edgeProfiles["public"] = cfg.SmartEdge
		}
	}
	rt.synthCfg = rt.edgeProfiles["public"]
	rt.policyDefault = cfg.DefaultRoute
	rt.defaultRoute = cfg.DefaultRoute
	rt.localDefaultRoute = cfg.LocalDefaultRoute
	// rules are canonical. The legacy arrays below remain only until the
	// deployment renderer stops emitting them; routeFor prefers rules.
	rt.rules = cfg.Rules
	rt.hardSuffixes = toLowerSlice(cfg.HardDirect)
	if len(rt.hardSuffixes) == 0 {
		rt.hardSuffixes = []string{"github.com", "githubusercontent.com", "githubassets.com", "github.io"}
	}
	rt.hardDomains = toSetLower(cfg.HardDirectDom)
	if len(rt.hardDomains) == 0 {
		rt.hardDomains = toSetLower([]string{
			"github.com", "www.github.com", "ssh.github.com", "api.github.com",
			"gist.github.com", "raw.githubusercontent.com", "objects.githubusercontent.com",
			"github.githubassets.com",
		})
	}

	// clientsByIP: normalize keys through normalizeIP so users can write
	// "192.168.2.10" or "::ffff:192.168.2.10" etc.
	for ip, cid := range cfg.ClientsByIP {
		ip = normalizeIP(ip)
		if ip == "" || cid == "" {
			continue
		}
		rt.clientsByIP[ip] = strings.ToLower(cid)
	}
	for name, ips := range cfg.StaticA {
		valid := []string{}
		for _, ip := range ips {
			if _, ok := parseIPv4(ip); ok {
				valid = append(valid, ip)
			}
		}
		if normalized := normalizeName(name); normalized != "" && len(valid) > 0 {
			rt.staticA[normalized] = valid
		}
	}
	for suffix, ips := range cfg.StaticASuffix {
		valid := []string{}
		for _, ip := range ips {
			if _, ok := parseIPv4(ip); ok {
				valid = append(valid, ip)
			}
		}
		if normalized := normalizeName(suffix); normalized != "" && len(valid) > 0 {
			rt.staticASuffix[normalized] = valid
		}
	}
	for _, name := range cfg.StaticAExclude {
		if normalized := normalizeName(name); normalized != "" {
			rt.staticAExclude[normalized] = true
		}
	}

	// local seed clients from config.json (rare, mostly for testing)
	for cid, m := range rawCfg.Clients {
		enabled, _ := m["enabled"].(bool)
		if !enabled {
			continue
		}
		mode, _ := m["mode"].(string)
		defaultRoute, _ := m["defaultRoute"].(string)
		rt.clients[strings.ToLower(cid)] = clientCfg{
			ID:           cid,
			Enabled:      true,
			Mode:         mode,
			DefaultRoute: defaultRoute,
		}
	}

	return cfg, rt, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func toLowerSlice(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(s), "."))
	}
	return out
}

func toSetLower(in []string) map[string]bool {
	out := make(map[string]bool, len(in))
	for _, s := range in {
		out[strings.ToLower(strings.TrimSuffix(strings.TrimSpace(s), "."))] = true
	}
	return out
}

func normalizeName(s string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(s), "."))
}

func hasSuffix(name string, suffixes []string) bool {
	n := normalizeName(name)
	for _, s := range suffixes {
		if n == s || strings.HasSuffix(n, "."+s) {
			return true
		}
	}
	return false
}

func normalizeIP(ip string) string {
	s := strings.TrimSpace(ip)
	if s == "" {
		return ""
	}
	if strings.HasPrefix(s, "::ffff:") {
		s = s[7:]
	}
	if strings.Contains(s, ",") {
		s = strings.SplitN(s, ",", 2)[0]
		s = strings.TrimSpace(s)
	}
	return s
}

func requestClientIP(r *http.Request) string {
	if v := r.Header.Get("x-forwarded-for"); v != "" {
		return normalizeIP(v)
	}
	if v := r.Header.Get("x-real-ip"); v != "" {
		return normalizeIP(v)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return normalizeIP(r.RemoteAddr)
	}
	return normalizeIP(host)
}

// ---------------------------------------------------------------------------
// DNS question parsing / synthesis
// ---------------------------------------------------------------------------

type question struct {
	Name        string
	QType       uint16
	QClass      uint16
	QuestionEnd int
}

func parseQuestion(buf []byte) (*question, error) {
	if len(buf) < 12 {
		return nil, errors.New("short dns packet")
	}
	qd := binary.BigEndian.Uint16(buf[4:6])
	if qd < 1 {
		return nil, errors.New("no question")
	}
	off := 12
	labels := []string{}
	for off < len(buf) {
		l := int(buf[off])
		if l&0xc0 == 0xc0 {
			return nil, errors.New("compressed qname unsupported")
		}
		off++
		if l == 0 {
			break
		}
		if l > 63 || off+l > len(buf) {
			return nil, errors.New("bad qname")
		}
		labels = append(labels, string(buf[off:off+l]))
		off += l
	}
	if off+4 > len(buf) {
		return nil, errors.New("missing qtype")
	}
	q := &question{
		Name:        normalizeName(strings.Join(labels, ".")),
		QType:       binary.BigEndian.Uint16(buf[off : off+2]),
		QClass:      binary.BigEndian.Uint16(buf[off+2 : off+4]),
		QuestionEnd: off + 4,
	}
	return q, nil
}

func parseIPv4(s string) ([4]byte, bool) {
	var out [4]byte
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 || n > 255 {
			return out, false
		}
		out[i] = byte(n)
	}
	return out, true
}

func smartEdgeIPv4s(se *smartEdge) []string {
	if se == nil {
		return nil
	}
	if len(se.IPv4s) > 0 {
		return se.IPv4s
	}
	if se.IPv4 != "" {
		return []string{se.IPv4}
	}
	return nil
}

func setFlags(query []byte) {
	flags := binary.BigEndian.Uint16(query[2:4])
	flags = (flags | 0x8000 | 0x0080) & 0xfff0
	binary.BigEndian.PutUint16(query[2:4], flags)
	binary.BigEndian.PutUint16(query[6:8], 0) // ancount
	binary.BigEndian.PutUint16(query[8:10], 0)
	binary.BigEndian.PutUint16(query[10:12], 0)
}

func makeErrorResponse(query []byte, rcode uint8) []byte {
	out := make([]byte, len(query))
	copy(out, query)
	if len(out) >= 4 {
		flags := binary.BigEndian.Uint16(out[2:4])
		flags = (flags | 0x8000 | 0x0080) & 0xfff0
		flags |= uint16(rcode & 0xf)
		binary.BigEndian.PutUint16(out[2:4], flags)
		binary.BigEndian.PutUint16(out[6:8], 0)
		binary.BigEndian.PutUint16(out[8:10], 0)
		binary.BigEndian.PutUint16(out[10:12], 0)
	}
	return out
}

func makeNoAnswerResponse(query []byte) []byte {
	return makeErrorResponse(query, 0)
}

func makeAResponse(query []byte, q *question, ips []string, ttl uint32) []byte {
	parsed := [][4]byte{}
	for _, ip := range ips {
		if p, ok := parseIPv4(ip); ok {
			parsed = append(parsed, p)
		}
	}
	if len(parsed) == 0 {
		return makeErrorResponse(query, 2)
	}
	qEnd := q.QuestionEnd
	if qEnd > len(query) {
		qEnd = len(query)
	}
	qBuf := make([]byte, qEnd-12)
	copy(qBuf, query[12:qEnd])
	out := make([]byte, 12+len(qBuf)+len(parsed)*16)
	copy(out, query[:12])
	setFlags(out)
	binary.BigEndian.PutUint16(out[4:6], 1) // qr=1
	binary.BigEndian.PutUint16(out[6:8], uint16(len(parsed)))
	off := 12
	copy(out[off:], qBuf)
	off += len(qBuf)
	t := ttl
	if t == 0 {
		t = 60
	}
	for _, p := range parsed {
		binary.BigEndian.PutUint16(out[off:off+2], 0xc00c) // pointer to qname
		binary.BigEndian.PutUint16(out[off+2:off+4], 1)
		binary.BigEndian.PutUint16(out[off+4:off+6], 1)
		binary.BigEndian.PutUint32(out[off+6:off+10], t)
		binary.BigEndian.PutUint16(out[off+10:off+12], 4)
		copy(out[off+12:off+16], p[:])
		off += 16
	}
	return out
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

func normalizeProfile(profile string) string {
	if strings.EqualFold(profile, "local") {
		return "local"
	}
	return "public"
}

func (rt *runtime) routeFor(name string, profile string) string {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.routeForDefaultLocked(name, profile, rt.defaultRoute)
}

func (rt *runtime) routeForDefault(name string, profile string, defaultRoute string) string {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	return rt.routeForDefaultLocked(name, profile, defaultRoute)
}

func (rt *runtime) routeForDefaultLocked(name string, profile string, defaultRoute string) string {
	route, _ := rt.routeForDefaultLockedWithMatch(name, profile, defaultRoute)
	return route
}

func (rt *runtime) routeForDefaultLockedWithMatch(name string, profile string, defaultRoute string) (string, bool) {
	n := normalizeName(name)
	if rt.staticAExclude[n] {
		return "direct", true
	}
	if rt.hardDomains[n] || hasSuffix(n, rt.hardSuffixes) {
		return "direct", true
	}
	if route, matched := routeFromRules(n, normalizeProfile(profile), rt.rules); matched {
		return route, true
	}
	if rt.directDomains[n] || hasSuffix(n, rt.directSuffixes) {
		return "direct", true
	}
	if rt.localProxyDomains[n] || hasSuffix(n, rt.localProxySuffixes) {
		if normalizeProfile(profile) == "local" {
			return "proxy", true
		}
		return "direct", true
	}
	if rt.vusaProxyDomains[n] || hasSuffix(n, rt.vusaProxySuffixes) {
		if normalizeProfile(profile) == "local" {
			return "proxy", true
		}
		return "vusa-proxy", true
	}
	if rt.proxyDomains[n] || hasSuffix(n, rt.proxySuffixes) {
		return "proxy", true
	}
	if normalizeProfile(profile) == "local" {
		return rt.localDefaultRoute, false
	}
	return defaultRoute, false
}

func routeFromRules(name, profile string, rules []routingRule) (string, bool) {
	var selected *routingRule
	best := -1
	condition := "externalDns"
	if profile == "local" {
		condition = "internalDns"
	}
	for index := range rules {
		rule := &rules[index]
		if rule.Match == "set" || !contains(rule.Conditions, condition) || len(rule.Through) == 0 {
			continue
		}
		text := normalizeName(rule.Text)
		matched := rule.Match == "exact" && name == text || rule.Match == "suffix" && (name == text || strings.HasSuffix(name, "."+text))
		if !matched {
			continue
		}
		score := len(text)
		if rule.Match == "exact" {
			score += 10000
		}
		if score > best {
			selected, best = rule, score
		}
	}
	if selected == nil {
		return "", false
	}
	if selected.Through[0] == "direct" {
		return "direct", true
	}
	if profile == "public" && selected.Through[0] == "vusa" {
		return "vusa-proxy", true
	}
	return "proxy", true
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func (rt *runtime) edgeFor(profile string, route string) *smartEdge {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	if normalizeProfile(profile) == "public" && route == "vusa-proxy" {
		return rt.edgeProfiles["vusa"]
	}
	return rt.edgeProfiles[normalizeProfile(profile)]
}

// lookupClient finds the runtime client record regardless of case folding.
func (rt *runtime) lookupClient(id string) (clientCfg, bool) {
	rt.mu.RLock()
	defer rt.mu.RUnlock()
	if c, ok := rt.clients[id]; ok {
		return c, true
	}
	if c, ok := rt.clients[strings.ToLower(id)]; ok {
		return c, true
	}
	return clientCfg{}, false
}

func (rt *runtime) rememberEdgeIP(ip, source string) {
	ip = normalizeIP(ip)
	if ip == "" {
		return
	}
	ttl := int64(rt.synthCfgEEPTTL())
	if rt.EdgeAuthTTL() < 86400000 && rt.EdgeAuthTTL() > 0 {
		ttl = rt.EdgeAuthTTL()
	}
	ttl = rt.EdgeAuthTTL()
	if ttl <= 0 {
		ttl = 120000
	}
	rt.mu.Lock()
	rt.edgeAllowedIPs[ip] = ipEntry{Until: time.Now().UnixMilli() + ttl, Source: source}
	rt.mu.Unlock()
}

func (rt *runtime) EdgeAuthTTL() int64 {
	// loaded from config by main
	return edgeAuthTTLMS
}

func (rt *runtime) synthCfgEEPTTL() uint32 {
	// unused placeholder — referenced above; kept for clarity.
	if rt.synthCfg != nil && rt.synthCfg.TTL != 0 {
		return uint32(rt.synthCfg.TTL)
	}
	return 60
}

// ---------------------------------------------------------------------------
// upstream queries: direct UDP & DoH-via-proxy
// ---------------------------------------------------------------------------

func queryUDP(ctx context.Context, query []byte, server upstreamCfg) ([]byte, error) {
	if server.TimeoutMS == 0 {
		server.TimeoutMS = 3000
	}
	raddr := &net.UDPAddr{IP: net.ParseIP(server.Host), Port: server.Port}
	conn, err := net.DialUDP("udp4", nil, raddr)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(time.Duration(server.TimeoutMS) * time.Millisecond)); err != nil {
		return nil, err
	}
	if _, err := conn.Write(query); err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

func (rt *runtime) resolveClientRoute(req *question, clientID string, reqIP string, profile string) (string, bool) {
	// returns (route, didWeRouteClient)
	rt.mu.RLock()
	defaultRoute := rt.defaultRoute
	c, ok := rt.clients[strings.ToLower(clientID)]
	if ok && c.DefaultRoute != "" {
		defaultRoute = c.DefaultRoute
	}
	r, matched := rt.routeForDefaultLockedWithMatch(req.Name, profile, defaultRoute)
	rt.mu.RUnlock()
	if ok && c.Mode == "non_ru_via_proxy" && normalizeProfile(profile) == "public" && !matched && r == defaultRoute {
		r = "proxy"
	}
	return r, ok
}

// ---------------------------------------------------------------------------
// central resolver (DoH/DoT share this)
// ---------------------------------------------------------------------------

func (rt *runtime) staticAForName(name string) []string {
	name = normalizeName(name)
	if ips := rt.staticA[name]; len(ips) > 0 {
		return ips
	}
	if rt.staticAExclude[name] {
		return nil
	}
	bestLen := 0
	var best []string
	for suffix, ips := range rt.staticASuffix {
		if (name == suffix || strings.HasSuffix(name, "."+suffix)) && len(suffix) > bestLen {
			bestLen = len(suffix)
			best = ips
		}
	}
	return best
}

func (rt *runtime) resolve(query []byte, clientID, proto, reqIP, profile string) ([]byte, error) {
	q, err := parseQuestion(query)
	if err != nil {
		return makeErrorResponse(query, 1), nil
	}
	cid, ok := rt.lookupClient(clientID)
	if !ok {
		return nil, fmt.Errorf("client disabled or unknown: %s", clientID)
	}
	if ips := rt.staticAForName(q.Name); len(ips) > 0 && q.QClass == 1 {
		switch q.QType {
		case 1:
			log.Printf("%s %s static-a %s", proto, cid.ID, q.Name)
			return makeAResponse(query, q, ips, 60), nil
		case 28, 65:
			return makeNoAnswerResponse(query), nil
		}
	}
	rt.mu.RLock()
	defaultRoute := rt.defaultRoute
	if cid.DefaultRoute != "" {
		defaultRoute = cid.DefaultRoute
	}
	route, matched := rt.routeForDefaultLockedWithMatch(q.Name, profile, defaultRoute)
	rt.mu.RUnlock()
	if cid.Mode == "non_ru_via_proxy" && normalizeProfile(profile) == "public" && !matched && route == defaultRoute {
		route = "proxy"
	}
	start := time.Now()

	// Smart-edge synthesis: the VUSA-only route selects its distinct public
	// profile, while LAN keeps returning the local SNI edge.
	if se := rt.edgeFor(profile, route); se != nil && se.Enabled && (route == "proxy" || route == "vusa-proxy") && q.QClass == 1 {
		switch q.QType {
		case 1: // A
			ans := makeAResponse(query, q, smartEdgeIPv4s(se), uint32(se.TTL))
			remember := func() {}
			if normalizeProfile(profile) == "public" && reqIP != "" && q.QType == 1 {
				remember = func() {
					rt.mu.Lock()
					ttl := int64(rt.edgeTTLFromConfig())
					rt.edgeAllowedIPs[normalizeIP(reqIP)] = ipEntry{
						Until:    time.Now().UnixMilli() + ttl,
						Source:   proto + ":" + cid.ID,
						LastSeen: time.Now().UnixMilli(),
						// Permanent is intentionally false — auto-inserts
						// from smart-edge still expire via Until.
					}
					rt.edgeUDPMap[normalizeIP(reqIP)] = domainEntry{
						Until:  time.Now().UnixMilli() + ttl,
						Domain: q.Name,
						Port:   443,
						Source: proto + ":" + cid.ID,
					}
					rt.mu.Unlock()
				}
			}
			remember()
			log.Printf("%s %s %s edge %s qtype=%d %dms", proto, cid.ID, route, q.Name, q.QType, time.Since(start).Milliseconds())
			return ans, nil
		case 28, 65: // AAAA / HTTPS
			return makeNoAnswerResponse(query), nil
		}
	}

	var resp []byte
	cacheKey := dnsCacheKey(q, route, profile)
	if rt.cache != nil {
		if cached, found := rt.cache.get(cacheKey, query, time.Now()); found {
			log.Printf("%s %s %s cache %s qtype=%d", proto, cid.ID, route, q.Name, q.QType)
			return cached, nil
		}
	}
	if route == "proxy" || route == "vusa-proxy" {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		resp, err = rt.proxyResolver.query(ctx, query)
	} else {
		resp, err = queryUDP(context.Background(), query, rt.directCfg())
	}
	if err != nil {
		log.Printf("%s %s %s error %s qtype=%d %s", proto, cid.ID, route, q.Name, q.QType, err.Error())
		return makeErrorResponse(query, 2), nil
	}
	if rt.cache != nil {
		rt.cache.put(cacheKey, resp, time.Now())
	}
	log.Printf("%s %s %s resolve %s qtype=%d %dms", proto, cid.ID, route, q.Name, q.QType, time.Since(start).Milliseconds())
	return resp, nil
}

// config wrappers so resolve() can stay generic.
func (rt *runtime) directCfg() upstreamCfg {
	return currentConfig.DirectDNS
}

func (rt *runtime) edgeTTLFromConfig() int64 {
	if currentConfig.EdgeAuth.TTLMs > 0 {
		return int64(currentConfig.EdgeAuth.TTLMs)
	}
	return 120000
}

// currentConfig is package-global for ergonomic cfg access from runtime
// helpers. Set once during startup, never mutated afterwards.
var currentConfig *config

// ---------------------------------------------------------------------------
// DoH (HTTP)
// ---------------------------------------------------------------------------

type dohServer struct {
	rt        *runtime
	rt2       *config
	defaultID string
}

func (d *dohServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost &&
		r.Method != http.MethodDelete && r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	u, err := url.Parse(r.RequestURI)
	if err != nil {
		http.Error(w, "bad url", http.StatusBadRequest)
		return
	}
	// edge-auth endpoints (read-only / single-IP checks)
	if u.Path == "/edge-auth" || u.Path == "/edge-map" || u.Path == "/edge-auth-debug" {
		d.handleEdgeAPI(w, r, u)
		return
	}
	// edge-allowlist CRUD (GET / POST / DELETE) — see handleAllowListAPI
	if u.Path == "/edge-allowlist" {
		d.handleAllowListAPI(w, r)
		return
	}

	// extract client id from /dns-query/<cid> path
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 || parts[0] != "dns-query" {
		http.Error(w, "dns error", http.StatusBadRequest)
		return
	}
	clientID, err := url.PathUnescape(parts[1])
	if err != nil {
		http.Error(w, "bad client id", http.StatusBadRequest)
		return
	}

	var query []byte
	if r.Method == http.MethodGet {
		raw := u.Query().Get("dns")
		if raw == "" {
			http.Error(w, "missing dns", http.StatusBadRequest)
			return
		}
		b64 := strings.ReplaceAll(raw, "-", "+")
		b64 = strings.ReplaceAll(b64, "_", "/")
		query, err = base64.RawURLEncoding.DecodeString(raw)
		if err != nil {
			b, err2 := base64.StdEncoding.DecodeString(b64)
			if err2 != nil {
				http.Error(w, "bad dns", http.StatusBadRequest)
				return
			}
			query = b
		}
	} else {
		query, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
	}
	if len(query) < 12 || len(query) > 4096 {
		http.Error(w, "bad dns query", http.StatusBadRequest)
		return
	}
	ans, err := d.rt.resolve(query, clientID, "doh", requestClientIP(r), currentConfig.DoHListen.Profile)
	if err != nil {
		log.Printf("doh error %s: %v", clientID, err)
		http.Error(w, "client disabled or unknown", http.StatusForbidden)
		return
	}
	w.Header().Set("content-type", "application/dns-message")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(ans)
}

func (d *dohServer) handleEdgeAPI(w http.ResponseWriter, r *http.Request, u *url.URL) {
	tok := r.Header.Get("x-edge-auth-token")
	if currentConfig.EdgeAuth.Token != "" && tok != currentConfig.EdgeAuth.Token {
		http.Error(w, "", http.StatusForbidden)
		return
	}
	ip := normalizeIP(u.Query().Get("ip"))
	switch u.Path {
	case "/edge-auth":
		d.rt.mu.Lock()
		item, ok := d.rt.edgeAllowedIPs[ip]
		if ok && (item.Permanent || item.Until > time.Now().UnixMilli()) {
			item.LastSeen = time.Now().UnixMilli()
			d.rt.edgeAllowedIPs[ip] = item
			d.rt.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		d.rt.mu.Unlock()
		if !ok && currentConfig.EdgeAuth.LogDenied {
			log.Printf("edge-auth deny %s", ip)
		}
		http.Error(w, "", http.StatusForbidden)
	case "/edge-map":
		d.rt.mu.Lock()
		item, ok := d.rt.edgeUDPMap[ip]
		d.rt.mu.Unlock()
		if !ok || item.Until < time.Now().UnixMilli() {
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "ip": ip})
			return
		}
		_, allowOk := func() (any, bool) {
			d.rt.mu.Lock()
			defer d.rt.mu.Unlock()
			_, ok2 := d.rt.edgeAllowedIPs[ip]
			return nil, ok2
		}()
		if !allowOk {
			http.Error(w, "", http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":     true,
			"ip":     ip,
			"domain": item.Domain,
			"port":   item.Port,
			"until":  item.Until,
			"source": item.Source,
		})
	case "/edge-auth-debug":
		d.rt.mu.Lock()
		ips := []map[string]any{}
		for k, v := range d.rt.edgeAllowedIPs {
			ips = append(ips, map[string]any{"ip": k, "until": v.Until, "source": v.Source})
		}
		maps := []map[string]any{}
		for k, v := range d.rt.edgeUDPMap {
			maps = append(maps, map[string]any{"ip": k, "domain": v.Domain, "port": v.Port, "until": v.Until, "source": v.Source})
		}
		d.rt.mu.Unlock()
		sort.Slice(ips, func(i, j int) bool { return ips[i]["ip"].(string) < ips[j]["ip"].(string) })
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"now":     time.Now().UnixMilli(),
			"ttlMs":   currentConfig.EdgeAuth.TTLMs,
			"allowed": ips,
			"maps":    maps,
		})
	}
}

// handleAllowListAPI: CRUD for the edge-allow-list (the in-memory store
// that smart-edge.py/go consults via /edge-auth). Used by the VPN panel
// (server-100) to let a user pin their current public IP for plain-UDP
// DNS clients (routers that can't speak DoH/DoT).
//
//	GET    /edge-allowlist                  → list (with optional ?clientId=)
//	POST   /edge-allowlist                  → { ip, clientId?, ttlMs?, domain?, port? }
//	DELETE /edge-allowlist?ip=1.2.3.4        → remove entry
//
// All requests must carry `X-Edge-Auth-Token: <token>` matching
// `edgeAuth.token` in config.json.
func (d *dohServer) handleAllowListAPI(w http.ResponseWriter, r *http.Request) {
	tok := r.Header.Get("x-edge-auth-token")
	if currentConfig.EdgeAuth.Token == "" || tok != currentConfig.EdgeAuth.Token {
		http.Error(w, "", http.StatusForbidden)
		return
	}
	w.Header().Set("cache-control", "no-store")
	w.Header().Set("content-type", "application/json")

	switch r.Method {
	case http.MethodGet:
		d.rt.mu.Lock()
		ips := []map[string]any{}
		now := time.Now().UnixMilli()
		inactivityMs := effectiveInactivityMs(currentConfig.EdgeAuth.InactivityMs)
		for k, v := range d.rt.edgeAllowedIPs {
			// Skip expired non-permanent entries; permanent entries are
			// filtered by GC but still surfaced here with their lastSeen
			// so the UI can show "inactive for X days".
			if !v.Permanent && v.Until < now {
				continue
			}
			entry := map[string]any{
				"ip":        k,
				"until":     v.Until,
				"source":    v.Source,
				"lastSeen":  v.LastSeen,
				"permanent": v.Permanent,
			}
			if v.Permanent && v.LastSeen > 0 {
				entry["inactivityMs"] = inactivityMs
				entry["expiresAt"] = v.LastSeen + inactivityMs
				entry["idleMs"] = now - v.LastSeen
			}
			ips = append(ips, entry)
		}
		d.rt.mu.Unlock()
		sort.Slice(ips, func(i, j int) bool { return ips[i]["ip"].(string) < ips[j]["ip"].(string) })
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":      true,
			"now":     now,
			"ttlMs":   currentConfig.EdgeAuth.TTLMs,
			"allowed": ips,
		})

	case http.MethodPost:
		var req struct {
			IP        string `json:"ip"`
			ClientID  string `json:"clientId"`
			Domain    string `json:"domain"`
			Port      int    `json:"port"`
			TTLMs     int64  `json:"ttlMs"`
			Source    string `json:"source"`
			Permanent *bool  `json:"permanent"` // explicit override; nil = auto-detect from source
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		ip := normalizeIP(req.IP)
		if ip == "" {
			http.Error(w, "missing ip", http.StatusBadRequest)
			return
		}
		source := req.Source
		if source == "" && req.ClientID != "" {
			source = "panel:" + req.ClientID
		}
		if source == "" {
			source = "panel"
		}
		// Manual entries (panel:*) are permanent by default — Until is set to
		// 0 and inactivity (LastSeen) drives GC. Auto entries (udp:*, dot:*)
		// created by smart-edge resolve() still use TTLMs.
		permanent := req.Permanent != nil && *req.Permanent
		if req.Permanent == nil {
			permanent = strings.HasPrefix(source, "panel")
		}
		now := time.Now().UnixMilli()
		d.rt.mu.Lock()
		var until int64
		if permanent {
			until = 0
		} else {
			ttl := req.TTLMs
			if ttl <= 0 {
				ttl = int64(currentConfig.EdgeAuth.TTLMs)
			}
			if ttl <= 0 {
				ttl = 86400000
			}
			until = now + ttl
		}
		d.rt.edgeAllowedIPs[ip] = ipEntry{
			Until:     until,
			Source:    source,
			LastSeen:  now,
			Permanent: permanent,
		}
		if req.Domain != "" {
			port := req.Port
			if port == 0 {
				port = 443
			}
			d.rt.edgeUDPMap[ip] = domainEntry{
				Until:  until,
				Domain: normalizeName(req.Domain),
				Port:   port,
				Source: source,
			}
		}
		d.rt.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":        true,
			"ip":        ip,
			"until":     until,
			"permanent": permanent,
			"source":    source,
		})

	case http.MethodDelete:
		ip := normalizeIP(r.URL.Query().Get("ip"))
		if ip == "" {
			http.Error(w, "missing ip", http.StatusBadRequest)
			return
		}
		d.rt.mu.Lock()
		delete(d.rt.edgeAllowedIPs, ip)
		delete(d.rt.edgeUDPMap, ip)
		d.rt.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "ip": ip})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// ---------------------------------------------------------------------------
// DoT (TLS)
// ---------------------------------------------------------------------------

func (rt *runtime) listenDoT(cfg *config) error {
	if cfg.TLS.CertFile == "" || cfg.TLS.KeyFile == "" {
		log.Printf("DoT disabled: missing tls.certFile/tls.keyFile")
		return nil
	}
	cert, err := tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
	if err != nil {
		return fmt.Errorf("load cert: %w", err)
	}
	tlsCfg := &tls.Config{
		Certificates: []tls.Certificate{cert},
		GetCertificate: func(ch *tls.ClientHelloInfo) (*tls.Certificate, error) {
			// single cert; ignore SNI selection
			return &cert, nil
		},
	}
	addr := net.JoinHostPort(cfg.DoTListen.Host, strconv.Itoa(cfg.DoTListen.Port))
	ln, err := tls.Listen("tcp", addr, tlsCfg)
	if err != nil {
		return err
	}
	log.Printf("DoT listening %s", addr)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				log.Printf("dot accept: %v", err)
				continue
			}
			go rt.handleDoT(conn.(*tls.Conn))
		}
	}()
	return nil
}

func (rt *runtime) handleDoT(c *tls.Conn) {
	defer c.Close()
	// Force handshake to read SNI before we accept data.
	if err := c.Handshake(); err != nil {
		return
	}
	sni := c.ConnectionState().ServerName
	clientID := clientFromSNI(sni, rtBase(rt))
	_, ok := rt.lookupClient(clientID)
	if !ok {
		log.Printf("dot reject %s %s %s", c.RemoteAddr(), sni, clientID)
		c.Close()
		return
	}
	ip, _, _ := net.SplitHostPort(c.RemoteAddr().String())
	rt.rememberEdgeIP(ip, "dot:"+clientID)
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 4096)
	for {
		_ = c.SetReadDeadline(time.Now().Add(15 * time.Second))
		n, err := c.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			// parse len-prefixed query frames
			for len(buf) >= 2 {
				qlen := binary.BigEndian.Uint16(buf[:2])
				if qlen < 12 || qlen > 4096 {
					c.Close()
					return
				}
				if len(buf) < int(2+qlen) {
					break
				}
				query := make([]byte, qlen)
				copy(query, buf[2:2+qlen])
				buf = buf[2+qlen:]
				go func(q []byte) {
					ans, err := rt.resolve(q, clientID, "dot", normalizeIP(ip), currentConfig.DoTListen.Profile)
					if err != nil {
						log.Printf("dot dns error %s: %v", clientID, err)
						ans = makeErrorResponse(q, 2)
					}
					prefix := make([]byte, 2)
					binary.BigEndian.PutUint16(prefix, uint16(len(ans)))
					_ = c.SetWriteDeadline(time.Now().Add(10 * time.Second))
					_, _ = c.Write(prefix)
					_, _ = c.Write(ans)
				}(query)
			}
		}
		if err != nil {
			return
		}
	}
}

func rtBase(rt *runtime) string {
	return currentConfig.BaseDotName
}

func clientFromSNI(sni string, baseDot string) string {
	sni = normalizeName(sni)
	if sni == "" || sni == normalizeName(baseDot) {
		return currentConfig.DefaultClientID
	}
	if strings.HasSuffix(sni, "."+normalizeName(baseDot)) {
		return sni[:len(sni)-len(normalizeName(baseDot))-1]
	}
	return currentConfig.DefaultClientID
}

// ---------------------------------------------------------------------------
// policy sync
// ---------------------------------------------------------------------------

func (rt *runtime) applyRuntime(payload struct {
	OK      bool              `json:"ok"`
	Clients []clientSyncEntry `json:"clients"`
	Policy  *policySync       `json:"policy"`
}) error {
	if !payload.OK {
		return errors.New("bad sync payload")
	}
	remote := map[string]clientCfg{}
	for _, c := range payload.Clients {
		if !c.Enabled {
			continue
		}
		id := c.ID
		if id == "" {
			continue
		}
		mode := c.Mode
		if mode == "" {
			mode = "non_ru_via_proxy"
		}
		defaultRoute := c.DefaultRoute
		if defaultRoute == "" && payload.Policy != nil {
			defaultRoute = payload.Policy.DefaultRoute
		}
		if defaultRoute == "" {
			defaultRoute = "proxy"
		}
		remote[strings.ToLower(id)] = clientCfg{
			ID:           id,
			Enabled:      true,
			Mode:         mode,
			DefaultRoute: defaultRoute,
			AccountID:    c.AccountID,
			Login:        c.Login,
		}
	}
	rt.mu.Lock()
	if payload.Policy != nil {
		rt.rules = append([]routingRule(nil), payload.Policy.Rules...)
		if payload.Policy.DefaultRoute != "" {
			rt.policyDefault = payload.Policy.DefaultRoute
			rt.defaultRoute = payload.Policy.DefaultRoute
		}
		if payload.Policy.LocalDefaultRoute != "" {
			rt.localDefaultRoute = payload.Policy.LocalDefaultRoute
		}
	}
	for k, v := range rt.clients {
		if v.AccountID != "" {
			if _, ok := remote[k]; !ok {
				// The panel sync is authoritative for account-backed clients;
				// keeping absent entries would leave a revoked client routable.
				delete(rt.clients, k)
			}
		}
	}
	for k, v := range remote {
		rt.clients[k] = v
	}
	nRemote := len(remote)
	nTotal := len(rt.clients)
	rt.mu.Unlock()
	log.Printf("sync ok remote=%d total=%d", nRemote, nTotal)
	return nil
}

type clientSyncEntry struct {
	ID           string `json:"clientId"`
	Enabled      bool   `json:"enabled"`
	Mode         string `json:"mode"`
	DefaultRoute string `json:"defaultRoute"`
	AccountID    string `json:"accountId"`
	Login        string `json:"login"`
}

type policySync struct {
	Rules             []routingRule `json:"rules"`
	DefaultRoute      string        `json:"defaultRoute"`
	LocalDefaultRoute string        `json:"localDefaultRoute"`
}

func (rt *runtime) startSync(cfg *config) {
	if cfg.Sync.URL == "" {
		return
	}
	interval := time.Duration(cfg.Sync.Interval) * time.Millisecond
	if interval == 0 {
		interval = 30 * time.Second
	}
	timeout := time.Duration(cfg.Sync.TimeoutMS) * time.Millisecond
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	go func() {
		rt.runSyncOnce(cfg, timeout)
		t := time.NewTicker(interval)
		defer t.Stop()
		for range t.C {
			rt.runSyncOnce(cfg, timeout)
		}
	}()
}

func (rt *runtime) runSyncOnce(cfg *config, timeout time.Duration) {
	req, err := http.NewRequest("GET", cfg.Sync.URL, nil)
	if err != nil {
		log.Printf("sync error: %s", err.Error())
		return
	}
	req.Header.Set("accept", "application/json")
	if cfg.Sync.Token != "" {
		req.Header.Set("authorization", "Bearer "+cfg.Sync.Token)
	}
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("sync error: %s", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		log.Printf("sync error: http %d", resp.StatusCode)
		return
	}
	var payload struct {
		OK      bool              `json:"ok"`
		Clients []clientSyncEntry `json:"clients"`
		Policy  *policySync       `json:"policy"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&payload); err != nil {
		log.Printf("sync error: %s", err.Error())
		return
	}
	if err := rt.applyRuntime(payload); err != nil {
		log.Printf("sync error: %s", err.Error())
	}
}

func (rt *runtime) cleanup() {
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for now := range t.C {
			ms := now.UnixMilli()
			inactMs := effectiveInactivityMs(currentConfig.EdgeAuth.InactivityMs)
			rt.mu.Lock()
			for k, v := range rt.edgeAllowedIPs {
				if v.Permanent {
					// Permanent: skip if inactivity is disabled (<0) or
					// if the entry has never been seen / was seen recently.
					if inactMs < 0 {
						continue
					}
					if v.LastSeen > 0 && ms-v.LastSeen > inactMs {
						delete(rt.edgeAllowedIPs, k)
					}
				} else if v.Until < ms {
					delete(rt.edgeAllowedIPs, k)
				}
			}
			for k, v := range rt.edgeUDPMap {
				// UDP-map entries are tied to the IP entry; drop them when
				// either the underlying IP is removed or its map slot expired.
				ipEnt, ipExists := rt.edgeAllowedIPs[k]
				if !ipExists {
					delete(rt.edgeUDPMap, k)
					continue
				}
				if !ipEnt.Permanent && v.Until < ms {
					delete(rt.edgeUDPMap, k)
				}
			}
			rt.mu.Unlock()
		}
	}()
}

// ---------------------------------------------------------------------------
// edge auth TTl accessor shadow (used by cfg wrappers above)
// ---------------------------------------------------------------------------

var edgeAuthTTLMS int64

// effectiveInactivityMs returns the configured inactivity window for
// permanent allow-list entries, or the default (30 days) if unset/zero.
// A negative value disables inactivity expiry entirely (truly forever).
func effectiveInactivityMs(cfgVal int) int64 {
	if cfgVal == 0 {
		return int64(30 * 24 * 3600 * 1000) // 30 days
	}
	return int64(cfgVal)
}

func main() {
	cfgPath := os.Getenv("SMART_DNS_CONFIG")
	if cfgPath == "" {
		cfgPath = defaultConfigPath
	}
	cfg, rt, err := loadConfig(cfgPath)
	if err != nil {
		log.Fatalf("config error: %v", err)
	}
	currentConfig = cfg
	edgeAuthTTLMS = int64(cfg.EdgeAuth.TTLMs)
	if edgeAuthTTLMS == 0 {
		edgeAuthTTLMS = 120000
	}
	rt.synthCfg = rt.edgeProfiles["public"]

	// DoH
	dh := &dohServer{rt: rt, defaultID: cfg.DefaultClientID}
	hs := &http.Server{
		Addr:    net.JoinHostPort(cfg.DoHListen.Host, strconv.Itoa(cfg.DoHListen.Port)),
		Handler: dh,
	}
	dohListener, err := net.Listen("tcp", hs.Addr)
	if err != nil {
		log.Fatalf("doh setup error: %v", err)
	}
	go func() {
		log.Printf("DoH listening %s", hs.Addr)
		if err := hs.Serve(dohListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("doh exit: %v", err)
		}
	}()

	// DoT
	if err := rt.listenDoT(cfg); err != nil {
		log.Fatalf("dot setup error: %v", err)
	}

	// UDP (plain DNS, used by routers that can't speak DoH/DoT)
	if err := rt.listenUDP(cfg.UDPListen); err != nil {
		log.Fatalf("udp setup error: %v", err)
	}
	if err := rt.listenPlainDNSTCP(cfg.UDPListen); err != nil {
		log.Fatalf("tcp dns setup error: %v", err)
	}
	if err := rt.listenUDP(cfg.PublicDNSListen); err != nil {
		log.Fatalf("public udp setup error: %v", err)
	}
	if err := rt.listenPlainDNSTCP(cfg.PublicDNSListen); err != nil {
		log.Fatalf("public tcp dns setup error: %v", err)
	}

	// sync
	rt.startSync(cfg)
	rt.cleanup()

	log.Printf("smartdns started")
	select {}
}

// ---------------------------------------------------------------------------
// UDP (plain DNS) listener
// ---------------------------------------------------------------------------

func (rt *runtime) listenUDP(listenerCfg listenCfg) error {
	if listenerCfg.Port == 0 {
		return nil
	}
	addr := net.JoinHostPort(listenerCfg.Host, strconv.Itoa(listenerCfg.Port))
	conn, err := net.ListenPacket("udp", addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", addr, err)
	}
	profile := normalizeProfile(listenerCfg.Profile)
	log.Printf("UDP listening %s profile=%s", addr, profile)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, peer, err := conn.ReadFrom(buf)
			if err != nil {
				log.Printf("udp read error: %v", err)
				continue
			}
			if n < 12 {
				continue
			}
			query := make([]byte, n)
			copy(query, buf[:n])
			go func(query []byte, peer net.Addr) {
				peerIP, _, _ := net.SplitHostPort(peer.String())
				peerIP = normalizeIP(peerIP)
				cid := rt.clientByIP(peerIP)
				if cid == "" {
					// No client-id → fall back to default; if also
					// empty, drop the packet.
					return
				}
				ans, err := rt.resolve(query, cid, profile+"-udp", peerIP, profile)
				if err != nil {
					log.Printf("udp dns error %s: %v", cid, err)
					ans = makeErrorResponse(query, 2)
				}
				if ans == nil {
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
				if _, err := conn.WriteTo(ans, peer); err != nil {
					log.Printf("udp write error: %v", err)
				}
			}(query, peer)
		}
	}()
	return nil
}
