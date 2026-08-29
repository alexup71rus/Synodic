# SynodicServe

Серверная часть Synodic: комнаты на двоих и realtime-обмен событиями видео
между расширениями [SynodicExt](../SynodicExt). Видео не стримится —
синхронизируется только состояние просмотра (play / pause / seek / скорость).

## API

HTTP:

- `POST /api/rooms` → `201 { "code": "…" }` — создать комнату
- `GET /health` → `200 { "ok": true, "rooms": N }`

WebSocket: `/ws?room=<code>` — войти в комнату. Максимум 2 участника,
третьему придёт close-код `4000`.

Протокол (JSON):

- клиент → сервер: `{ type: 'sync', event: { type, currentTime, rate, ts } }`
- сервер → клиент: `joined` (со снапшотом состояния), `peer-joined`, `peer-left`, `sync`

Событие `sync` рассылается второму участнику и обновляет снапшот комнаты,
поэтому опоздавший при входе сразу получает актуальное состояние.

## Разработка

node ≥ 18.

    npm install
    npm run dev     # node --watch
    npm start

Проверка end-to-end (сервер должен быть запущен):

    npm run smoke

## Деплой на домашний сервер

Одной командой (нужен SSH-ключ в `khdr@khodyr.netcraze.pro`):

    scripts/deploy.sh

Что делает: rsync исходников в `~/Documents/Projects/SynodicServe` →
`npm ci --omit=dev` → перезапуск `node src/index.js` (nohup, лог в `logs/`) →
health-check. Цель переопределяется переменными `SYNODIC_REMOTE`, `SYNODIC_DIR`, `PORT`.

Не забыть при первом деплое: открыть порт (ufw) и, если напарник не в локальной
сети, пробросить порт на роутере (сейчас снаружи открыт только SSH).

Позже: systemd-юнит или docker вместо nohup, TLS-терминация, heartbeat.

## Структура

- `src/index.js` — HTTP + WebSocket, точка входа
- `src/rooms.js` — комнаты: участники, снапшот состояния, рассылка, уборка пустых
