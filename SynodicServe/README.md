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
минуту на весь небольшой инстанс и общим потолком 5000 комнат; комната, в
которую никто не вошёл, удаляется примерно через 15 минут. Параметры приватной ссылки Rutube и стартовая
позиция проходят через сервер вместе с источником, но не пишутся в логи.
Ответы VK oEmbed кешируются на 12 часов; пользовательский или сервисный
API-токен для VK не нужен.

### Постеры TMDB (необязательно)

Витрина на стартовом экране включается только при наличии API key v3 TMDB:

    cp .env.example .env
    # впишите TMDB_TOKEN в .env

Без ключа `/api/posters` отвечает пустым списком, и интерфейс остаётся цельным
без заглушек. Данные кешируются на 12 часов; атрибуция TMDB показывается в
диалоге «Как это работает» только вместе с постерами.

## Деплой на домашний сервер

Одной командой (нужен SSH-ключ в `khdr@khodyr.netcraze.pro` и docker в группе
пользователя):

    scripts/deploy.sh

Что делает:

1. rsync бэкенда в `~/Documents/Projects/SynodicServe`, фронтенда → `public/`
2. останавливает и удаляет старый user-systemd сервис `synodic-serve`
   (заменим docker-стеком; порт 8787 должен освободиться до старта)
3. проверяет Compose-конфигурацию и запускает контейнеры `app` (этот сервер,
   порт `127.0.0.1:8787` на хосте) и `caddy` (порты 80/443)
4. health-check и smoke-тест

Проверка состояния и логов:

    ssh khdr@khodyr.netcraze.pro 'cd ~/Documents/Projects/SynodicServe && docker compose ps'
    ssh khdr@khodyr.netcraze.pro 'cd ~/Documents/Projects/SynodicServe && docker compose logs -f --tail 50 app'

Публичный TLS терминирует Keenetic своим wildcard-сертификатом. В публикации
веб-приложения настроено:

- `synodic.khodyr.netcraze.pro`;
- клиент `00:16:96:ee:0d:79` (`192.168.1.99`);
- HTTPS, порт `443`, свободный доступ.

Keenetic обращается к серверу без SNI и подменяет `Host` на IP, поэтому Caddy
отвечает и на домен, и на `192.168.1.99`, использует `default_sni` и внутренний
сертификат. ACME здесь намеренно не используется. `.env` на сервере исключён
из `rsync --delete`, поэтому локальный TMDB-ключ переживает повторный деплой.

## Структура

- `src/index.js` — HTTP + WebSocket, точка входа
- `src/rooms.js` — комнаты: участники, видео, снапшот состояния, рассылка
- `src/static.js` — раздача статики фронтенда
- `Dockerfile`, `docker-compose.yml`, `deploy/caddy/Caddyfile` — прод-стек
- `scripts/smoke.mjs` — end-to-end тест
- `scripts/deploy.sh` — деплой
