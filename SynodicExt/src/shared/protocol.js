/**
 * Общие константы протокола Synodic.
 * Файл подключается как обычный скрипт во всех трёх контекстах:
 * content script (через manifest), popup (через <script>)
 * и service worker (через importScripts).
 */
globalThis.SynodicProtocol = Object.freeze({
  // События видео, которые синхронизируем
  EVENT_PLAY: 'play',
  EVENT_PAUSE: 'pause',
  EVENT_SEEK: 'seek',
  EVENT_RATE: 'ratechange',
  EVENT_HEARTBEAT: 'heartbeat',

  // Сообщения popup -> service worker
  MSG_GET_STATUS: 'get-status',
  MSG_CREATE_ROOM: 'create-room',
  MSG_JOIN_ROOM: 'join-room',
  MSG_LEAVE_ROOM: 'leave-room',
  MSG_READY: 'ready',
  MSG_SELECT_TAB: 'select-tab',

  // Сообщения content script <-> service worker
  MSG_GET_CONTENT_STATE: 'get-content-state', // активна ли комната в этой вкладке
  MSG_CONTENT_PING: 'content-ping', // content script уже подключён к странице
  MSG_VIDEO_EVENT: 'video-event', // локальное событие видео -> сервер
  MSG_VIDEO_CANDIDATE: 'video-candidate', // найдено видео в конкретном frame
  MSG_READ_VIDEO_STATE: 'read-video-state', // состояние выбранного видео -> worker
  MSG_APPLY_EVENT: 'apply-event', // событие от напарника -> к видео
  MSG_START_VIDEO: 'start-video', // подтверждённый обоими старт
  MSG_ROOM_STATE: 'room-state',   // состояние комнаты -> popup и контент

  // Сообщения клиент -> сервер
  CLIENT_SYNC: 'sync',
  CLIENT_VIDEO: 'video',
  CLIENT_READY: 'ready',
  CLIENT_KEEPALIVE: 'keepalive',

  // Сообщения сервера (WebSocket, JSON)
  SERVER_JOINED: 'joined',
  SERVER_PEER_JOINED: 'peer-joined',
  SERVER_PEER_LEFT: 'peer-left',
  SERVER_PEER_READY: 'peer-ready',
  SERVER_SYNC: 'sync',
  SERVER_VIDEO: 'video',

  // Источники, которые сайт умеет открыть официальным embed-плеером
  PROVIDER_YOUTUBE: 'youtube',
  PROVIDER_RUTUBE: 'rutube',
  PROVIDER_VK: 'vk',
});
