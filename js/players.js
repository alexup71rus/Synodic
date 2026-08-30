/**
 * Адаптеры embed-плееров: YouTube (IFrame API) и Rutube (postMessage API).
 *
 * Общий интерфейс адаптера:
 *   mount(host, source) → Promise  — вставить плеер, ждать готовности
 *   play() / pause() / seek(t) / setRate(r) / isPaused() / getTime()
 *   destroy()
 * Колбэки (назначает движок синхронизации):
 *   onLocal({ type: 'play'|'pause'|'seek'|'rate', time, rate })
 *   onTime(t)   — поток текущего времени (для контроля дрейфа)
 *   onError(message)
 *
 * Перемотку оба плеера отдают только потоком времени, поэтому детектор
 * разрывов общий: при играющем видео резкий скачок между соседними
 * замерами — это seek.
 */

const SynodicPlayers = (() => {
  /** Детектор перемоток по потоку времени. */
  function createTimeJumpDetector() {
    let lastT = null;
    let lastWall = 0;

    /** @returns {number|undefined} время перемотки, если она была */
    function sample(t, playing, rate = 1) {
      const wall = performance.now();
      const dtWall = (wall - lastWall) / 1000;
      let seeked;
      if (lastT !== null) {
        if (playing && dtWall < 2) {
          // играем и замеры плотные: нормальный прогресс за интервал
          // ≈ dtWall * rate; всё, что сильно больше — перемотка
          // (замороженное при буферизации время прогресса не даёт)
          if (Math.abs(t - lastT) > Math.max(1, 2.5 * dtWall * rate)) seeked = t;
        } else {
          // на паузе или после разрыва в замерах время стояло —
          // любой скачок больше секунды это перемотка
          if (Math.abs(t - lastT) > 1) seeked = t;
        }
      }
      lastT = t;
      lastWall = wall;
      return seeked;
    }

    return {
      sample,
      get lastT() {
        return lastT;
      },
    };
  }

  // ─── YouTube ────────────────────────────────────────────────────────

  let ytApiPromise = null;

  function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      if (window.YT?.Player) {
        resolve(window.YT);
        return;
      }
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previous?.();
        resolve(window.YT);
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => reject(new Error('Не удалось загрузить YouTube-плеер'));
      document.head.appendChild(script);
      setTimeout(() => {
        if (!window.YT?.Player) reject(new Error('YouTube-плеер не ответил'));
      }, 15000);
    }).catch((error) => {
      ytApiPromise = null; // можно попробовать снова
      throw error;
    });
    return ytApiPromise;
  }

  class YouTubeAdapter {
    constructor(source) {
      this.source = source;
      this.onLocal = () => {};
      this.onTime = () => {};
      this.onError = () => {};
      this.player = null;
      this.timer = null;
      this.jumps = createTimeJumpDetector();
      this.lastRate = 1;
      this.destroyed = false;
    }

    async mount(host) {
      const YT = await loadYouTubeApi();
      if (this.destroyed) return;

      const holder = document.createElement('div');
      holder.className = 'player-frame';
      host.appendChild(holder);

      this.player = new YT.Player(holder, {
        videoId: this.source.videoId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          start: Math.floor(this.source.startAt || 0),
        },
        events: {
          onReady: () => {
            this.player.getIframe()?.setAttribute(
              'allow',
              'autoplay; encrypted-media; picture-in-picture; fullscreen',
            );
            this.lastRate = this.player.getPlaybackRate() || 1;
            this.timer = setInterval(() => this.poll(), 300);
          },
          onStateChange: (event) => this.onStateChange(event.data),
          onPlaybackRateChange: (event) => {
            this.lastRate = event.data;
            this.onLocal({
              type: SynodicProtocol.EVENT_RATE,
              time: this.getTime(),
              rate: event.data,
            });
          },
          onError: () => this.onError('YouTube не смог проиграть это видео'),
        },
      });
    }

    onStateChange(state) {
      const time = this.getTime();
      const rate = this.lastRate;
      if (state === YT.PlayerState.PLAYING) {
        this.onLocal({ type: SynodicProtocol.EVENT_PLAY, time, rate });
      } else if (state === YT.PlayerState.PAUSED || state === YT.PlayerState.ENDED) {
        this.onLocal({ type: SynodicProtocol.EVENT_PAUSE, time, rate });
      }
      // BUFFERING и CUED молча пропускаем
    }

    poll() {
      if (this.destroyed || !this.player?.getCurrentTime) return;
      const time = this.player.getCurrentTime();
      if (!Number.isFinite(time)) return;
      this.onTime(time);
      const playing = this.player.getPlayerState() === YT.PlayerState.PLAYING;
      const seeked = this.jumps.sample(time, playing, this.lastRate);
      if (seeked !== undefined) {
        this.onLocal({ type: SynodicProtocol.EVENT_SEEK, time: seeked, rate: this.lastRate });
      }
    }

    play() { this.player?.playVideo(); }
    pause() { this.player?.pauseVideo(); }
    seek(t) { this.player?.seekTo(t, true); }
    setRate(r) { this.player?.setPlaybackRate(r); }

    isPaused() {
      return !this.player?.getPlayerState || this.player.getPlayerState() !== YT.PlayerState.PLAYING;
    }

    getTime() {
      const time = this.player?.getCurrentTime?.();
      return Number.isFinite(time) ? time : 0;
    }

    destroy() {
      this.destroyed = true;
      clearInterval(this.timer);
      try {
        this.player?.destroy();
      } catch {
        // плеер мог не успеть создаться
      }
    }
  }

  // ─── Rutube ─────────────────────────────────────────────────────────

  class RutubeAdapter {
    constructor(source) {
      this.source = source;
      this.onLocal = () => {};
      this.onTime = () => {};
      this.onError = () => {};
      this.iframe = null;
      this.lastState = 'idle';
      this.lastRate = 1;
      this.jumps = createTimeJumpDetector();
      this.destroyed = false;
      this.readyPromise = null;
      this._onMessage = (event) => this.handleMessage(event);
    }

    async mount(host) {
      const params = new URLSearchParams();
      if (this.source.p) params.set('p', this.source.p);
      if (this.source.startAt) params.set('t', String(Math.floor(this.source.startAt)));
      const query = params.toString();

      const iframe = document.createElement('iframe');
      iframe.className = 'player-frame';
      iframe.allow = 'autoplay; fullscreen; encrypted-media; clipboard-write';
      iframe.allowFullscreen = true;
      iframe.src = `https://rutube.ru/play/embed/${this.source.videoId}${query ? `?${query}` : ''}`;
      host.appendChild(iframe);
      this.iframe = iframe;

      this.readyPromise = new Promise((resolve, reject) => {
        this._resolveReady = resolve;
        setTimeout(() => reject(new Error('Rutube-плеер не ответил')), 20000);
      });
      window.addEventListener('message', this._onMessage);
      await this.readyPromise;
    }

    post(type, data = {}) {
      if (this.destroyed || !this.iframe?.contentWindow) return;
      this.iframe.contentWindow.postMessage(JSON.stringify({ type, data }), '*');
    }

    handleMessage(event) {
      if (this.destroyed || event.source !== this.iframe?.contentWindow) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message?.type) return;
      const payload = message.data || {};

      switch (message.type) {
        case 'player:ready':
        case 'player:init':
          this._resolveReady?.();
          break;
        case 'player:changeState':
          this.applyState(payload.state);
          break;
        case 'player:currentTime': {
          const time = Number(payload.time ?? payload.currentTime);
          if (!Number.isFinite(time)) return;
          this.onTime(time);
          const playing = this.lastState === 'playing';
          const seeked = this.jumps.sample(time, playing, this.lastRate);
          if (seeked !== undefined) {
            this.onLocal({ type: SynodicProtocol.EVENT_SEEK, time: seeked, rate: this.lastRate });
          }
          break;
        }
        case 'player:playbackSpeedChanged':
          this.lastRate = Number(payload.speed) || 1;
          this.onLocal({
            type: SynodicProtocol.EVENT_RATE,
            time: this.getTime(),
            rate: this.lastRate,
          });
          break;
        case 'player:error':
          this.onError(payload.message || 'Rutube не смог проиграть это видео');
          break;
        default:
          break;
      }
    }

    applyState(state) {
      this.lastState = state;
      const time = this.getTime();
      const rate = this.lastRate;
      if (state === 'playing') {
        this.onLocal({ type: SynodicProtocol.EVENT_PLAY, time, rate });
      } else if (state === 'pause' || state === 'paused' || state === 'completed') {
        this.onLocal({ type: SynodicProtocol.EVENT_PAUSE, time, rate });
      }
      // seeking / buffering пропускаем — перемотку поймает поток времени
    }

    play() { this.post('player:play'); }
    pause() { this.post('player:pause'); }
    seek(t) { this.post('player:setCurrentTime', { time: t }); }
    setRate(r) { this.post('player:setPlaybackSpeed', { speed: r }); }

    isPaused() {
      // buffering/seeking — не пауза: Rutube может «залипнуть» в них
      // и на играющем видео, не говоря уже о старте
      return this.lastState === 'pause' || this.lastState === 'paused' ||
        this.lastState === 'completed';
    }

    getTime() {
      return this.jumps.lastT ?? this.source.startAt ?? 0;
    }

    destroy() {
      this.destroyed = true;
      window.removeEventListener('message', this._onMessage);
      this.iframe?.remove();
    }
  }

  return {
    create(source) {
      if (source.provider === SynodicProtocol.PROVIDER_YOUTUBE) return new YouTubeAdapter(source);
      if (source.provider === SynodicProtocol.PROVIDER_RUTUBE) return new RutubeAdapter(source);
      throw new Error(`Неизвестный плеер: ${source.provider}`);
    },
  };
})();
