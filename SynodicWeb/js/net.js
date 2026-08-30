/**
 * Сетевой слой: создание комнаты через REST и WebSocket-соединение
 * с автоматическим переподключением (логика перенесена из service
 * worker'а расширения и упрощена под страницу).
 */

const SynodicNet = (() => {
  const CONNECT_TIMEOUT_MS = 10000;
  const KEEPALIVE_INTERVAL_MS = 20000;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 30000;

  /** POST /api/rooms → { code } */
  async function createRoom(video) {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video }),
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('Сервер не смог создать комнату');
    const data = await res.json();
    if (!data?.code) throw new Error('Сервер вернул комнату без кода');
    return data.code;
  }

  /** Получить публичный embed-hash VK Video без пользовательского токена. */
  async function resolveVkVideo(source) {
    const url = new URL('/api/vk-oembed', location.origin);
    url.searchParams.set('ownerId', source.ownerId);
    url.searchParams.set('videoId', source.videoId);
    const res = await fetch(url, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS) });
    if (res.status === 404) throw new Error('VK не разрешает встроить это видео');
    if (!res.ok) throw new Error('Не удалось получить VK-плеер — попробуйте ещё раз');
    const data = await res.json();
    if (!data?.hash) throw new Error('VK вернул плеер без доступа к видео');
    return data;
  }

  class RoomConnection {
    /** @param {string} code */
    constructor(code) {
      this.code = code;
      this.handlers = {
        joined: [], peer: [], peerReady: [], event: [], video: [],
        status: [], closed: [],
      };

      this.ws = null;
      this.joinedOnce = false;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.keepaliveTimer = null;
      this.stopped = false;

      this._open();
    }

    on(kind, handler) {
      this.handlers[kind]?.push(handler);
      return this;
    }

    _emit(kind, payload) {
      for (const handler of this.handlers[kind] || []) handler(payload);
    }

    get connected() {
      return this.ws?.readyState === WebSocket.OPEN;
    }

    send(message) {
      if (this.connected) this.ws.send(JSON.stringify(message));
    }

    sendEvent(event) {
      this.send({ type: SynodicProtocol.CLIENT_SYNC, event });
    }

    sendVideo(video) {
      this.send({ type: SynodicProtocol.CLIENT_VIDEO, video });
    }

    sendReady() {
      this.send({ type: SynodicProtocol.CLIENT_READY });
    }

    close() {
      this.stopped = true;
      clearTimeout(this.reconnectTimer);
      clearInterval(this.keepaliveTimer);
      if (this.ws) {
        try {
          this.ws.close(1000, 'left room');
        } catch {
          // уже закрыт
        }
      }
      this._emit('status', { connected: false, reconnecting: false });
    }

    _open() {
      if (this.stopped) return;

      const url = new URL(`/ws?room=${encodeURIComponent(this.code)}`, location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

      let socket;
      try {
        socket = new WebSocket(url);
      } catch {
        this._scheduleReconnect();
        return;
      }
      this.ws = socket;
      let joinedThisAttempt = false;

      const failTimer = setTimeout(() => {
        if (this.ws === socket && !joinedThisAttempt) {
          try {
            socket.close(4001, 'join timeout');
          } catch {
            // onclose продолжит восстановление
          }
        }
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (this.ws !== socket) return;
        clearInterval(this.keepaliveTimer);
        this.keepaliveTimer = setInterval(() => {
          if (this.ws !== socket || socket.readyState !== WebSocket.OPEN) return;
          try {
            socket.send(JSON.stringify({ type: SynodicProtocol.CLIENT_KEEPALIVE }));
          } catch {
            socket.close();
          }
        }, KEEPALIVE_INTERVAL_MS);
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === SynodicProtocol.SERVER_JOINED) {
          joinedThisAttempt = true;
          clearTimeout(failTimer);
        }
        this._handle(message);
      };

      socket.onclose = (event) => {
        if (this.ws !== socket) return;
        clearTimeout(failTimer);
        clearInterval(this.keepaliveTimer);
        this.ws = null;

        if (this.stopped) return;

        // комната исчезла (перезапуск сервера) — восстанавливаться нет смысла
        if (event.code === 4004) {
          this._emit('closed', { code: event.code });
          this._emit('status', { connected: false, reconnecting: false });
          return;
        }

        if (this.joinedOnce) {
          this._emit('peer', { online: false });
          this._emit('status', { connected: false, reconnecting: true });
          this._scheduleReconnect();
        } else {
          this._emit('closed', { code: event.code });
          this._emit('status', { connected: false, reconnecting: false });
        }
      };

      socket.onerror = () => {
        // onclose даст итоговый код и запустит reconnect при необходимости
      };
    }

    _handle(message) {
      switch (message.type) {
        case SynodicProtocol.SERVER_JOINED:
          this.joinedOnce = true;
          this.reconnectAttempt = 0;
          this._emit('status', { connected: true, reconnecting: false });
          this._emit('joined', message);
          break;
        case SynodicProtocol.SERVER_PEER_JOINED:
          this._emit('peer', { online: true });
          break;
        case SynodicProtocol.SERVER_PEER_LEFT:
          this._emit('peer', { online: false });
          break;
        case SynodicProtocol.SERVER_PEER_READY:
          this._emit('peerReady', {});
          break;
        case SynodicProtocol.SERVER_SYNC:
          this._emit('event', message.event);
          break;
        case SynodicProtocol.SERVER_VIDEO:
          this._emit('video', message.video);
          break;
        default:
          break;
      }
    }

    _scheduleReconnect() {
      if (this.stopped || this.ws || this.reconnectTimer) return;
      const delay = Math.min(
        RECONNECT_BASE_MS * (2 ** this.reconnectAttempt),
        RECONNECT_MAX_MS,
      );
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this._open();
      }, delay);
    }
  }

  return { createRoom, resolveVkVideo, RoomConnection };
})();
