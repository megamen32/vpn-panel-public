# Стабильность GitHub API в LAN

- Запрос пользователя: «да надо стабильность».
- Цель: стабилизировать LAN Smart Edge для GitHub API и связанных служебных поддоменов, не меняя их proxy policy.
- Бизнес-канарейка: из LAN DNS `api.github.com` продолжает возвращать LAN Smart Edge, а серия TLS и HTTP запросов к `/search/repositories` и `/orgs/openai/repos` проходит без timeout.
- Подтверждённый путь: OpenWrt dnsmasq сейчас синтезирует `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com` и `github.githubassets.com` в `192.168.2.1`; router HAProxy:443 направляет их на server-88 Xray. `github.com` остаётся прямым.
- Scope: LAN Smart Edge на router и server-88, targeted service/route repair and live DNS/TLS checks.
- Исключено: обход GitHub direct DNS, изменение публичного ingress, сертификатов, VPN-конфигураций и не связанных с GitHub доменов.
- Initial estimate: 12–25 active minutes. Время непрерывно не контролировалось; инструмент контроля записал 12 минут как явную оценку, а не измеренный active time.
- Реализация: общий DE LAN pool исключает падающие WS/CDN transports и использует XHTTP/XHTTP-H2. GitHub SNI направляется в проверенный `us-auto` pool до общего DE route.
- Live proof: после deploy GitHub search прошёл 10/10, organization endpoint прошёл минимум 13/13; TLS timeout не наблюдался.
- Статус: done.
