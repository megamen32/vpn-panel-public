# Public SmartDNS edge alias

Started at 2026-09-11T04:15:46+03:00 (`date --iso-8601=seconds`).

- **Результат:** LAN SmartDNS возвращает публичный адрес для проксируемых доменов, чтобы Chrome не считал цель локальной сетью, при этом HTTPS идёт через локальный HAOS Smart Edge.
- **Канарейка:** LAN-клиент получает публичный A для `chatgpt.com`; TLS с исходным SNI `chatgpt.com` через этот A проходит HAOS Smart Edge, а прямой домен остаётся без подмены.
- **Минимальный срез:** параметризовать адрес DNS-ответа и добавить ограниченный LAN hairpin DNAT/SNAT только для публичного ingress IP:443 к HAOS:443.
- **Не делаем:** новый внешний DNS, изменение WAN ingress, смену VPN-политики, IPv6 и массовые изменения доменных правил.

## Готово

- 2026-09-11: OpenWrt применил `vpn_panel_public_smart_edge_https`: только LAN TCP `203.0.113.1:443` DNAT на `192.168.2.101:443`; резервная копия firewall: `/root/vpn-panel-transparent-smart-edge/backups/public_alias_20260911_012610`.
- Router DNS now returns `203.0.113.1` for `chatgpt.com`; `ya.ru` was confirmed not overridden.
- Live TLS through the alias returned HTTP 403 from ChatGPT (valid reachable Cloudflare response); ordinary `vpn.bezrabotnyi.com` ingress remained HTTP 200.
- Real headed Chrome loaded the ChatGPT page through the LAN DNS alias with no local-network access prompt.
- Regression: focused tests, `npm test`, `npm run build`, shell syntax checks, and `git diff --check` passed.
