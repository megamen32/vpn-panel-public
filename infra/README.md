# Infrastructure Index

This directory contains documentation for the new infrastructure
(vpn2, vusa, server-100, OpenWrt router) as of 2026-06-22.

## Files

- [SERVERS.md](SERVERS.md) — current state of each server (versions, hostname, services, ports)
- [PROXIES.md](PROXIES.md) — proxy chain: router haproxy → server-44/server-88/vusa
- [CERTIFICATES.md](CERTIFICATES.md) — Let's Encrypt cert setup (DNS-01 + HTTP-01)
- [RUNBOOK.md](RUNBOOK.md) — how-tos for common operations

## Quick reference

| Component | IP / DNS | Role |
|-----------|-----------|------|
| roomhacker-server-100 | 95.165.165.65 / 192.168.2.100 | Panel, OpenWrt port forward target, reg.ru API origin |
| OpenWrt router | 192.168.2.1 | HAProxy (LAN proxy), DNS hijack for `*.bezrabotnyi.com` |
| server-44 | 192.168.2.5 | sing-box 1.13.14 (HTTP+SOCKS on 3128/1080) |
| server-88 | 192.168.2.75 | Xray 26.6.1 (HTTP+SOCKS on 3128/1080) |
| vpn2 (DE) | 212.192.31.128 / vpn2.bezrabotnyi.com | Xray 26.6.1, 11 inbounds, primary VPN |
| vusa (USA) | 185.240.120.152 / vusa.bezrabotnyi.com | Xray 26.6.1, mirror of vpn2 (new, 2026-06-22) |

## Recent changes (2026-06-22)

1. **vusa (USA) provisioned**: New VPS, Xray 26.6.1, mirror of vpn2 structure
2. **DNS-01 cert flow**: Unified script `scripts/issue-vps-cert.sh` for all VPSes
3. **reg.ru DNS A record** for `vusa.bezrabotnyi.com` → 185.240.120.152
4. **Centralized config + deploy**: `scripts/deploy-all.sh` + 4 panel API endpoints
5. **Auth proxy on vpn2**: HTTP+SOCKS+TLS+basic/password auth (root/<redacted>)

## Open issues

- **OpenWrt DNS hijack** for `*.bezrabotnyi.com` (returns 95.165.165.65). Workarounds:
  - Specific entries in OpenWrt dnsmasq for non-95.165.165.65 hosts (e.g., vusa)
  - Or /etc/hosts on server-100 (current workaround for server-100 only)
- **reg.ru NS wildcard bug**: `*` records return server-100 IP for all subdomains, even
  when specific A records exist in their DB. This breaks DNS-01 cert for any non-server-100
  host; those VPSes use HTTP-01 instead (see [CERTIFICATES.md](CERTIFICATES.md)).
