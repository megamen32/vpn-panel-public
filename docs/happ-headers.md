# Happ subscription headers

Happ (iOS VPN-клиент) поддерживает HTTP-заголовки в ответе на subscription-запрос.
Все заголовки отдаются на эндпоинтах `/sub/:token/plain`, `/sub/:token/v2ray`, `/sub/:token/happ`.

## Основные

| Header | Описание | Пример |
|--------|----------|--------|
| `profile-title` | Название профиля в приложении | `BezVPN` |
| `profile-update-interval` | Интервал автообновления в часах | `1` |
| `providerid` | ID провайдера (для группировки подписок) | `IDdS75kg` |

## Маршрутизация

| Header | Описание | Пример |
|--------|----------|--------|
| `routing-enable` | Включить routing (1/0) | `1` |
| `routing` | Routing config URL (`happ://routing/...`) | `happ://routing/onadd/<base64>` |

## Уведомления

| Header | Описание | Пример |
|--------|----------|--------|
| `announce` | Текст уведомления (формат `base64:...`) | `base64:0JzQvtC5INC60LDRh9Cw0Lw=` |

## Статистика трафика (опционально)

| Header | Описание | Пример |
|--------|----------|--------|
| `subscription-userinfo` | upload/download/total/expire | `upload=0; download=0; total=68719476736; expire=0` |

## Happ-specific (устаревшие, вместо них routing)

| Header | Описание |
|--------|----------|
| `happ-domain-strategy` | AsIs — без изменений; IPIfNonMatch — если IP не совпадает; IPOnDemand — всегда резолвить |
| `happ-hosts` | Принудительное разрешение доменов (`domain:IP`) |
| `happ-proxy-groups` | Кастомные прокси-группы (заменено routing header) |

## Где заданы в коде

`src/server.ts:236-243`:

```typescript
function happHeaders(reply: { header: (k: string, v: string) => void }) {
  reply.header("profile-title", "BezVPN");
  reply.header("profile-update-interval", "1");
  reply.header("routing-enable", "1");
  reply.header("routing", happRoutingLink());
  reply.header("providerid", "IDdS75kg");
  reply.header("announce", HAPP_ANNOUNCE);
}
```

`subscription-userinfo` не используется (безлимитный сервис).
`happ-domain-strategy` / `happ-hosts` / `happ-proxy-groups` не используются — маршрутизация через routing header.
