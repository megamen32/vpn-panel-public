# smartdns (Go)

> Ownership: VPN Panel owns SmartDNS code, routing policy, generators, and
> deploy logic; see [../../AGENTS.md](../../AGENTS.md).
> `/home/roomhacker/ServersAdministartion` owns physical LAN, HAOS/OpenWrt,
> recovery, and port/access topology. Read both contracts before changing the
> shared boundary.

Drop-in Go replacement for `/opt/smart-dns/server.js` (Node.js). Keeps the
exact wire behaviour for DoH, DoT, plain DNS-over-UDP/TCP, smart-edge synthesis
and the `/edge-auth*` control endpoints so existing client URLs, mobile
profiles and edge probe flows continue to work unchanged.

The Go binary is the canonical SmartDNS implementation. The bundled systemd
unit is the current server-100 rollback runtime; the selected LAN target
packages this binary with TCP Smart Edge in a HAOS Supervisor add-on. The Node
implementation under `infra/smart-dns/` is deprecated.

## Scope and DPI limitations

SmartDNS is a DNS-routing and edge-selection mechanism, not a VPN. It works
well when access is affected by DNS poisoning, DNS-based blocking, or choosing
the wrong destination IP and the ISP does not subsequently block the
application protocol. A successful DoH/DoT response or a synthesized Smart
Edge address proves only that the DNS/control-plane stage worked.

SmartDNS does not encrypt, tunnel, or disguise the client's TLS/QUIC traffic.
The `local-proxy` profile handles Telegram, Discord, YouTube, and Instagram
only on the LAN by returning the local TCP edge. The current rollback edge is
server-88; the selected target is the HAOS add-on at `192.168.2.101:443`. That
add-on bundles sing-box `1.13.14` and uses only its private HTTP listener
`127.0.0.1:13128`; it never depends on external `local_singbox_proxy :3128`.
Public DoH/DoT resolves the same names directly because a remote Smart Edge
still exposes the blocked SNI. Away from the LAN, use Xray/VPN/SmartRelay or a
full proxy path. The separate Telegram IP TPROXY lane on server-88 is preserved.

## Features

| Feature | Notes |
|---|---|
| **DoH** (HTTP, port 8053) | `/dns-query/<cid>` GET (`?dns=base64url`) and POST (`application/dns-message`) |
| **DoT** (TLS, port 8853) | SNI `<cid>.dns.bezrabotnyi.com` → route by client config |
| **Plain DNS** (UDP and TCP, port 5353 by default) | Client-id resolved via source IP → `clientsByIP` map; falls back to `defaultClientId`. Use this for routers that can't speak DoH/DoT. |
| **Listener profiles** | DoH/DoT can use `public`; plain DNS can use `local`, with independent default routes and edge addresses. |
| **Smart-Edge synthesis** | Resolves `proxy`-routed A queries with the selected `edgeProfiles.<profile>.ipv4s`; remembers IP/domain in the TTL store. |
| **Edge auth API** | `/edge-auth`, `/edge-map`, `/edge-auth-debug` behind `X-Edge-Auth-Token` |
| **Routing** | hard-direct → direct → local-proxy → proxy → listener-profile default |
| **Direct upstream** | UDP `1.1.1.1:53` (configurable) |
| **Proxy upstream** | Persistent HTTP/2 DoH through the configured HTTP proxy → Cloudflare DoH (`cloudflare-dns.com/dns-query`). |
| **Positive cache** | Bounded in-memory cache preserves upstream TTLs, ages responses, and rewrites DNS transaction IDs. |
| **Sync** | Optional periodic pull of clients/policy from panel API |
| **Single static binary** | 6.4 MB; no Node.js, no npm; runs under systemd |

## Build

```bash
make            # → ./smartdns (6.4 MB static binary)
CGO_ENABLED=0 go build -trimpath -ldflags '-s -w' -o smartdns .
```

## Run

```bash
SMART_DNS_CONFIG=./test-config.json ./smartdns
```

Config schema is JSON-compatible with `config.example.json` shipped from the
production deploy (loaded once at startup, no SIGHUP reload).

## Endpoints (consumer-facing)

| Client | URL | Notes |
|---|---|---|
| **macOS, Android, iOS apps** | `https://dns.bezrabotnyi.com/dns-query/<client-id>` | DoH profile (mobileconfig / system DNS) |
| **OpenWRT (DoT)** | `<cid>.dns.bezrabotnyi.com@dns.bezrabotnyi.com:8853` | via `stubby` or luci-app-smartdns |
| **OpenWrt/LAN (UDP or TCP)** | primary `192.168.2.101:53`; standby `192.168.2.100:53` | Clients keep router DNS `192.168.2.1`. The router uses exactly one upstream at a time and switches to server-100 only when HAOS DNS fails. |

## Plain DNS for тупых роутеров

OpenWRT без поддержки DoH/DoT (или просто чтобы не заморачиваться с TLS на маленькой коробочке) может использовать обычный UDP DNS. Условие — на роутере настроены **статические DHCP leases**, чтобы каждому устройству доставался один и тот же LAN IP:

Следующий JSON фиксирует текущий server-100 rollback. В выбранной HAOS-схеме
клиенты по-прежнему используют DNS роутера `192.168.2.1`, а роутер пересылает
запросы add-on на `192.168.2.101:53`; адрес `.100` не добавляется вторым
одновременным upstream. Он доступен только через health-check переключение:
локальный профиль server-100 возвращает удалённый relay IP для части
проксируемых доменов и не дублирует HAOS TLS/TPROXY. Конфиг
`/opt/smart-dns/config.json` остаётся root-owned, но группа `roomhacker`
должна иметь право чтения; drop-in
`deploy/server-100/systemd/smart-dns-config-access.conf` восстанавливает его
перед запуском сервиса после root-run деплоя.

```jsonc
{
  "udpListen": {"host": "192.168.2.100", "port": 53, "profile": "local"},
  "clientsByIP": {
    "192.168.2.10": "f478b9a8a7759c4879ae98c4af41c402eb20c1a1d1b7ab75",  // телефон
    "192.168.2.11": "f478b9a8a7759c4879ae98c4af41c402eb20c1a1d1b7ab75",  // телевизор
    "192.168.2.12": "ab12cd34ef56..."                                          // второй юзер
  }
}
```

Когда `chatgpt.com` запрашивается с `192.168.2.10` — отдаётся синтез edge IP;
когда с неизвестного IP — фоллбэк на `defaultClientId`.

> Default порт `5353` (можно без рут-прав). Чтобы слушать на 53, запускай
> процесс от root или с `CAP_NET_BIND_SERVICE`, плюс в конфиге
> `"udpListen": {"host": "0.0.0.0", "port": 53}`.

### OpenWRT setup example

Network → DHCP and DNS → DNS forwardings → +:

```
Server:  192.168.2.100
Port:    53
```

Network → DHCP and DNS → Static Leases — выдай каждому устройству IP и
пропиши его в `clientsByIP` на server-100.

Все устройства в LAN автоматом получат правильный DNS без дополнительной
настройки на каждом клиенте — главное чтобы роутер был настроен на
`44.bezrabotnyi.com` единожды.

## Per-device install on macOS / iOS (mobileconfig)

client-id в URL и SNI — стабильный идентификатор, **не зависит от IP**.
Поэтому один и тот же `cid` работает на любом Wi-Fi, в любом 4G-операторе,
при подключении через Ethernet, iPhone-tethering и т.п.

Generate a `.mobileconfig` profile:

```bash
# базовый профиль (HTTPS DNS, без fallback)
./gen-mobileconfig.py <client-id> > SmartDNS.mobileconfig

# с fallback на plain DNS (рекомендуется на враждебных 4G-сетях,
# где DPI блокирует 443 к dns.bezrabotnyi.com — DNS переключится
# на провайдерский, временно потеряв маршрутизацию по правилам)
./gen-mobileconfig.py --fallback <client-id> > SmartDNS.mobileconfig

# другой server URL (для теста)
./gen-mobileconfig.py --server https://dns.example.com <client-id> > x.mobileconfig
```

Install:

```bash
open SmartDNS.mobileconfig       # macOS — installer нативно
xed -b SmartDNS.mobileconfig     # alt: в Xcode → install
```

AirDrop the same file to an iPhone / iPad — профиль установится
автоматически. На macOS Sequoia (15+) можно обойтись без профиля:
Settings → General → VPN & DNS → + → Encrypted DNS → URL
`https://dns.bezrabotnyi.com/dns-query/<client-id>`.

Снять профиль:

```
System Settings → General → VPN & DNS → отключи нужную запись
# или Profiles → удалить
```

## Legacy/rollback deploy to server-100

`scripts/deploy-smartdns-unified.sh` and the `smartdns`, `router-dns`, `router`,
default, and `all` forms of `scripts/deploy-all.sh` encode the retired
server-100/router-HAProxy LAN path. Do not run them as forward deploys for the
HAOS migration.

The deploy script builds and tests the binary, migrates the previous public
configuration to `edgeProfiles`, copies the wildcard certificate, makes
timestamped backups, installs LAN-only UFW rules for TCP/UDP 53, validates the
unit, starts it, and runs local-profile smoke tests. On the first migration it
reads the legacy server-44 config; later runs preserve the canonical server-100
config. It does not switch nginx, OpenWrt, or retire old instances; those
cutover steps stay explicit so each can be rolled back independently.
Use the `router-dns` target for the OpenWrt DNS/DHCP step; unlike the broader
`router` target, it does not validate, replace, or reload HAProxy.

Do not extend this path as the LAN deployment. The active topology keeps
client DNS/DHCP at `192.168.2.1`, forwards DNS to
the HAOS add-on on `192.168.2.101:53`, and hairpin-DNATs TCP
`192.168.2.1:443` to `192.168.2.101:443`. AdGuard, Nginx Proxy Manager, router
HAProxy, external `local_singbox_proxy :3128`, and this server-100 runtime are
are stopped/retired rollback paths after the successful canary. The unified add-on
bundles sing-box `1.13.14` behind `127.0.0.1:13128`; it never uses the external
proxy add-on. Public DoH/DoT on server-100 are a separate frontend and remain
until explicitly migrated. Preserve recovery HAProxy `:8080`/`:8443`.

## Legacy server-100 systemd rollback

The bundled `smart-dns.service` is the rollback server-100 unit. It runs as
`roomhacker`, grants only `CAP_NET_BIND_SERVICE` for port 53, and starts after
the panel so loopback policy sync is available. Install it through the unified
deploy script rather than copying the old server-44 unit.

## Smoke test

```bash
# Terminal 1
SMART_DNS_CONFIG=./test-config.json ./smartdns

# Terminal 2 — exercises DoH + UDP, 11 cases
./smoke.sh 18053 127.0.0.1 15353
```

Output:

```
smartdns smoke: HOST=127.0.0.1 DoH=:$18053 UDP=:$15353 CID=f478b9a8…
  OK   DoH smart-edge synth       chatgpt.com
  OK   DoH .ru direct             ya.ru
  OK   DoH directDomain           vpn2.bezrabotnyi.com
  OK   DoH hard-direct            github.com
  OK   DoH default-route          ifconfig.me
  OK   UDP smart-edge synth       chatgpt.com
  OK   UDP .ru direct             ya.ru
  OK   UDP directDomain           vpn2.bezrabotnyi.com
  OK   UDP hard-direct            github.com
  OK   UDP default-route          ifconfig.me
  OK   edge-auth-debug            (1 IPs / 1 maps)
```
