package main

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestCacheCoalescesConcurrentRequests(t *testing.T) {
	c := newDNSCache(50)
	q := dnsAQuery("parallel.example", 123)
	parsed, _ := parseQuestion(q)
	key := dnsCacheKey(parsed, "direct", "local")
	var count atomic.Int32
	gate := make(chan struct{})
	started := make(chan struct{})
	lookup := func(b []byte) ([]byte, error) {
		if count.Add(1) == 1 {
			close(started)
		}
		<-gate
		return makeAResponse(b, parsed, []string{"192.0.2.3"}, 120), nil
	}
	const workers = 24
	var wg sync.WaitGroup
	wg.Add(workers)
	errors := make(chan string, workers)
	for i := 0; i < workers; i++ {
		go func(i int) {
			defer wg.Done()
			query := dnsAQuery("parallel.example", uint16(i+10))
			r, err := c.fetch(key, query, lookup)
			if err != nil || len(r) < 2 || binary.BigEndian.Uint16(r[:2]) != uint16(i+10) {
				errors <- "incorrect transaction id or upstream error"
			}
		}(i)
	}
	<-started
	time.Sleep(50 * time.Millisecond)
	close(gate)
	wg.Wait()
	close(errors)
	for failure := range errors {
		t.Fatal(failure)
	}
	if n := count.Load(); n != 1 {
		t.Fatalf("upstream calls=%d want 1", n)
	}
}

func TestCachePersistsOnlyValidAndMatchingFingerprint(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.json")
	c := newDNSCache(10)
	q := dnsAQuery("persist.example", 22)
	parsed, _ := parseQuestion(q)
	key := dnsCacheKey(parsed, "direct", "local")
	c.put(key, makeAResponse(q, parsed, []string{"192.0.2.4"}, 30), time.Now().Add(-5*time.Second))
	if err := c.saveSnapshot(path, "policy-a"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("snapshot permissions=%o", info.Mode().Perm())
	}
	restored := newDNSCache(10)
	if err = restored.loadSnapshot(path, "policy-a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := restored.get(key, q, time.Now()); !ok {
		t.Fatal("valid snapshot entry lost")
	}
	wrong := newDNSCache(10)
	if err = wrong.loadSnapshot(path, "policy-b"); err != nil {
		t.Fatal(err)
	}
	if _, ok := wrong.get(key, q, time.Now()); ok {
		t.Fatal("stale policy snapshot accepted")
	}
}

func TestCachePolicyClearDropsOldFlight(t *testing.T) {
	c := newDNSCache(10)
	q := dnsAQuery("policy.example", 22)
	parsed, _ := parseQuestion(q)
	key := dnsCacheKey(parsed, "direct", "local")
	begun := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_, _ = c.fetch(key, q, func(b []byte) ([]byte, error) {
			close(begun)
			<-release
			return makeAResponse(b, parsed, []string{"192.0.2.9"}, 90), nil
		})
	}()
	<-begun
	c.clear()
	close(release)
	<-finished
	if _, found := c.get(key, q, time.Now()); found {
		t.Fatal("response from old policy survived policy clear")
	}
}

func TestCacheLRUEvictsLeastRecentlyUsed(t *testing.T) {
	c := newDNSCache(2)
	now := time.Now()
	qs := make([][]byte, 3)
	keys := make([]string, 3)
	for i, n := range []string{"one.example", "two.example", "three.example"} {
		qs[i] = dnsAQuery(n, uint16(i+1))
		q, _ := parseQuestion(qs[i])
		keys[i] = dnsCacheKey(q, "direct", "local")
	}
	for i := 0; i < 2; i++ {
		q, _ := parseQuestion(qs[i])
		c.put(keys[i], makeAResponse(qs[i], q, []string{"192.0.2.1"}, 90), now)
	}
	c.get(keys[0], qs[0], now)
	q, _ := parseQuestion(qs[2])
	c.put(keys[2], makeAResponse(qs[2], q, []string{"192.0.2.1"}, 90), now)
	if _, ok := c.get(keys[1], qs[1], now); ok {
		t.Fatal("LRU did not evict oldest")
	}
	if _, ok := c.get(keys[0], qs[0], now); !ok {
		t.Fatal("LRU evicted popular entry")
	}
}

// RFC 2308: NXDOMAIN and NODATA are cacheable only with a SOA;
// their lifetime is min(SOA RR TTL, SOA.MINIMUM).
func TestNegativeCacheSOALifetime(t *testing.T) {
	q := dnsAQuery("missing.example", 0x10)
	for _, rcode := range []byte{0, 3} {
		response := append([]byte(nil), q...)
		response[3] = (response[3] & 0xf0) | rcode
		binary.BigEndian.PutUint16(response[6:8], 0)
		binary.BigEndian.PutUint16(response[8:10], 1)
		rr := []byte{0xc0, 0x0c, 0, 6, 0, 1, 0, 0, 0, 120, 0, 22, 0, 0}
		for i := 0; i < 5; i++ {
			rr = append(rr, 0, 0, 0, 0)
		}
		binary.BigEndian.PutUint32(rr[len(rr)-4:], 30)
		response = append(response, rr...)
		offsets, ttl, ok := responseTTLs(response)
		if !ok || ttl != 30 || len(offsets) != 1 {
			t.Fatalf("rcode=%d cacheable=%v ttl=%d offsets=%d", rcode, ok, ttl, len(offsets))
		}
		c := newDNSCache(2)
		c.put("negative", response, time.Now())
		if _, hit := c.get("negative", q, time.Now().Add(25*time.Second)); !hit {
			t.Fatal("negative cache missed too early")
		}
		if _, hit := c.get("negative", q, time.Now().Add(31*time.Second)); hit {
			t.Fatal("negative cache outlived SOA.MINIMUM")
		}
	}
}

func TestNegativeCacheDoesNotCacheBareNXDOMAIN(t *testing.T) {
	q := dnsAQuery("missing.example", 1)
	q[3] = (q[3] & 0xf0) | 3
	if _, _, ok := responseTTLs(q); ok {
		t.Fatal("NXDOMAIN without SOA must not be cached")
	}
}

func TestCacheRejectsLargeResponses(t *testing.T) {
	c := newDNSCache(2)
	c.put("oversized", make([]byte, 8193), time.Now())
	if c.stats()["entries"] != 0 {
		t.Fatal("large response cached")
	}
}
