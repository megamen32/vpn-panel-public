package main

import (
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func dnsAQuery(name string, id uint16) []byte {
	query := make([]byte, 12)
	binary.BigEndian.PutUint16(query[0:2], id)
	binary.BigEndian.PutUint16(query[2:4], 0x0100)
	binary.BigEndian.PutUint16(query[4:6], 1)
	for _, label := range splitLabels(name) {
		query = append(query, byte(len(label)))
		query = append(query, label...)
	}
	query = append(query, 0, 0, 1, 0, 1)
	return query
}

func splitLabels(name string) []string {
	labels := []string{}
	start := 0
	for index := 0; index <= len(name); index++ {
		if index == len(name) || name[index] == '.' {
			labels = append(labels, name[start:index])
			start = index + 1
		}
	}
	return labels
}

func firstA(t *testing.T, response []byte) string {
	t.Helper()
	if len(response) < 16 {
		t.Fatalf("short DNS response: %d", len(response))
	}
	return parseIPv4Bytes(response[len(response)-4:])
}

func parseIPv4Bytes(value []byte) string {
	return net.IP(value).String()
}

func TestLocalOnlyPolicyUsesDifferentRoutesByProfile(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "proxy"
	rt.localDefaultRoute = "direct"
	rt.localProxySuffixes = []string{"instagram.com", "cdninstagram.com"}
	rt.localProxyDomains = map[string]bool{"i.instagram.com": true}

	for _, name := range []string{"instagram.com", "reels.instagram.com", "i.instagram.com"} {
		if got := rt.routeFor(name, "local"); got != "proxy" {
			t.Fatalf("local route for %s = %s, want proxy", name, got)
		}
		if got := rt.routeFor(name, "public"); got != "direct" {
			t.Fatalf("public route for %s = %s, want direct", name, got)
		}
	}
}

func TestUASuffixUsesProxyForPublicAndLocalProfiles(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "direct"
	rt.localDefaultRoute = "direct"
	rt.proxySuffixes = []string{"ua"}

	for _, profile := range []string{"public", "local"} {
		for _, name := range []string{"ua", "example.ua"} {
			if got := rt.routeFor(name, profile); got != "proxy" {
				t.Fatalf("%s route for %s = %s, want proxy", profile, name, got)
			}
		}
	}
}

func TestListenerProfilesHaveIndependentDefaultRoutes(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "proxy"
	rt.localDefaultRoute = "direct"
	if got := rt.routeForDefault("example.com", "local", "proxy"); got != "direct" {
		t.Fatalf("local default = %s", got)
	}
	if got := rt.routeForDefault("example.com", "public", "proxy"); got != "proxy" {
		t.Fatalf("public default = %s", got)
	}
}

func TestResolveClientRouteUsesClientDefaultRoute(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "proxy"
	rt.localDefaultRoute = "direct"
	rt.clients["client"] = clientCfg{ID: "client", Enabled: true, DefaultRoute: "direct"}

	route, routed := rt.resolveClientRoute(&question{Name: "example.com"}, "client", "203.0.113.10", "public")
	if !routed {
		t.Fatal("expected enabled client to be found")
	}
	if route != "direct" {
		t.Fatalf("client public default route = %s, want direct", route)
	}
}

func TestNonRuModePreservesExplicitDirectMatches(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "direct"
	rt.localDefaultRoute = "direct"
	rt.directSuffixes = []string{"ru"}
	rt.clients["client"] = clientCfg{ID: "client", Enabled: true, Mode: "non_ru_via_proxy", DefaultRoute: "direct"}

	direct, routed := rt.resolveClientRoute(&question{Name: "ya.ru"}, "client", "192.168.2.10", "local")
	if !routed {
		t.Fatal("expected enabled client to be found")
	}
	if direct != "direct" {
		t.Fatalf("explicit Russian direct route = %s, want direct", direct)
	}

	unmatchedLocal, _ := rt.resolveClientRoute(&question{Name: "example.com"}, "client", "192.168.2.10", "local")
	if unmatchedLocal != "direct" {
		t.Fatalf("unmatched LAN route = %s, want direct", unmatchedLocal)
	}

	unmatchedPublic, _ := rt.resolveClientRoute(&question{Name: "example.com"}, "client", "203.0.113.10", "public")
	if unmatchedPublic != "proxy" {
		t.Fatalf("unmatched public route = %s, want proxy", unmatchedPublic)
	}
}

func TestResolveSelectsEdgeAddressFromListenerProfile(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "direct"
	rt.proxySuffixes = []string{"chatgpt.com"}
	rt.edgeProfiles = map[string]*smartEdge{
		"local":  {Enabled: true, IPv4s: []string{"192.168.2.75"}, TTL: 60},
		"public": {Enabled: true, IPv4s: []string{"185.240.120.152"}, TTL: 60},
	}
	rt.clients["client"] = clientCfg{ID: "client", Enabled: true}
	currentConfig = &config{EdgeAuth: edgeAuth{TTLMs: 120000}}

	query := dnsAQuery("chatgpt.com", 0x1234)
	local, err := rt.resolve(query, "client", "udp", "192.168.2.10", "local")
	if err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, local); got != "192.168.2.75" {
		t.Fatalf("local edge = %s", got)
	}

	public, err := rt.resolve(query, "client", "doh", "203.0.113.10", "public")
	if err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, public); got != "185.240.120.152" {
		t.Fatalf("public edge = %s", got)
	}
}

func TestProxyRouteFallsBackToDirectUDPAfterBothDoHFailures(t *testing.T) {
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	if err := udp.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	udpDone := make(chan error, 1)
	go func() {
		buf := make([]byte, 512)
		n, addr, err := udp.ReadFromUDP(buf)
		if err != nil {
			udpDone <- err
			return
		}
		q, err := parseQuestion(buf[:n])
		if err != nil {
			udpDone <- err
			return
		}
		_, err = udp.WriteToUDP(makeAResponse(buf[:n], q, []string{"203.0.113.9"}, 60), addr)
		udpDone <- err
	}()

	var attempts atomic.Int32
	doh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer doh.Close()
	resolver := &proxyDoHResolver{client: doh.Client(), endpoint: doh.URL}
	rt := newRuntime()
	rt.defaultRoute = "proxy"
	rt.localDefaultRoute = "proxy"
	rt.clients["client"] = clientCfg{ID: "client", Enabled: true}
	rt.proxyResolver = resolver
	rt.backupResolver = resolver
	currentConfig = &config{DirectDNS: upstreamCfg{Host: "127.0.0.1", Port: udp.LocalAddr().(*net.UDPAddr).Port, TimeoutMS: 1000}}

	answer, err := rt.resolve(dnsAQuery("example.org", 0x4848), "client", "udp", "192.168.2.10", "local")
	if err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, answer); got != "203.0.113.9" {
		t.Fatalf("fallback answer = %s", got)
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("DoH attempts = %d, want 2", got)
	}
	if err := <-udpDone; err != nil {
		t.Fatal(err)
	}
}

func TestStaticAAnswerPrecedesPublicRouting(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "proxy"
	rt.staticA = map[string][]string{
		"bezrabotnyi.com":      {"95.165.165.65"},
		"vpn2.bezrabotnyi.com": {"212.192.31.128"},
		"vusa.bezrabotnyi.com": {"185.240.120.152"},
	}
	rt.staticASuffix = map[string][]string{"bezrabotnyi.com": {"95.165.165.65"}}
	rt.staticAExclude = map[string]bool{
		"vpn2.bezrabotnyi.com": true,
		"vusa.bezrabotnyi.com": true,
	}
	rt.clients["public-open"] = clientCfg{ID: "public-open", Enabled: true}
	currentConfig = &config{EdgeAuth: edgeAuth{TTLMs: 120000}}

	response, err := rt.resolve(dnsAQuery("nginx-site.bezrabotnyi.com", 0x3344), "public-open", "public-udp", "203.0.113.10", "public")
	if err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, response); got != "95.165.165.65" {
		t.Fatalf("static public answer = %s", got)
	}
	if got := rt.staticAForName("bezrabotnyi.com"); len(got) != 1 || got[0] != "95.165.165.65" {
		t.Fatalf("zone apex static answer = %v", got)
	}
	pinned := map[string]string{
		"vpn2.bezrabotnyi.com": "212.192.31.128",
		"vusa.bezrabotnyi.com": "185.240.120.152",
	}
	queryID := uint16(0x4400)
	for excluded, expected := range pinned {
		if got := rt.staticAForName(excluded); len(got) != 1 || got[0] != expected {
			t.Fatalf("pinned host %s = %v, want %s", excluded, got, expected)
		}
		if route := rt.routeForDefault(excluded, "public", "proxy"); route != "direct" {
			t.Fatalf("excluded host %s route = %s, want direct", excluded, route)
		}
		response, err := rt.resolve(dnsAQuery(excluded, queryID), "public-open", "public-udp", "203.0.113.10", "public")
		if err != nil {
			t.Fatal(err)
		}
		if got := firstA(t, response); got != expected {
			t.Fatalf("pinned response for %s = %s, want %s", excluded, got, expected)
		}
		queryID++
	}
}

func TestAntigravityUsesVUSAForPublicAndLocalEdgeForLAN(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "direct"
	rt.vusaProxySuffixes = []string{"antigravity.google", "gweb-jetski.appspot.com"}
	rt.edgeProfiles = map[string]*smartEdge{
		"public": {Enabled: true, IPv4s: []string{"212.192.31.128"}, TTL: 60},
		"vusa":   {Enabled: true, IPv4s: []string{"185.240.120.152"}, TTL: 60},
		"local":  {Enabled: true, IPv4s: []string{"192.168.2.75"}, TTL: 60},
	}
	rt.clients["client"] = clientCfg{ID: "client", Enabled: true}
	currentConfig = &config{EdgeAuth: edgeAuth{TTLMs: 120000}}
	query := dnsAQuery("antigravity.google", 0x2468)

	public, err := rt.resolve(query, "client", "doh", "203.0.113.10", "public")
	if err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, public); got != "185.240.120.152" {
		t.Fatalf("public VUSA edge = %s", got)
	}

	local, err := rt.resolve(query, "client", "udp", "192.168.2.20", "local")
	if err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, local); got != "192.168.2.75" {
		t.Fatalf("LAN edge = %s", got)
	}
}

func TestDNSCacheRewritesTransactionIDAndAgesTTL(t *testing.T) {
	query := dnsAQuery("example.com", 0x1111)
	question, err := parseQuestion(query)
	if err != nil {
		t.Fatal(err)
	}
	response := makeAResponse(query, question, []string{"203.0.113.7"}, 60)
	cache := newDNSCache(16)
	key := dnsCacheKey(question, "direct", "public")
	now := time.Unix(1_700_000_000, 0)
	cache.put(key, response, now)

	secondQuery := dnsAQuery("example.com", 0xabcd)
	cached, ok := cache.get(key, secondQuery, now.Add(5*time.Second))
	if !ok {
		t.Fatal("expected cache hit")
	}
	if got := binary.BigEndian.Uint16(cached[0:2]); got != 0xabcd {
		t.Fatalf("transaction id = %#x", got)
	}
	if got := binary.BigEndian.Uint32(cached[len(cached)-10 : len(cached)-6]); got != 55 {
		t.Fatalf("aged TTL = %d, want 55", got)
	}
	if _, ok := cache.get(key, secondQuery, now.Add(61*time.Second)); ok {
		t.Fatal("expired response remained in cache")
	}
}

func TestProxyDoHResolverUsesPersistentHTTPTransport(t *testing.T) {
	resolver, err := newProxyDoHResolver(
		proxyDoHCfg{URLHost: "cloudflare-dns.com", Path: "/dns-query", Port: 443, TimeoutMS: 7000},
		upstreamCfg{Host: "127.0.0.1", Port: 3128, TimeoutMS: 5000},
	)
	if err != nil {
		t.Fatal(err)
	}
	transport, ok := resolver.client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport type = %T", resolver.client.Transport)
	}
	if !transport.ForceAttemptHTTP2 {
		t.Fatal("HTTP/2 is not enabled")
	}
	if transport.MaxIdleConnsPerHost < 8 {
		t.Fatalf("MaxIdleConnsPerHost = %d", transport.MaxIdleConnsPerHost)
	}
	request, err := http.NewRequest(http.MethodPost, resolver.endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	proxyURL, err := transport.Proxy(request)
	if err != nil {
		t.Fatal(err)
	}
	if proxyURL == nil || proxyURL.Host != "127.0.0.1:3128" {
		t.Fatalf("proxy URL = %v", proxyURL)
	}
}

func TestPlainDNSTCPUsesLocalListenerProfile(t *testing.T) {
	rt := newRuntime()
	rt.defaultRoute = "direct"
	rt.proxySuffixes = []string{"chatgpt.com"}
	rt.edgeProfiles = map[string]*smartEdge{
		"local": {Enabled: true, IPv4s: []string{"192.168.2.75"}, TTL: 60},
	}
	rt.clients["client"] = clientCfg{ID: "client", Enabled: true}
	currentConfig = &config{EdgeAuth: edgeAuth{TTLMs: 120000}}
	server, client := net.Pipe()
	defer client.Close()
	go rt.handlePlainDNSConn(server, "local")

	query := dnsAQuery("chatgpt.com", 0x5678)
	frame := make([]byte, 2+len(query))
	binary.BigEndian.PutUint16(frame[:2], uint16(len(query)))
	copy(frame[2:], query)
	if _, err := client.Write(frame); err != nil {
		t.Fatal(err)
	}
	length := make([]byte, 2)
	if _, err := io.ReadFull(client, length); err != nil {
		t.Fatal(err)
	}
	response := make([]byte, binary.BigEndian.Uint16(length))
	if _, err := io.ReadFull(client, response); err != nil {
		t.Fatal(err)
	}
	if got := firstA(t, response); got != "192.168.2.75" {
		t.Fatalf("TCP local edge = %s", got)
	}
}

func TestPolicySyncCanRunConcurrentlyWithRouting(t *testing.T) {
	rt := newRuntime()
	rt.rules = []routingRule{
		{Text: "ru", Match: "suffix", Through: []string{"direct"}, Conditions: []string{"externalDns", "internalDns"}},
		{Text: "chatgpt.com", Match: "suffix", Through: []string{"vpn2"}, Conditions: []string{"externalDns", "internalDns"}},
		{Text: "instagram.com", Match: "suffix", Through: []string{"vpn2"}, Conditions: []string{"internalDns"}},
	}
	payload := struct {
		OK      bool              `json:"ok"`
		Clients []clientSyncEntry `json:"clients"`
		Policy  *policySync       `json:"policy"`
	}{
		OK:      true,
		Clients: []clientSyncEntry{{ID: "client", Enabled: true, Mode: "non_ru_via_proxy"}},
		Policy: &policySync{
			DefaultRoute:      "proxy",
			LocalDefaultRoute: "direct",
			Rules: []routingRule{
				{Text: "ru", Match: "suffix", Through: []string{"direct"}, Conditions: []string{"externalDns", "internalDns"}},
				{Text: "chatgpt.com", Match: "suffix", Through: []string{"vpn2"}, Conditions: []string{"externalDns", "internalDns"}},
				{Text: "instagram.com", Match: "suffix", Through: []string{"vpn2"}, Conditions: []string{"internalDns"}},
			},
		},
	}

	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		for index := 0; index < 1000; index++ {
			_ = rt.routeForDefault("reels.instagram.com", "local", "proxy")
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < 100; index++ {
			if err := rt.applyRuntime(payload); err != nil {
				t.Errorf("applyRuntime: %v", err)
				return
			}
		}
	}()
	wait.Wait()
}

func TestPolicySyncRevokesRemovedRemoteClientsWithoutRemovingLocalClients(t *testing.T) {
	rt := newRuntime()
	rt.clients["local"] = clientCfg{ID: "local", Enabled: true}
	rt.clients["stale"] = clientCfg{ID: "stale", Enabled: true, AccountID: "account-stale"}

	payload := struct {
		OK      bool              `json:"ok"`
		Clients []clientSyncEntry `json:"clients"`
		Policy  *policySync       `json:"policy"`
	}{
		OK: true,
		Clients: []clientSyncEntry{{
			ID:        "current",
			Enabled:   true,
			AccountID: "account-current",
		}},
	}

	if err := rt.applyRuntime(payload); err != nil {
		t.Fatalf("applyRuntime: %v", err)
	}
	if _, exists := rt.clients["stale"]; exists {
		t.Fatal("removed remote client remained routable after sync")
	}
	if _, exists := rt.clients["local"]; !exists {
		t.Fatal("local-only client was removed by remote sync")
	}
	if _, exists := rt.clients["current"]; !exists {
		t.Fatal("current remote client was not installed")
	}
}

func TestRouteFromRulesUsesSpecificityAndProfileCondition(t *testing.T) {
	rules := []routingRule{
		{Text: "example.com", Match: "suffix", Through: []string{"vpn2"}, Conditions: []string{"externalDns"}},
		{Text: "api.example.com", Match: "exact", Through: []string{"direct"}, Conditions: []string{"externalDns", "internalDns"}},
		{Text: "social.example.com", Match: "suffix", Through: []string{"vusa"}, Conditions: []string{"externalDns"}},
	}
	if route, ok := routeFromRules("api.example.com", "public", rules); !ok || route != "direct" {
		t.Fatalf("exact rule should win, got %q matched=%v", route, ok)
	}
	if route, ok := routeFromRules("www.example.com", "public", rules); !ok || route != "proxy" {
		t.Fatalf("vpn2 should use proxy edge, got %q matched=%v", route, ok)
	}
	if route, ok := routeFromRules("social.example.com", "public", rules); !ok || route != "vusa-proxy" {
		t.Fatalf("vusa should use vusa edge, got %q matched=%v", route, ok)
	}
	if _, ok := routeFromRules("www.example.com", "local", rules); ok {
		t.Fatal("external-only rule must not match internal DNS")
	}
}

func writePolicyReloadConfig(t *testing.T, path string, rules []routingRule) {
	t.Helper()
	raw, err := os.ReadFile("../rootfs/etc/transparent-smart-edge/config.default.json")
	if err != nil {
		t.Fatalf("read default config: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse default config: %v", err)
	}
	doc["defaultRoute"] = "direct"
	doc["localDefaultRoute"] = "direct"
	doc["rules"] = rules
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("encode reload config: %v", err)
	}
	if err := os.WriteFile(path, encoded, 0o600); err != nil {
		t.Fatalf("write reload config: %v", err)
	}
}

func TestRuntimeReloadPolicyUpdatesRoutesWithoutDroppingRuntimeState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writePolicyReloadConfig(t, path, []routingRule{{
		ID: "quick:vpn:keenable.ai", Text: "keenable.ai", Match: "exact",
		Through: []string{"direct"}, Conditions: []string{"externalDns", "internalDns"},
	}})
	_, rt, err := loadConfig(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got := rt.routeFor("keenable.ai", "local"); got != "direct" {
		t.Fatalf("initial route = %q, want direct", got)
	}
	rt.edgeAllowedIPs["192.168.2.50"] = ipEntry{Permanent: true}

	writePolicyReloadConfig(t, path, []routingRule{{
		ID: "quick:vpn:keenable.ai", Text: "keenable.ai", Match: "exact",
		Through: []string{"vpn2"}, Conditions: []string{"externalDns", "internalDns", "vpn"},
	}})
	if err := rt.reloadPolicy(path); err != nil {
		t.Fatalf("reload policy: %v", err)
	}
	if got := rt.routeFor("keenable.ai", "local"); got != "proxy" {
		t.Fatalf("reloaded route = %q, want proxy", got)
	}
	if _, exists := rt.edgeAllowedIPs["192.168.2.50"]; !exists {
		t.Fatal("reload discarded active edge authorization state")
	}
}
