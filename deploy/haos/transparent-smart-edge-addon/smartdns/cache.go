package main

import (
	"container/list"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type dnsCacheEntry struct {
	response   []byte
	storedAt   time.Time
	expiresAt  time.Time
	ttlOffsets []int
	element    *list.Element
}

// dnsCache stores positive upstream responses and rewrites per-query fields on hits.
type dnsCache struct {
	mu                                            sync.Mutex
	maxEntries                                    int
	maxBytes                                      int64
	usedBytes                                     int64
	entries                                       map[string]dnsCacheEntry
	order                                         *list.List
	flights                                       map[string]*dnsFlight
	epoch                                         uint64
	hits, misses, coalesced, refreshes, evictions atomic.Uint64
}

// dnsFlight tracks one in-flight upstream lookup so concurrent callers share it.
type dnsFlight struct {
	done     chan struct{}
	response []byte
	err      error
}

// newDNSCache creates a bounded in-memory DNS response cache.
func newDNSCache(maxEntries int) *dnsCache {
	if maxEntries <= 0 {
		maxEntries = 10000
	}
	return &dnsCache{maxEntries: maxEntries, maxBytes: 64 << 20, entries: make(map[string]dnsCacheEntry), order: list.New(), flights: make(map[string]*dnsFlight)}
}

// dnsCacheKey separates answers whose upstream route or listener profile differs.
func dnsCacheKey(question *question, route string, profile string) string {
	return fmt.Sprintf("%s\x00%s\x00%s\x00%d\x00%d", normalizeProfile(profile), route, question.Name, question.QType, question.QClass)
}

// put caches a positive response until its smallest answer TTL expires.
func (cache *dnsCache) put(key string, response []byte, now time.Time) {
	ttlOffsets, minTTL, ok := responseTTLs(response)
	if !ok || minTTL == 0 || len(response) > 8192 {
		return
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if existing, ok := cache.entries[key]; ok {
		cache.order.Remove(existing.element)
		cache.usedBytes -= int64(len(existing.response) + len(key))
	} else if len(cache.entries) >= cache.maxEntries {
		cache.evictOne()
	}
	cache.usedBytes += int64(len(response) + len(key))
	cache.entries[key] = dnsCacheEntry{
		response:   append([]byte(nil), response...),
		storedAt:   now,
		expiresAt:  now.Add(time.Duration(minTTL) * time.Second),
		ttlOffsets: ttlOffsets,
		element:    cache.order.PushFront(key),
	}
	for cache.usedBytes > cache.maxBytes {
		cache.evictOne()
	}
}

// get returns a transaction-safe response with TTLs aged from the stored value.
func (cache *dnsCache) get(key string, query []byte, now time.Time) ([]byte, bool) {
	if len(query) < 2 {
		return nil, false
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	entry, ok := cache.entries[key]
	if !ok {
		cache.misses.Add(1)
		return nil, false
	}
	if !now.Before(entry.expiresAt) {
		cache.order.Remove(entry.element)
		cache.usedBytes -= int64(len(entry.response) + len(key))
		delete(cache.entries, key)
		cache.misses.Add(1)
		return nil, false
	}
	cache.order.MoveToFront(entry.element)
	cache.hits.Add(1)
	response := append([]byte(nil), entry.response...)
	copy(response[0:2], query[0:2])
	elapsed := uint32(now.Sub(entry.storedAt) / time.Second)
	for _, offset := range entry.ttlOffsets {
		original := binary.BigEndian.Uint32(response[offset : offset+4])
		if elapsed >= original {
			binary.BigEndian.PutUint32(response[offset:offset+4], 0)
		} else {
			binary.BigEndian.PutUint32(response[offset:offset+4], original-elapsed)
		}
	}
	return response, true
}

// evictOne drops the least recently used entry.
func (cache *dnsCache) evictOne() {
	oldest := cache.order.Back()
	if oldest == nil {
		return
	}
	oldKey := oldest.Value.(string)
	cache.usedBytes -= int64(len(cache.entries[oldKey].response) + len(oldKey))
	delete(cache.entries, oldKey)
	cache.order.Remove(oldest)
	cache.evictions.Add(1)
}

// rebindDNSID copies a shared response and rewrites the transaction ID for this caller.
func rebindDNSID(response, query []byte) []byte {
	if len(response) < 2 || len(query) < 2 {
		return response
	}
	result := append([]byte(nil), response...)
	copy(result[:2], query[:2])
	return result
}

// fetch serves a cached response or runs one coalesced upstream lookup.
func (cache *dnsCache) fetch(key string, query []byte, lookup func([]byte) ([]byte, error)) ([]byte, error) {
	now := time.Now()
	if response, ok := cache.get(key, query, now); ok {
		cache.mu.Lock()
		entry, found := cache.entries[key]
		refresh := found && entry.expiresAt.Sub(now) < entry.expiresAt.Sub(entry.storedAt)/5 && entry.expiresAt.Sub(now) < 30*time.Second
		_, busy := cache.flights[key]
		cache.mu.Unlock()
		if refresh && !busy {
			cache.refreshes.Add(1)
			go func() { _, _ = cache.fetchFresh(key, append([]byte(nil), query...), lookup) }()
		}
		return response, nil
	}
	return cache.fetchFresh(key, query, lookup)
}

// fetchFresh performs the upstream lookup, joining an in-flight one when present.
func (cache *dnsCache) fetchFresh(key string, query []byte, lookup func([]byte) ([]byte, error)) ([]byte, error) {
	cache.mu.Lock()
	if flight, exists := cache.flights[key]; exists {
		cache.coalesced.Add(1)
		cache.mu.Unlock()
		<-flight.done
		return rebindDNSID(flight.response, query), flight.err
	}
	epoch := cache.epoch
	flight := &dnsFlight{done: make(chan struct{})}
	cache.flights[key] = flight
	cache.mu.Unlock()
	defer func() { cache.mu.Lock(); delete(cache.flights, key); close(flight.done); cache.mu.Unlock() }()
	flight.response, flight.err = lookup(query)
	cache.mu.Lock()
	valid := cache.epoch == epoch
	cache.mu.Unlock()
	if flight.err == nil && valid {
		cache.put(key, flight.response, time.Now())
	}
	return rebindDNSID(flight.response, query), flight.err
}

// stats reports cache counters for periodic logging.
func (cache *dnsCache) stats() map[string]uint64 {
	cache.mu.Lock()
	count := uint64(len(cache.entries))
	inflight := uint64(len(cache.flights))
	bytes := uint64(cache.usedBytes)
	cache.mu.Unlock()
	return map[string]uint64{"entries": count, "bytes": bytes, "inflight": inflight, "hits": cache.hits.Load(), "misses": cache.misses.Load(), "coalesced": cache.coalesced.Load(), "refreshes": cache.refreshes.Load(), "evictions": cache.evictions.Load()}
}

// clear drops every entry and invalidates in-flight responses from older policy.
func (cache *dnsCache) clear() {
	cache.mu.Lock()
	cache.entries = make(map[string]dnsCacheEntry)
	cache.usedBytes = 0
	cache.epoch++
	cache.order.Init()
	cache.mu.Unlock()
}

func responseTTLs(response []byte) ([]int, uint32, bool) {
	if len(response) < 12 || (response[3]&0x0f != 0 && response[3]&0x0f != 3) {
		return nil, 0, false
	}
	questionCount := int(binary.BigEndian.Uint16(response[4:6]))
	answerCount := int(binary.BigEndian.Uint16(response[6:8]))
	authorityCount := int(binary.BigEndian.Uint16(response[8:10]))
	additionalCount := int(binary.BigEndian.Uint16(response[10:12]))
	if answerCount == 0 && authorityCount == 0 {
		return nil, 0, false
	}
	offset := 12
	for index := 0; index < questionCount; index++ {
		var ok bool
		offset, ok = skipDNSName(response, offset)
		if !ok || offset+4 > len(response) {
			return nil, 0, false
		}
		offset += 4
	}
	ttlOffsets := make([]int, 0, answerCount+authorityCount+additionalCount)
	minTTL := ^uint32(0)
	recordCount := answerCount + authorityCount + additionalCount
	for index := 0; index < recordCount; index++ {
		var ok bool
		offset, ok = skipDNSName(response, offset)
		if !ok || offset+10 > len(response) {
			return nil, 0, false
		}
		recordType := binary.BigEndian.Uint16(response[offset : offset+2])
		ttlOffset := offset + 4
		ttl := binary.BigEndian.Uint32(response[ttlOffset : ttlOffset+4])
		dataLength := int(binary.BigEndian.Uint16(response[offset+8 : offset+10]))
		offset += 10
		if offset+dataLength > len(response) {
			return nil, 0, false
		}
		if recordType != 41 {
			ttlOffsets = append(ttlOffsets, ttlOffset)
			if index < answerCount && ttl < minTTL {
				minTTL = ttl
			}
			if answerCount == 0 && index < answerCount+authorityCount && recordType == 6 && dataLength >= 20 {
				neg := binary.BigEndian.Uint32(response[offset+dataLength-4 : offset+dataLength])
				if ttl < neg {
					neg = ttl
				}
				if neg < minTTL {
					minTTL = neg
				}
			}
		}
		offset += dataLength
	}
	if minTTL == ^uint32(0) {
		return nil, 0, false
	}
	return ttlOffsets, minTTL, true
}

func skipDNSName(message []byte, offset int) (int, bool) {
	for {
		if offset >= len(message) {
			return 0, false
		}
		length := int(message[offset])
		if length&0xc0 == 0xc0 {
			if offset+2 > len(message) {
				return 0, false
			}
			return offset + 2, true
		}
		if length == 0 {
			return offset + 1, true
		}
		if length > 63 || offset+1+length > len(message) {
			return 0, false
		}
		offset += 1 + length
	}
}

// Cache snapshots contain DNS responses only (never proxy credentials).
// Wall-clock expiry prevents extending TTLs across restart.
type cacheSnapshot struct {
	Version     int                        `json:"version"`
	Fingerprint string                     `json:"fingerprint"`
	Records     map[string]cacheDiskRecord `json:"records"`
}

type cacheDiskRecord struct {
	Reply     []byte `json:"reply"`
	StoredAt  int64  `json:"stored_at"`
	ExpiresAt int64  `json:"expires_at"`
}

// saveSnapshot writes live entries to disk atomically with restrictive permissions.
func (cache *dnsCache) saveSnapshot(path, fingerprint string) error {
	if path == "" {
		return nil
	}
	now := time.Now()
	snap := cacheSnapshot{Version: 1, Fingerprint: fingerprint, Records: make(map[string]cacheDiskRecord)}
	cache.mu.Lock()
	for key, e := range cache.entries {
		if now.Before(e.expiresAt) {
			snap.Records[key] = cacheDiskRecord{e.response, e.storedAt.UnixNano(), e.expiresAt.UnixNano()}
		}
	}
	cache.mu.Unlock()
	blob, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".smartdns-cache-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(0600); err != nil {
		return err
	}
	if _, err = f.Write(blob); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

// loadSnapshot restores entries persisted for the same configuration fingerprint.
func (cache *dnsCache) loadSnapshot(path, fingerprint string) error {
	if path == "" {
		return nil
	}
	blob, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var snap cacheSnapshot
	if err = json.Unmarshal(blob, &snap); err != nil {
		return err
	}
	if snap.Version != 1 || snap.Fingerprint != fingerprint {
		return nil
	}
	now := time.Now()
	for key, record := range snap.Records {
		if now.Before(time.Unix(0, record.ExpiresAt)) && time.Unix(0, record.StoredAt).Before(now) {
			cache.put(key, record.Reply, time.Unix(0, record.StoredAt))
		}
	}
	return nil
}
