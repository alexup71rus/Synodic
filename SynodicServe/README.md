# SynodicServe

Серверная часть Synodic: комнаты на двоих, realtime-обмен событиями плеера
и раздача фронтенда [SynodicWeb](../SynodicWeb). Видео не стримится —
синхронизируется только состояние просмотра (play / pause / seek / скорость,
если её поддерживает API плеера).

## API

HTTP:

- `GET /` → статика фронтенда (`public/` после деплоя, `../SynodicWeb` в деве)
- `POST /api/rooms` → `201 { "code": "…" }` — создать комнату;
  тело: `{ "video": { "provider": "youtube|rutube|vk", "videoId": "…", "ownerId": "…" } }`
  (необязательно; `startAt` и `p` используются для YouTube/Rutube,
  `ownerId` — для VK)
- `GET /api/vk-oembed?ownerId=…&videoId=…` → `{ "hash": "…" }` — получить
  официальный embed-hash публичного VK Видео через tokenless `video.getOembed`;
  произвольные URL сервер не проксирует
- `GET /health` → `200 { "ok": true, "rooms": N }`

WebSocket: `/ws?room=<code>` — войти в комнату. Максимум 2 участника,
третьему придёт close-код `4000`, для неизвестной комнаты — `4004`.
Код комнаты — 4 символа из алфавита без похожих знаков
(`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), регистр не важен.

Протокол (JSON):

- клиент → сервер:
  - `{ type: 'sync', event: { type, currentTime, rate, ts } }`
    (`type`: `play`, `pause`, `seek` или `ratechange`)
  - `{ type: 'video', video: { provider, videoId, ownerId?, startAt?, p?, hash? } }` — сменить видео
  - `{ type: 'ready' }` — жест пользователя (напарник готов)
  - `{ type: 'keepalive' }`
- сервер → клиент:
  - `joined` (снапшотом состояния, видео и числом участников)
  - `peer-joined`, `peer-left`, `peer-ready`
  - `sync` (событие или heartbeat), `video`

Событие `sync` рассылается второму участнику и обновляет снапшот комнаты,
поэтому опоздавший при входе сразу получает актуальное состояние. Смена видео
сбрасывает снапшот (новое видео — просмотр заново). Во время воспроизведения
сервер раз в 3 с рассылает обоим участникам общий `heartbeat`, а транспортный
ping/pong закрывает зависшие соединения, чтобы клиент переподключился.

## Разработка

node ≥ 18.

    npm install
    npm run dev     # node --watch; статика берётся из ../SynodicWeb
    npm start

Проверка end-to-end (сервер должен быть запущен):

    npm run smoke

Невалидный JSON или источник видео получает `400`; размер тела запроса и
WebSocket-сообщений ограничен. Создание комнат ограничено 30 запросами в
минуту на весь небольшой инстанс и общим потолком 5000 комнат; комната,
в которую никто не вошёл, удаляется примерно через 15 минут.

Параметры приватной ссылки Rutube и стартовая позиция проходят через
сервер вместе с источником, но не пишутся в логи. Ответы VK oEmbed
кешируются на 12 часов; пользовательский или сервисный API-токен для VK
не нужен.

### Постеры TMDB (необязательно)

Витрина на стартовом экране включается только при наличии API key v3 TMDB:

    cp .env.example .env
    # впишите TMDB_TOKEN в .env

Без ключа `/api/posters` отвечает пустым списком, и интерфейс остаётся цельным
без заглушек. Данные кешируются на 12 часов; атрибуция TMDB показывается в
диалоге «Как это работает» только вместе с постерами.

## Запуск в Docker

Нужен Docker с Compose. Команды выполняются из `SynodicServe/` на машине,
где будет работать бэкенд.

```bash
mkdir -p public
cp -R ../SynodicWeb/. public/
docker compose up -d --build app
```

Сайт и API доступны на `http://localhost:8787`. Порт привязан к localhost.

```bash
docker compose ps
docker compose logs -f --tail 50 app
curl http://localhost:8787/health
```

Для доступа извне настройте HTTPS-прокси к приложению с поддержкой WebSocket
на `/ws`. Можно использовать сервис `caddy` из Compose: сначала задайте свой
домен и TLS в `deploy/caddy/Caddyfile`, включая адрес в `Content-Security-Policy`,
затем запустите `docker compose up -d caddy`. Текущий Caddyfile содержит
настройки прежнего развёртывания с внутренним сертификатом.

Остановка:

```bash
docker compose down
```

## Структура

- `src/index.js` — HTTP + WebSocket, точка входа
- `src/rooms.js` — комнаты: участники, видео, снапшот состояния, рассылка
- `src/static.js` — раздача статики фронтенда
- `Dockerfile`, `docker-compose.yml`, `deploy/caddy/Caddyfile` — прод-стек
- `scripts/smoke.mjs` — end-to-end тест
