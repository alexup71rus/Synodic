/** Комнаты: участники, видео, снапшот состояния просмотра и рассылка. */

import crypto from 'node:crypto';

const IDLE_ROOM_TTL_MS = 12 * 60 * 60 * 1000; // пустые комнаты прибираем через 12 ч
const UNJOINED_ROOM_TTL_MS = 15 * 60 * 1000; // брошенное создание не держим полдня
const DEFAULT_MAX_ROOMS = 5000;
const EVENT_TYPES = new Set(['play', 'pause', 'seek', 'ratechange']);
const MAX_VIDEO_TIME_S = 7 * 24 * 60 * 60;
const MAX_PLAYBACK_RATE = 16;
const VIDEO_ID_PATTERNS = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  rutube: /^[0-9a-f]{32}$/i,
};
const VK_OWNER_ID = /^-?\d{1,20}$/;
const VK_VIDEO_ID = /^\d{1,20}$/;
const VK_HASH = /^[A-Za-z0-9_-]{8,128}$/;
// алфавит без регистра и похожих символов (0/O, 1/I/L): код можно
// вписывать в любом регистре и диктовать по телефону
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Нормализовать источник видео или null. */
export function normalizeVideo(video) {
  if (!video || typeof video !== 'object') return null;
  const { provider, videoId } = video;
  if (provider === 'vk') {
    if (!VK_OWNER_ID.test(video.ownerId) || !VK_VIDEO_ID.test(videoId)) return null;
    const normalized = { provider, ownerId: video.ownerId, videoId };
    if (video.hash !== undefined) {
      if (typeof video.hash !== 'string' || !VK_HASH.test(video.hash)) return null;
      normalized.hash = video.hash;
    }
    return normalized;
  }
  if (!VIDEO_ID_PATTERNS[provider]?.test(videoId)) return null;

  const normalized = { provider, videoId };
  if (video.startAt !== undefined) {
    const startAt = Number(video.startAt);
    if (!Number.isFinite(startAt) || startAt < 0 || startAt > 7 * 24 * 60 * 60) return null;
    normalized.startAt = Math.floor(startAt);
  }
  if (provider === 'rutube' && video.p !== undefined) {
    if (typeof video.p !== 'string' || video.p.length === 0 || video.p.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(video.p)) return null;
    normalized.p = video.p;
  }
  return normalized;
}

export class Room {
  constructor(code, video = null) {
    this.code = code;
    /** @type {Set<import('ws').WebSocket>} */
    this.peers = new Set();
    // что смотрим — отдаём опоздавшему при входе
    this.video = normalizeVideo(video);
    // последний известный статус просмотра — отдаём опоздавшему при входе
    this.state = { isPlaying: false, currentTime: 0, rate: 1, updatedAt: 0 };
    this.lastSeen = Date.now();
    this.everJoined = false;
  }

  join(ws, maxPeers) {
    if (this.peers.size >= maxPeers) {
      ws.close(4000, 'room is full');
      return;
    }
    this.lastSeen = Date.now();
    this.everJoined = true;
    this.peers.add(ws);
    ws.send(JSON.stringify({
      type: 'joined',
      code: this.code,
      peers: this.peers.size,
      state: this.snapshot(),
      video: this.video,
    }));
    this.broadcast({ type: 'peer-joined', peers: this.peers.size }, ws);

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // мусорные кадры игнорируем
      }
      if (message.type === 'sync' && message.event) {
        const event = this.normalizeEventForVideo(normalizeEvent(message.event));
        if (!event) return;
        this.applyEvent(event);
        this.broadcast({ type: 'sync', event }, ws); // всем, кроме автора
        return;
      }
      if (message.type === 'video') {
        const video = normalizeVideo(message.video);
        if (!video) return;
        this.setVideo(video);
        this.broadcast({ type: 'video', video }, ws);
        return;
      }
      if (message.type === 'ready') {
        // жест пользователя: даём напарнику понять, что можно начинать
        this.broadcast({ type: 'peer-ready' }, ws);
      }
      // keepalive и прочее — просто держим соединение живым
    });

    ws.on('close', () => {
      this.peers.delete(ws);
      this.lastSeen = Date.now();
      this.broadcast({ type: 'peer-left', peers: this.peers.size });
    });
  }

  normalizeEventForVideo(event) {
    if (!event || this.video?.provider !== 'vk') return event;
    // Официальный VK embed API не умеет менять скорость. Не даём одному
    // участнику разогнать серверные часы и разъехать позициям всей комнаты.
    if (event.type === 'ratechange') return null;
    return { ...event, rate: 1 };
  }

  setVideo(video) {
    this.video = video;
    // новое видео — просмотр начинается заново, старая позиция не имеет смысла
    this.state = { isPlaying: false, currentTime: 0, rate: 1, updatedAt: Date.now() };
    this.lastSeen = this.state.updatedAt;
  }

  applyEvent(event) {
    if (event.type === 'play') this.state.isPlaying = true;
    if (event.type === 'pause') this.state.isPlaying = false;
    if (typeof event.currentTime === 'number') this.state.currentTime = event.currentTime;
    if (typeof event.rate === 'number') this.state.rate = event.rate;
    this.state.updatedAt = Date.now();
    this.lastSeen = this.state.updatedAt;
  }

  snapshot(now = Date.now()) {
    const state = { ...this.state };
    if (state.isPlaying && state.updatedAt > 0) {
      state.currentTime += (now - state.updatedAt) / 1000 * state.rate;
      state.updatedAt = now;
    }
    return state;
  }

  heartbeat(now = Date.now()) {
    if (!this.state.isPlaying || this.peers.size === 0) return;
    const state = this.snapshot(now);
    this.broadcast({
      type: 'sync',
      event: {
        type: 'heartbeat',
        currentTime: state.currentTime,
        rate: state.rate,
        ts: now,
      },
    });
  }

  broadcast(message, except = null) {
    const raw = JSON.stringify(message);
    for (const peer of this.peers) {
      if (peer !== except && peer.readyState === peer.OPEN) peer.send(raw);
    }
  }
}

function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function normalizeEvent(event) {
  if (!event || !EVENT_TYPES.has(event.type)) return null;
  if (!Number.isFinite(event.currentTime) || event.currentTime < 0 ||
      event.currentTime > MAX_VIDEO_TIME_S) return null;
  if (event.rate !== undefined &&
      (!Number.isFinite(event.rate) || event.rate <= 0 || event.rate > MAX_PLAYBACK_RATE)) return null;

  const normalized = {
    type: event.type,
    currentTime: event.currentTime,
  };
  if (event.rate !== undefined) normalized.rate = event.rate;
  if (Number.isFinite(event.ts)) normalized.ts = event.ts;
  return normalized;
}

export class RoomRegistry {
  constructor({ maxRooms = DEFAULT_MAX_ROOMS } = {}) {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    this.maxRooms = maxRooms;
  }

  create(video = null) {
    if (this.rooms.size >= this.maxRooms) return null;
    let code;
    do {
      code = randomCode(4);
    } while (this.rooms.has(code));
    const room = new Room(code, video);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return (typeof code === 'string' && this.rooms.get(code.toUpperCase())) || null;
  }

  size() {
    return this.rooms.size;
  }

  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const ttl = room.everJoined ? IDLE_ROOM_TTL_MS : UNJOINED_ROOM_TTL_MS;
      if (room.peers.size === 0 && now - room.lastSeen > ttl) {
        this.rooms.delete(code);
      }
    }
  }

  heartbeat(now = Date.now()) {
    for (const room of this.rooms.values()) room.heartbeat(now);
  }
}
