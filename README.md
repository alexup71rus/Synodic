<p align="center">
  <img src="./SynodicWeb/icons/icon.svg" width="88" height="88" alt="Логотип Synodic">
</p>

<h1 align="center">Synodic</h1>

<p align="center">
  Совместный просмотр YouTube и Rutube вдвоём.
  <br>
  <a href="https://synodic.khodyr.netcraze.pro"><strong>Открыть Synodic</strong></a>
  ·
  <a href="https://github.com/alexup71rus/Synodic/actions/workflows/ci.yml">CI</a>
</p>

Один участник создаёт комнату и отправляет ссылку второму. Пауза, продолжение,
перемотка и скорость воспроизведения синхронизируются почти сразу.

Synodic не передаёт и не хранит видео: официальные embed-плееры получают его
напрямую от YouTube или Rutube, а сервер обменивается только состоянием
просмотра.

```text
YouTube / Rutube → плеер 1 ↔ SynodicServe ↔ плеер 2 ← YouTube / Rutube
                         play · pause · seek · rate
```

## Что уже работает

- комнаты на двух участников и приглашение по ссылке или коду;
- YouTube и Rutube, включая приватные Rutube-ссылки с параметром `p`;
- двусторонние play, pause, seek и playback rate;
- восстановление снапшота после переподключения;
- коррекция дрейфа и повтор «проглоченных» плеером перемоток;
- явный жест «Смотреть вместе» для ограничений autoplay.

## Компоненты

- [`SynodicWeb/`](SynodicWeb/) — статический фронтенд без сборщика;
- [`SynodicServe/`](SynodicServe/) — Node.js-сервер комнат, WebSocket-протокол
  и раздача фронтенда.

## Локальный запуск

Нужен Node.js 18 или новее.

```bash
cd SynodicServe
npm ci
npm run dev
```

Сайт будет доступен на <http://localhost:8787>. В другой вкладке терминала
можно запустить полный smoke-тест комнат и синхронизации:

```bash
cd SynodicServe
npm run smoke
```

Витрина постеров опциональна. Чтобы включить её, скопируйте
`SynodicServe/.env.example` в `SynodicServe/.env` и задайте `TMDB_TOKEN`.
Без токена интерфейс не показывает пустой блок.

Прод-развёртывание через Docker Compose и особенности HTTPS описаны в
[`SynodicServe/README.md`](SynodicServe/README.md).

## Границы проекта

- одна комната рассчитана на двух участников;
- DRM и закрытые плееры не обходятся;
- реклама внутри сторонних плееров не синхронизируется;
- голосовой связи и трансляции экрана нет.

Лицензия — [MIT](LICENSE).
