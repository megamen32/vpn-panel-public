package main

import (
	"encoding/binary"
	"fmt"
	"sync"
	"time"
)

type dnsCacheEntry struct {
	response   []byte
	storedAt   time.Time
	expiresAt  time.Time
	ttlOffsets []int
}

// dnsCache stores positive upstream responses and rewrites per-query fields on hits.
type dnsCache struct {
	mu         sync.Mutex
	maxEntries int
	entries    map[string]dnsCacheEntry
}

// newDNSCache creates a bounded in-memory DNS response cache.
func newDNSCache(maxEntries int) *dnsCache {
	if maxEntries <= 0 {
		maxEntries = 10000
	}
	return &dnsCache{maxEntries: maxEntries, entries: make(map[string]dnsCacheEntry, maxEntries)}
}

// dnsCacheKey separates answers whose upstream route or listener profile differs.
func dnsCacheKey(question *question, route string, profile string) string {
	return fmt.Sprintf("%s\x00%s\x00%s\x00%d\x00%d", normalizeProfile(profile), route, question.Name, question.QType, question.QClass)
}

// put caches a positive response until its smallest answer TTL expires.
func (cache *dnsCache) put(key string, response []byte, now time.Time) {
	ttlOffsets, minTTL, ok := responseTTLs(response)
	if !ok || minTTL == 0 {
		return
	}
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if len(cache.entries) >= cache.maxEntries {
		cache.evictOne()
	}
	cache.entries[key] = dnsCacheEntry{
		response:   append([]byte(nil), response...),
		storedAt:   now,
		expiresAt:  now.Add(time.Duration(minTTL) * time.Second),
		ttlOffsets: ttlOffsets,
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
		return nil, false
	}
	if !now.Before(entry.expiresAt) {
		delete(cache.entries, key)
		return nil, false
	}
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

func (cache *dnsCache) evictOne() {
	var oldestKey string
	var oldestExpiry time.Time
	for key, entry := range cache.entries {
		if oldestKey == "" || entry.expiresAt.Before(oldestExpiry) {
			oldestKey = key
			oldestExpiry = entry.expiresAt
		}
	}
	if oldestKey != "" {
		delete(cache.entries, oldestKey)
	}
}

func responseTTLs(response []byte) ([]int, uint32, bool) {
	if len(response) < 12 || response[3]&0x0f != 0 {
		return nil, 0, false
	}
	questionCount := int(binary.BigEndian.Uint16(response[4:6]))
	answerCount := int(binary.BigEndian.Uint16(response[6:8]))
	authorityCount := int(binary.BigEndian.Uint16(response[8:10]))
	additionalCount := int(binary.BigEndian.Uint16(response[10:12]))
	if answerCount == 0 {
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
