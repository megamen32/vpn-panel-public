# GPTAdmin LAN SmartDNS route repair

Status: done

Started at 2026-08-29T21:16:34+03:00 (`date`).
Estimate: 12-30 active minutes.

## Minimal path

- Wanted result: server-44 and server-88 reach the canonical GPTAdmin child endpoint with a valid TLS certificate and resume queue polling.
- Shortest real canary: repeated DNS/TLS/queue-poll probes from both real hosts show the non-VUSA route, valid certificate, and zero new `queue poll failed` events.
- Smallest YAGNI slice: remove the one stale exact OpenWrt `config domain` override for the GPTAdmin child, restart `dnsmasq` through OpenWrt with an exact backup/rollback command, then run the two-host canary.
- Discard now: VUSA TLS redesign, general DNS migration, monitor cleanup, unrelated failed units, VPN endpoint changes.

## Evidence

- Red: `dig @192.168.2.1 u-f1102930.t.gptadmin.bezrabotnyi.com A` returns `185.240.120.152` on server-44 and server-88.
- Red: that VUSA edge presents `*.t.gptadmin.bezrabotnyi.com` expired at 2026-08-28T19:53:51Z.
- Red: `shellmcp.service` logs 56 `queue poll failed` messages per five minutes on both hosts.
- Root cause: the canonical upstream already returns `194.67.71.103` and the router has the correct broad `bezrabotnyi.com -> 95.165.165.65` rule, but `dhcp.@domain[1]` overrides this exact child with stale VUSA IP `185.240.120.152` at TTL 0.
- Scope check: `dhcp.@domain[1]` is a DNS-only `config domain` entry with no MAC/lease fields; all DHCP `config host` reservations and the unrelated `BeyondInfinity.lan` domain entry remain out of scope.
- Applied: removed only the verified stale `dhcp.@domain[1]` entry, committed OpenWrt DHCP configuration, and restarted `dnsmasq`; backup is `/etc/config/dhcp.bak_gptadmin_20260829_182129`.
- Green: three consecutive rounds on real `server-44` and `roomhacker-server-88` resolved the child to `95.165.165.65`, completed HTTPS with `ssl_verify_result=0`, and reported zero new `queue poll failed` events from canary epoch `1788027776`.
- Note: HTTP `/` returned expected application-level `404`; the canary claim is DNS/TLS transport and queue-poll recovery, not a root-page route.
