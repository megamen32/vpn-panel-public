# SmartDNS DoT renewal sync

## Симптом

Новый wildcard DoT сертификат выдан HAOS acme.sh и вручную установлен в `/opt/smart-dns/certs/`, но старый certbot deploy-hook всё ещё копирует псевдо-линию с сертификатом `44.bezrabotnyi.com`.

## Минимальное evidence

`scripts/smartdns-go/renew-certs.sh` использует `/etc/letsencrypt/live/dns.bezrabotnyi.com`, а этот путь ссылается на `incident-fleet-0`, не имеющий SAN `*.dns.bezrabotnyi.com`.

## Следующий маршрут

Сделать source-controlled renewal/sync из HAOS acme.sh на server-100, не перезаписывая валидный wildcard PEM; проверить принудительным безопасным обновлением до следующего срока `2026-11-17`.
