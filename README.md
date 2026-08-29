# SynodicServe

Серверная часть Synodic: комнаты на двоих и realtime-обмен событиями видео
между расширениями [SynodicExt](../SynodicExt). Видео не стримится —
синхронизируется только состояние просмотра (play / pause / seek / скорость).

## API

HTTP:

- `POST /api/rooms` → `201 { "code": "…" }` — создать комнату
- `GET /health` → `200 { "ok": true, "rooms": N }`

WebSocket: `/ws?room=<code>` — войти в комнату. Максимум 2 участника,
третьему придёт close-код `4000`, для неизвестной комнаты — `4004`.

Протокол (JSON):

- клиент → сервер: `{ type: 'sync', event: { type, currentTime, rate, ts } }`
  (`type`: `play`, `pause`, `seek` или `ratechange`) и `{ type: 'keepalive' }`
- сервер → клиент: `joined` (со снапшотом состояния и числом участников),
  `peer-joined`, `peer-left`, `sync`

Событие `sync` рассылается второму участнику и обновляет снапшот комнаты,
поэтому опоздавший при входе сразу получает актуальное состояние.
Во время воспроизведения сервер раз в 3 с рассылает обоим участникам общий
`heartbeat`, а транспортный ping/pong закрывает зависшие соединения, чтобы
клиент мог переподключиться.

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
`npm ci --omit=dev` → установка/перезапуск user-systemd unit → health-check →
smoke-тест. Скрипт можно запускать из любой папки. Цель
переопределяется переменными `SYNODIC_REMOTE`, `SYNODIC_DIR`, `PORT`.

Unit `synodic-serve.service` включён в автозапуск и использует
`Restart=always`. Код не обновляется автоматически: новая версия появляется
только после следующего запуска `scripts/deploy.sh`. Проверка состояния и логов:

    ssh khdr@khodyr.netcraze.pro 'systemctl --user status synodic-serve --no-pager'
    ssh khdr@khodyr.netcraze.pro 'journalctl --user -u synodic-serve -n 50 --no-pager'

Не забыть при первом деплое: открыть порт (ufw) и, если напарник не в локальной
сети, пробросить порт на роутере (сейчас снаружи открыт только SSH).

Позже: TLS-терминация.

## Структура

- `src/index.js` — HTTP + WebSocket, точка входа
- `src/rooms.js` — комнаты: участники, снапшот состояния, рассылка, уборка пустых
- `systemd/synodic-serve.service` — шаблон постоянного user-systemd сервиса
