# Telegram Mac and TGB recovery

Status: complete

Started at 2026-09-01T19:52:53+03:00 (manual clock)
Estimate: minimum 35 / maximum 70 active minutes

Wanted result: Telegram Desktop works on the Mac with Bez and macOS system proxy off through HAOS; `https://tgb.bezrabotnyi.com/` recovery remains a separate server-88 service incident.

Shortest real canary: Mac TCP/443 connections to Telegram DCs succeed with the stated proxy settings, and OpenWrt counters demonstrate diversion to HAOS.

Smallest YAGNI slice: configure the active HAOS Smart Edge sing-box with a dedicated Telegram TPROXY inbound and redirect only the Telegram CIDRs from OpenWrt to HAOS; retain the working HAOS DNS/TCP-edge behavior unchanged.

Discard list: TGB relocation, VPN subscription changes, LAN DNS policy changes, general server-88 recovery, and unrelated ingress changes.

Evidence so far: Mac has HTTP/HTTPS/SOCKS system proxies disabled; its DC TCP probes time out. `server-88` SSH control path timed out, while its TCP ports remain reachable. TGB nginx routes `/` to `192.168.2.75:35622` and multiple helper paths to other server-88 ports. The active HAOS Smart Edge container is healthy and runs sing-box 1.13.14, but the router currently has neither `telegram_v4` nor a policy table-100 route.

Completion evidence (2026-09-01): HAOS Smart Edge runs sing-box TPROXY TCP/UDP
on :12555 with the Telegram nft CIDR set and table-100 local route. OpenWrt
`telegram_v4` marks route through `192.168.2.101`; its rule counter reached
2392 packets. With HTTP/HTTPS/SOCKS proxies disabled, Telegram Desktop on the
Mac held established sessions to 149.154.167.41, 149.154.167.51, and
91.105.192.100 on TCP/443.
