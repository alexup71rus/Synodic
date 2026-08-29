/** Комнаты: участники, снапшот состояния просмотра и рассылка. */

import crypto from 'node:crypto';

const IDLE_ROOM_TTL_MS = 12 * 60 * 60 * 1000; // пустые комнаты прибираем через 12 ч

export class Room {
  constructor(code) {
    this.code = code;
    /** @type {Set<import('ws').WebSocket>} */
    this.peers = new Set();
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
    ws.send(JSON.stringify({ type: 'joined', code: this.code, state: this.state }));
    this.broadcast({ type: 'peer-joined', peers: this.peers.size }, ws);

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return; // мусорные кадры игнорируем
      }
      if (message.type === 'sync' && message.event) {
        this.applyEvent(message.event);
        this.broadcast(message, ws); // всем, кроме автора
      }
    });

    ws.on('close', () => {
      this.peers.delete(ws);
      this.lastSeen = Date.now();
      this.broadcast({ type: 'peer-left', peers: this.peers.size });
    });
  }

  applyEvent(event) {
    if (event.type === 'play') this.state.isPlaying = true;
    if (event.type === 'pause') this.state.isPlaying = false;
    if (typeof event.currentTime === 'number') this.state.currentTime = event.currentTime;
    if (typeof event.rate === 'number') this.state.rate = event.rate;
    this.state.updatedAt = Date.now();
    this.lastSeen = this.state.updatedAt;
  }

  broadcast(message, except = null) {
    const raw = JSON.stringify(message);
    for (const peer of this.peers) {
      if (peer !== except && peer.readyState === peer.OPEN) peer.send(raw);
    }
  }
}

export class RoomRegistry {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  create() {
    let code;
    do {
      code = crypto.randomBytes(3).toString('base64url'); // 4 символа
    } while (this.rooms.has(code));
    const room = new Room(code);
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
}
