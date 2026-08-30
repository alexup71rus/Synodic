/** Комнаты: участники, видео, снапшот состояния просмотра и рассылка. */

import crypto from 'node:crypto';

const IDLE_ROOM_TTL_MS = 12 * 60 * 60 * 1000; // пустые комнаты прибираем через 12 ч
const EVENT_TYPES = new Set(['play', 'pause', 'seek', 'ratechange']);
const PROVIDERS = new Set(['youtube', 'rutube']);
// алфавит без регистра и похожих символов (0/O, 1/I/L): код можно
// вписывать в любом регистре и диктовать по телефону
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Нормализовать источник видео или null. */
export function normalizeVideo(video) {
  if (!video || typeof video !== 'object') return null;
  const { provider, videoId } = video;
  if (!PROVIDERS.has(provider)) return null;
  if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{5,64}$/.test(videoId)) return null;
  return { provider, videoId };
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
  }

  join(ws, maxPeers) {
    if (this.peers.size >= maxPeers) {
      ws.close(4000, 'room is full');
      return;
    }
    this.lastSeen = Date.now();
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
        const event = normalizeEvent(message.event);
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

function normalizeEvent(event) {  if (!event || !EVENT_TYPES.has(event.type)) return null;
  if (!Number.isFinite(event.currentTime) || event.currentTime < 0) return null;
  if (event.rate !== undefined &&
      (!Number.isFinite(event.rate) || event.rate <= 0)) return null;

  const normalized = {
    type: event.type,
    currentTime: event.currentTime,
  };
  if (event.rate !== undefined) normalized.rate = event.rate;
  if (Number.isFinite(event.ts)) normalized.ts = event.ts;
  return normalized;
}

export class RoomRegistry {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  create(video = null) {
    let code;
    do {
      code = randomCode(4);
    } while (this.rooms.has(code));
    const room = new Room(code, video);
    this.rooms.set(code, room);
    return room;
  }

  get(code) {
    return (typeof code === 'string' && this.rooms.get(code)) || null;
  }

  size() {
    return this.rooms.size;
  }

  sweep(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      if (room.peers.size === 0 && now - room.lastSeen > IDLE_ROOM_TTL_MS) {
        this.rooms.delete(code);
      }
    }
  }

  heartbeat(now = Date.now()) {
    for (const room of this.rooms.values()) room.heartbeat(now);
  }
}
