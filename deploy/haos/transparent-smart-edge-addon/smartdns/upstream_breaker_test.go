package main

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

type brokenDoHRoundTripper struct{ calls atomic.Int32 }

func (rt *brokenDoHRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	rt.calls.Add(1)
	return nil, errors.New("unexpected EOF")
}

func TestDoHBreakerOpensAfterThreeFailures(t *testing.T) {
	rt := &brokenDoHRoundTripper{}
	r := &proxyDoHResolver{client: &http.Client{Transport: rt}, endpoint: "https://example.org/dns-query"}
	for i := 0; i < 3; i++ {
		if _, err := r.query(context.Background(), []byte{1, 2, 3}); err == nil {
			t.Fatal("failure expected")
		}
	}
	start := time.Now()
	if _, err := r.query(context.Background(), []byte{1, 2, 3}); err == nil {
		t.Fatal("breaker should reject")
	}
	if rt.calls.Load() != 3 {
		t.Fatalf("backend calls=%d, expected 3", rt.calls.Load())
	}
	if time.Since(start) > 100*time.Millisecond {
		t.Fatal("open breaker delayed fallback")
	}
	r.breakerMu.Lock()
	r.retryAfter = time.Now().Add(-time.Second)
	r.breakerMu.Unlock()
	_, _ = r.query(context.Background(), []byte{1, 2, 3})
	if rt.calls.Load() != 4 {
		t.Fatal("breaker did not retry after cooldown")
	}
}
