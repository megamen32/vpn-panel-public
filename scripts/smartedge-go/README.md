# smart-edge (Go)

Drop-in Go replacement for `vpn_diag/smart-edge.py.patched`. Reads the SNI
from the incoming TLS ClientHello and pipes the raw TCP stream to upstream
(typically port 443) on the IP that the SNI resolves to.

The stream is forwarded unchanged: the access provider can still see the real
target SNI. This can steer around DNS or destination-IP restrictions, but it
does not bypass DPI rules based on SNI or traffic shape.

## Features

| Feature | Notes |
|---|---|
| **Raw TLS passthrough** | Reads only the ClientHello, writes the rest unchanged |
| **SNI whitelist** | `.local`/`.lan`/numeric-only/oversized SNIs are dropped |
| **Per-connection goroutine** | One goroutine per inbound conn, two for the bidirectional pipe |
| **Retry on resolve/connect fail** | Up to 2 attempts with 200 ms backoff |
| **DNS cache** | Successful IPv4 lookups are cached for 60 seconds by default |
| **Bounded logging** | One aggregate `stats` line per minute; per-connection lines require `VERBOSE=1` |
| **Configurable via env** | `LISTEN_HOST`, `LISTEN_PORT`, `CONNECT_PORT`, `DNS_CACHE_TTL_SECONDS`, `STATS_INTERVAL_SECONDS`, `VERBOSE=1` |
| **Single static binary** | 3.3 MB; no Python interpreter on the edge box |

## Build

```bash
make            # → ./smart-edge (3.3 MB)
CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o smart-edge .
```

## Run

```bash
LISTEN_PORT=19443 ./smart-edge   # listens 127.0.0.1:19443
```

Default: `LISTEN_HOST=127.0.0.1 LISTEN_PORT=9443 CONNECT_PORT=443`.

## Wire-up with Nginx

```nginx
stream {
    ssl_preread on;

    upstream smart_edge_backend {
        server 127.0.0.1:9443;
    }

    server {
        listen 443 reuseport;
        ssl_preread on;
        proxy_pass $ssl_preread_server_name:$ssl_preread_server_port;
        # or, to forward every SNI to the edge:
        # proxy_pass smart_edge_backend;
    }
}
```

## Smoke test

```bash
# Terminal 1
LISTEN_PORT=19443 ./smart-edge

# Terminal 2 — proves SNI extraction + upstream dial work
curl --resolve vpn2.bezrabotnyi.com:19443:127.0.0.1 \
     https://vpn2.bezrabotnyi.com:19443/
# → real TLS handshake to 212.192.31.128:443, body from the edge
```

Verbose log output (`VERBOSE=1`):

```
2026/06/30 02:21:23 listening 127.0.0.1:19443 retries=2 connect_timeout=3s
2026/06/30 02:21:23 connect client=127.0.0.1:60610 sni=vpn2.bezrabotnyi.com upstream=212.192.31.128:443
2026/06/30 02:21:23 done    client=127.0.0.1:60610 sni=vpn2.bezrabotnyi.com up_bytes=287 down_bytes=5454
```

## Deployment status

This Go implementation is the canonical runtime installed by
`scripts/smart-edge-deploy.mjs`. The deploy builds a static binary, installs it
at `/usr/local/bin/smart-edge`, and runs it as `nobody` through the canonical
unit at `infra/smart-edge/smart-edge.service`. There is no second bundled unit
or direct Makefile deploy path. Validate the same SNI passthrough behavior after
every cutover. The TCP edge does not perform client authentication by itself;
network access control must be provided separately.
