# SmartDNS DoT certificate repair

## Запрос и цель

Починить строгую TLS-проверку для персонального DoT имени
`0d5fbe27e8718bd4b63380953e0ea599731d1eededabcedf.dns.bezrabotnyi.com` на публичном порту 853.

## Краткий маршрут

- Канарейка: `openssl s_client` с SNI и `-verify_hostname` для персонального имени должен завершиться без hostname mismatch; затем DNS-over-TLS запрос должен получить корректный ответ.
- Scope: сертификат/публичный DoT ingress и минимально необходимый SmartDNS reload. Исключены изменения политик маршрутизации, DoH и чужой незакоммиченный `src/smart-dns-policy.ts`.
- Первоначальная оценка: минимум 10, максимум 25 активных минут.
- Начало: 2026-08-19T17:45:00+03:00. Активное время: 12 минут по наблюдаемой рабочей сессии.

## Evidence

- `smart-dns.service` активен и слушает `127.0.0.1:8853`; nginx владеет `0.0.0.0:853`.
- До исправления публичный DoT отдаёт сертификат `44.bezrabotnyi.com`, не соответствующий персональному `*.dns.bezrabotnyi.com` имени.
- `renew-certs.sh` копирует `/etc/letsencrypt/live/dns.bezrabotnyi.com`, но это вручную созданная ссылка на `incident-fleet-0` (`44.bezrabotnyi.com`), отдельной certbot-линии для DNS нет.
- Попытка DNS-01 через уже настроенный в HAOS add-on `acme.sh` и Reg.ru API получила подтверждение добавления TXT, но публичные `1.1.1.1` и `8.8.8.8` не увидели `_acme-challenge.dns.bezrabotnyi.com`; ACME-процесс был остановлен как застрявший. В рабочие PEM и сервис изменений не внесено.
- HTTP-01 fallback для персонального wildcard-host не годится: временный файл в каноническом webroot по этому Host вернул пустой ответ. Пробный файл удалён.

## Result

- После 15 минут распространения DNS-01 Let’s Encrypt выдал сертификат с SAN `dns.bezrabotnyi.com` и `*.dns.bezrabotnyi.com`; срок действия до `2026-11-17T14:22:56Z`.
- PEM установлен в `/opt/smart-dns/certs/` с локальными копиями предыдущего PEM с суффиксом `20260819_152212`; `smart-dns.service` перезапущен и активен.
- Реальная канарейка: `openssl s_client -verify_hostname` по персональному имени вернул `Verify return code: 0 (ok)`; `dig +tls +tls-ca +tls-hostname` получил `NOERROR` и один A-ответ.

## Deferred maintenance

Текущий certbot deploy-hook всё ещё указывает на старую псевдо-линию `/etc/letsencrypt/live/dns.bezrabotnyi.com`; до истечения нового сертификата нужно отдельно автоматизировать обновление из HAOS acme.sh на server-100, чтобы очередной certbot hook не перезаписал новые PEM старым сертификатом.
