/**
 * Общие константы протокола Synodic (клиентская копия).
 * Держать синхронно с SynodicServe/src/rooms.js.
 */
const SynodicProtocol = {
  // События видео, которые синхронизируем
  EVENT_PLAY: 'play',
  EVENT_PAUSE: 'pause',
  EVENT_SEEK: 'seek',
  EVENT_RATE: 'ratechange',
  EVENT_HEARTBEAT: 'heartbeat',

  // Сообщения клиент → сервер (WebSocket, JSON)
  CLIENT_SYNC: 'sync',       // { event: { type, currentTime, rate, ts } }
  CLIENT_VIDEO: 'video',     // { video: { provider, videoId, ownerId?, startAt?, p?, hash? } }
  CLIENT_READY: 'ready',     // жест пользователя — напарник готов
  CLIENT_KEEPALIVE: 'keepalive',

  // Сообщения сервер → клиент
  SERVER_JOINED: 'joined',       // { code, peers, state, video }
  SERVER_PEER_JOINED: 'peer-joined',
  SERVER_PEER_LEFT: 'peer-left',
  SERVER_PEER_READY: 'peer-ready',
  SERVER_SYNC: 'sync',
  SERVER_VIDEO: 'video',

  // Провайдеры видео
  PROVIDER_YOUTUBE: 'youtube',
  PROVIDER_RUTUBE: 'rutube',
  PROVIDER_VK: 'vk',
};
