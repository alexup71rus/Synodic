# SynodicServe

Серверная часть Synodic: комнаты на двоих, realtime-обмен событиями плеера
и раздача фронтенда [SynodicWeb](../SynodicWeb). Видео не стримится —
синхронизируется только состояние просмотра (play / pause / seek / скорость).

## API

HTTP:

- `GET /` → статика фронтенда (`public/` после деплоя, `../SynodicWeb` в деве)
- `POST /api/rooms` → `201 { "code": "…" }` — создать комнату;
  тело: `{ "video": { "provider": "youtube|rutube", "videoId": "…" } }` (необязательно)
- `GET /health` → `200 { "ok": true, "rooms": N }`

WebSocket: `/ws?room=<code>` — войти в комнату. Максимум 2 участника,
третьему придёт close-код `4000`, для неизвестной комнаты — `4004`.
Код комнаты — 4 символа из алфавита без похожих знаков
(`ABCDEFGHJKMNPQRSTUVWXYZ23456789`), регистр не важен.

Протокол (JSON):

- клиент → сервер:
  - `{ type: 'sync', event: { type, currentTime, rate, ts } }`
    (`type`: `play`, `pause`, `seek` или `ratechange`)
  - `{ type: 'video', video: { provider, videoId } }` — сменить видео
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

## Деплой на домашний сервер

Одной командой (нужен SSH-ключ в `khdr@khodyr.netcraze.pro` и docker в группе
пользователя):

    scripts/deploy.sh

Что делает:

1. rsync бэкенда в `~/Documents/Projects/SynodicServe`, фронтенда → `public/`
2. останавливает и удаляет старый user-systemd сервис `synodic-serve`
   (заменим docker-стеком; порт 8787 должен освободиться до старта)
3. `docker compose up -d --build` — контейнеры `app` (этот сервер, порт
   `127.0.0.1:8787` на хосте) и `caddy` (TLS-терминация, автосертификаты
   Let's Encrypt, порты 80/443)
4. health-check и smoke-тест

Проверка состояния и логов:

    ssh khdr@khodyr.netcraze.pro 'cd ~/Documents/Projects/SynodicServe && docker compose ps'
    ssh khdr@khodyr.netcraze.pro 'cd ~/Documents/Projects/SynodicServe && docker compose logs -f --tail 50 app'

Сертификат для `synodic.khodyr.netcraze.pro` Caddy получает сам (TLS-ALPN по
порту 443) — роутер должен пробрасывать TCP 443 на сервер; веб-панель роутера
придётся предварительно убрать с 443-го. Сертификаты живут в docker-томе
`caddy_data` и продлеваются автоматически.

## Структура

- `src/index.js` — HTTP + WebSocket, точка входа
- `src/rooms.js` — комнаты: участники, видео, снапшот состояния, рассылка
- `src/static.js` — раздача статики фронтенда
- `Dockerfile`, `docker-compose.yml`, `deploy/caddy/Caddyfile` — прод-стек
- `scripts/smoke.mjs` — end-to-end тест
- `scripts/deploy.sh` — деплой
