# Mac Telegram SOCKS continuity

- Status: complete
- Original request: "сделай чтобы на маке user@100.84.94.127 был запущен всегда сокс прокси и прописан и подключен в тг. там уже есть bez наверное его надо обновить не понимаю почему вообще надо блин прокси что опять сломалось? роутер айпи не переадресует на нужное прокси? или что"
- Objective: configure only Telegram Desktop on the specified Mac to use the established remote SOCKS endpoint, without enabling Bez or a macOS-wide proxy, and identify whether the router/proxy path is the failure.
- Business canary: Telegram Desktop has established connections to the dedicated SOCKS endpoint while macOS system SOCKS and Bez remain disabled.
- Confirmed scope: Mac `user@100.84.94.127`, Telegram Desktop's own proxy configuration, and read-only router/upstream diagnostics.
- Explicit exclusions: no router/DNS/ingress policy change unless evidence shows it is required; no secret exposure; no unrelated Mac or VPN catalog changes.
- Initial active-minute estimate: minimum 12; maximum 30; started 2026-08-26 Europe/Moscow.

## Evidence

- Correction: the initial implementation mistakenly enabled global Bez. It was immediately reverted with `bez off`; it restored the previous macOS proxy settings.
- The actual intended consumer is installed and running Telegram Desktop (`/Applications/Telegram.app`), not only the Chrome Telegram Web PWA.
- Before correction, Telegram Desktop attempted direct Telegram DC connections and they remained `SYN_SENT`, which is the observed reason it did not work without VPN.
- The established dedicated proxy is SOCKS5 `192.168.2.1:1080` (router LAN HAProxy). From the Mac, SOCKS5 handshakes and a request to `api.ipify.org` returned HTTP 200; server-88 is the working upstream behind this route.
- Telegram Desktop received the SOCKS URI and its explicit `Connect Proxy` action was applied. The live process now has seven established TCP connections to `192.168.2.1:1080` and no direct Telegram DC sockets in the sampled output.
- Final boundary: macOS `SOCKSEnable` is `0`, and `bez status` is `выключен`. Only Telegram Desktop uses the proxy.
- Follow-up 2026-08-26: direct TCP from the Mac to sampled Telegram DC IPs
  (`149.154.167.41`, `149.154.167.222`, and `91.108.56.100`) times out while
  its default route is the OpenWrt router. The router retains `telegram_v4`
  with official Telegram CIDRs, but no nftables/iptables rule references that
  set. The former transparent-routing policy is therefore absent; the explicit
  Telegram Desktop SOCKS route is a working fallback, not proof of transparent
  routing. Documented the required contract and canary in both owner docs.
- Remediation 2026-08-26: ran the canonical
  `scripts/deploy-telegram-transparent-lane.sh --apply` with the explicit
  live-approval guard. It validated the Xray config before activation, created
  remote backups, enabled server-88's `telegram-transparent-policy.service`,
  and enabled/restarted router `telegram-transparent-lane` and
  `telegram-dc-failover` watchdogs. Post-deploy evidence: router
  `telegram_v4` has `References: 1`, its mangle mark/policy table 100 are
  active, server-88 TPROXY listens on `192.168.2.75:12555`, and direct Mac TCP
  connections to all three sampled Telegram DCs succeeded with Bez and the
  macOS system proxy disabled.
