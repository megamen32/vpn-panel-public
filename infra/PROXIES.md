# Proxies

> User-facing VPN ingress is exactly four regional Smart/Full products on
> public TCP/443. High-port and transport-specific entries below describe
> internal or diagnostic paths only.

## LAN proxies (router → server-44/server-88)

OpenWrt haproxy on 192.168.2.1, TCP load balanced:

```
192.168.2.1:3128 (HTTP)  → 192.168.2.5:3128  (server-44 sing-box)
                            192.168.2.75:3128 (server-88 Xray)
                            212.192.31.128:3128 (vpn2, down — no 3128)
                            192.168.2.101:3128 (HAOS, disabled)

192.168.2.1:1080 (SOCKS) → 192.168.2.5:1080  (server-44 sing-box SOCKS)
                            192.168.2.75:1080 (server-88 Xray SOCKS)
```

Both backends use multi-outbound with auto-balancer (leastPing via Xray observatory
/ sing-box selector default) over the panel's endpointOrder:
`de-xhttp-h2 → de-xhttp → de-direct-ws → de-grpc → de-httpupgrade → de-cdn → de-reality`

The auto-balancer picks the fastest working endpoint, so the proxy chain
automatically adapts to which transports are working.

### SOCKS UDP support

Both backends have `udp: true` enabled in their SOCKS inbounds. SOCKS5 is the
right tool for UDP — HTTP CONNECT is TCP-only.

For UDP test:
```bash
# Forward local UDP 5353 to a remote UDP target via SOCKS
socat - SOCKS5:192.168.2.75:1080:remote.example.com:53,sourceport=5353
```

## Public-facing auth proxies (root / <redacted>)

User-facing proxies for "other things" (per user request). Both use
**TLS with basic auth / password auth**.

### On vpn2 (DE)

```
auth-http  vpn2.bezrabotnyi.com:3128  HTTP+TLS+basic auth
auth-socks 212.192.31.128:1080       SOCKS5+TLS+password auth
```

### On vusa (USA)

```
auth-http  vusa.bezrabotnyi.com:3128  HTTP+TLS+basic auth
auth-socks 185.240.120.152:1080      SOCKS5+TLS+password auth
```

### Usage

```bash
# HTTP via auth-http (LE cert on both vpn2 and vusa — no --insecure needed)
curl -x https://root:<redacted>@vusa.bezrabotnyi.com:3128 https://api.ipify.org

# SOCKS via auth-socks (use Python with ssl + socks5 handshake)
python3 -c "
import socket, ssl, struct
ctx = ssl.create_default_context()  # cert verified (LE on both)
sock = ctx.wrap_socket(socket.create_connection(('vusa.bezrabotnyi.com', 1080)), server_hostname='vusa.bezrabotnyi.com')
sock.sendall(bytes([0x05, 0x02, 0x00, 0x02]))  # request password auth
assert sock.recv(2) == b'\x05\x02'
sock.sendall(bytes([0x01, 4]) + b'root' + bytes([13]) + b'<redacted>')  # 13 chars!
assert sock.recv(2) == b'\x01\x00'
host = b'ifconfig.me'
sock.sendall(bytes([0x05, 0x01, 0x00, 0x03, len(host)]) + host + struct.pack('>H', 80))
print(sock.recv(10).hex())
sock.sendall(b'GET /ip HTTP/1.1\r\nHost: ifconfig.me\r\nConnection: close\r\n\r\n')
"
```

### Cert notes

- **vpn2**: Uses LE cert (DNS-01 via reg.ru). Valid for 90 days, auto-renewed.
- **vusa**: Uses LE cert (HTTP-01 via nginx). Valid for 90 days, auto-renewed.
  DNS-01 fails for vusa due to reg.ru NS wildcard bug (see [CERTIFICATES.md](CERTIFICATES.md)).

### Why SOCKS port is bound to public IP only (212.192.31.128 / 185.240.120.152)

On both vpn2 and vusa, there's a `whitetransportd` process listening on
`127.0.0.1:1080`. The auth-socks Xray inbound can't bind to `0.0.0.0:1080`
because the kernel would reject (port already in use on 127.0.0.1).

Solution: bind the auth-socks to the public IP only (which doesn't include
127.0.0.1). This works because Linux SO_REUSEADDR only applies to the same
bind address, not different ones.

## Xray de-server outbounds (multi-outbound with balancer)

Each Xray/sing-box backend has multiple outbounds to vpn2 endpoints,
selected by an auto-balancer:

1. **de-xhttp-h2** (XHTTP stream-up H2, direct TLS, vpn2:28443) — fastest
2. **de-xhttp** (XHTTP via nginx TLS, vpn2:443 path /xhttp) — fast
3. **de-direct-ws** (WS via nginx TLS, vpn2:443 path /direct-ws) — reliable
4. **de-grpc** (gRPC via nginx TLS, vpn2:443 path /grpc) — deprecated but works
5. **de-httpupgrade** (HTTPUpgrade via nginx TLS, vpn2:443 path /hup) — deprecated
6. **de-cdn** (WS via CF DNS-only cdn.demiurge.space:443) — high latency
7. **de-reality** (VLESS Reality on vpn2:443 SNI=ya.ru) — fallback

The balancer (leastPing strategy on Xray, selector with default on sing-box)
picks the fastest. Observatory probes `gstatic.com/generate_204` every 30s.

## Adding new VPN clients

Edit the panel admin UI or update `secure.json` directly:
- Add client to `vpn_clients` table
- Add entry to `client_profiles` for the desired endpoints
- Client gets subscription URL: `https://vpn.bezrabotnyi.com/sub/<token>/{plain,v2ray,happ,xray-json}`
### UDP notes

Xray SOCKS inbounds must have `settings.udp=true`; VLESS inbounds support UDP at the protocol/client level, and server configs should keep sniffing enabled with `destOverride: ["http", "tls", "quic"]` so QUIC/UDP destinations can be recognized when possible.

sing-box 1.11 SOCKS does **not** accept an `udp` boolean field in inbound config; UDP ASSOCIATE support is not toggled with that field. For the LAN SOCKS inbound we keep `udp_fragment=true` plus `sniff=true` / `sniff_override_destination=false` where the current config schema accepts it.

HTTP proxy inbounds do not carry UDP. Use SOCKS/VLESS/WireGuard/TUN when UDP is required.
