# OpenWrt DNS migration

> Ownership: VPN Panel owns SmartDNS/sing-box policy, generators, and deploy
> logic; see [../AGENTS.md](../AGENTS.md).
> `/home/roomhacker/ServersAdministartion` owns OpenWrt/HAOS physical topology,
> recovery, and port/access maps. Read both contracts before changing this
> boundary.

LAN clients use the router as their stable DNS address:

```text
DHCP option 6 -> 192.168.2.1
OpenWrt dnsmasq
  all queries -> 192.168.2.101:53 unified HAOS add-on
  generated rebind-domain-ok only -> permits HAOS private Smart Edge answers
HAOS add-on
  SmartDNS :53 synthesizes 192.168.2.1 + TCP Smart Edge :443
  bundled sing-box 1.13.14 -> private HTTP 127.0.0.1:13128
OpenWrt TCP 192.168.2.1:443 -> simple LAN-prerouting DNAT/SNAT -> HAOS :443
```

`src/cli/render-openwrt-smart-dns.ts` renders the effective persisted
`SmartDnsPolicy` into a line-oriented candidate. OpenWrt stores the last
generated set in `/etc/vpn-panel-smart-dns.domains`; the deploy script removes
only that previously managed set, preserving the router's `/lan/` zone and
unrelated DNS settings. There is no manually maintained domain list in the
OpenWrt shell script. The managed dnsmasq conf-dir file
`/etc/vpn-panel-dnsmasq.d/smart-dns.conf` contains only
`rebind-domain-ok=/domain/` lines generated from that candidate. It never
creates `local` or `address` lines, so HAOS remains the only policy/answer
producer and OpenWrt's global rebind protection stays enabled.

This topology was cut over to the Store app on 2026-09-13 after UDP/TCP DNS,
TLS, native LAN-client, recovery, and Telegram-lane canaries. The unified
add-on bundles sing-box and does not use the old external
`local_singbox_proxy :3128`.

## Stale DHCP leases

The old DHCP option advertised `192.168.2.75` or `192.168.2.100` directly.
`lan-dns-compat.service` temporarily keeps TCP/UDP 53 on server-88 and forwards
every query to `192.168.2.1` with no cache and no domain policy. Its retirement
timer stops and disables it after 48 hours, four times the current 12-hour DHCP
lease horizon. This paragraph is rollback/history only; do not restore `.75`
or `.100` as the selected target.

## Deploy and verification

The legacy `scripts/deploy-all.sh smartdns`, `router-dns`, and `router` targets,
`scripts/deploy-smartdns-unified.sh`, router-HAProxy deploy scripts, and router
HAProxy watchdog are retired for this LAN architecture. Do not run them for the
HAOS migration. Use only the unified HAOS add-on plus simple OpenWrt forwarding
path selected in `AGENTS.md`.

The selected cutover validates the add-on and OpenWrt candidate before changing
listeners, creates timestamped backups, and verifies:

- DHCP option 6 is `192.168.2.1`;
- OpenWrt forwards DNS to `192.168.2.101:53`;
- generated domains resolve through HAOS to the LAN edge `192.168.2.1`;
- generated domains have a matching `rebind-domain-ok` exception while
  `rebind_protection=1` stays enabled and no generated `local`/`address` rule
  exists;
- TCP `192.168.2.1:443` is DNAT/SNATed before routing to `192.168.2.101:443`;
- normal WAN/public ingress is unchanged;
- bundled sing-box `1.13.14` listens only on `127.0.0.1:13128` inside the add-on;
- `ya.ru` remains direct;
- the external `local_singbox_proxy :3128` is not a dependency;
- recovery HAProxy `:8080`/`:8443` and Telegram IP TPROXY still work.

Do not reboot the router for this migration.

## Rollback

The OpenWrt apply prints its exact `/etc/config/dhcp.bak_smartdns_<timestamp>`
path. Restore it and restart dnsmasq only:

```bash
cp -a /etc/config/dhcp.bak_smartdns_<timestamp> /etc/config/dhcp
# Restore the matching smart-dns.conf.bak_<timestamp> when it exists; otherwise
# remove /etc/vpn-panel-dnsmasq.d/smart-dns.conf from the first migration.
/etc/init.d/dnsmasq restart
```

For rollback only, on server-88 disable the retirement timer and restore the matching
`.bak_<timestamp>` files under `/etc/vpn-panel` and `/etc/systemd/system`, then
run `systemctl daemon-reload`. The deploy script also recreates the emergency
transient `.75 -> .100` forwarder automatically if durable installation fails.
Do not treat that emergency route as the forward architecture.
