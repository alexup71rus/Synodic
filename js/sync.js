/**
 * Движок синхронизации: связывает плеер-адаптер с комнатой.
 *
 * Обязанности:
 *  - локальные события плеера → на сервер (кроме эха от применённых команд);
 *  - события напарника → команды плееру с защитой от эха;
 *  - экстраполяция «ожидаемого» времени и периодическая коррекция дрейфа;
 *  - «готовность»: пока пользователь не нажал кнопку, play не применяем
 *    (нужен жест для autoplay), но запоминаем намерение.
 *
 * Логика перенесена из content-скрипта расширения и адаптирована
 * под embed-плееры.
 */

const SynodicSync = (() => {
  const SEEK_EPSILON_S = 0.3;       // порог для явных play / pause / seek
  const HEARTBEAT_EPSILON_S = 0.5;  // heartbeat не дёргает видео при малом дрейфе
  const ECHO_GUARD_MS = 1500;
  const DRIFT_CHECK_MS = 3000;
  const DRIFT_LIMIT_S = 0.75;
  const DRIFT_SAMPLE_FRESH_MS = 1600;

  class SyncEngine {
    /** @param {SynodicNet.RoomConnection} connection */
    constructor(connection) {
      this.connection = connection;
      this.adapter = null;
      this.armed = false;

      // ожидаемое состояние просмотра — экстраполируется от последнего события
      this.expected = { playing: false, time: 0, rate: 1, at: performance.now() };
      this.lastRate = 1;

      // свежий замер локального времени (для контроля дрейфа)
      this.localSample = { time: 0, at: 0 };

      this.pendingPlay = false;
      this.guards = new Map();
      this.seekGen = 0;        // поколение команд seek — ретраи отменяются новее
      this.lastUserActionAt = 0; // последнее настоящее (не эхо) локальное событие
      this.driftTimer = setInterval(() => this.checkDrift(), DRIFT_CHECK_MS);

      // колбэки для UI
      this.onPendingPlay = () => {};
      this.onLocalApplied = () => {};
    }

    setAdapter(adapter) {
      this.adapter = adapter;
      adapter.onLocal = (event) => this.handleLocal(event);
      adapter.onTime = (t) => {
        this.localSample = { time: t, at: performance.now() };
      };
    }

    /** Пользователь подтвердил готовность (жест есть — autoplay разрешён). */
    arm() {
      this.armed = true;
      this.reconcile();
    }

    /** Согласовать плеер с ожидаемым состоянием комнаты (вход / кнопка). */
    reconcile() {
      if (!this.adapter) return;
      const { playing, time, rate } = this.expectedNow();

      if (Math.abs(this.lastRate - rate) > 0.001) this.commandRate(rate);
      if (Math.abs(this.adapter.getTime() - time) > SEEK_EPSILON_S) this.commandSeek(time, time);
      if (playing && this.adapter.isPaused()) {
        this.commandPlay();
      } else if (!playing && !this.adapter.isPaused()) {
        this.commandPause();
      }
      this.pendingPlay = false;
    }

    /** Снапшот от сервера (при входе в комнату / реконнекте). */
    applySnapshot(state) {
      if (!state) return;
      this.expected = {
        playing: !!state.isPlaying,
        time: Number(state.currentTime) || 0,
        rate: Number(state.rate) || 1,
        at: performance.now(),
      };
      this.lastRate = this.expected.rate;
      if (this.expected.playing && !this.armed) this.pendingPlay = true;
      this.reconcile();
    }

    handleLocal(event) {
      if (this.consumeEcho(event.type, event)) return;
      this.lastUserActionAt = Date.now();

      // обновляем ожидаемое состояние собственным событием
      const playing = event.type === SynodicProtocol.EVENT_PLAY ||
        (event.type !== SynodicProtocol.EVENT_PAUSE && this.expected.playing);
      this.expected = {
        playing,
        time: Number.isFinite(event.time) ? event.time : this.expected.time,
        rate: event.rate || this.lastRate,
        at: performance.now(),
      };
      if (event.rate) this.lastRate = event.rate;

      this.connection.sendEvent({
        type: event.type,
        currentTime: this.expected.time,
        rate: this.lastRate,
        ts: Date.now(),
      });
      this.pendingPlay = false;
    }

    /** Событие от напарника (или heartbeat сервера). */
    handleRemote(event) {
      if (!event || !this.adapter) return;

      if (Number.isFinite(event.rate) && event.rate > 0 &&
          Math.abs(this.lastRate - event.rate) > 0.001) {
        this.lastRate = event.rate;
        this.commandRate(event.rate);
      }

      const epsilon = event.type === SynodicProtocol.EVENT_HEARTBEAT
        ? HEARTBEAT_EPSILON_S
        : SEEK_EPSILON_S;
      if (Number.isFinite(event.currentTime) && event.currentTime >= 0 &&
          Math.abs(this.adapter.getTime() - event.currentTime) > epsilon) {
        this.commandSeek(event.currentTime, event.currentTime);
      }

      if (event.type === SynodicProtocol.EVENT_PAUSE && !this.adapter.isPaused()) {
        this.commandPause();
      }
      if (event.type === SynodicProtocol.EVENT_PLAY && this.adapter.isPaused()) {
        if (this.armed) this.commandPlay();
        else {
          this.pendingPlay = true;
          this.onPendingPlay();
        }
      }
      // heartbeat-воскрешение: фоновая вкладка может молча поставить паузу
      // (без события pause) — комната «играет», значит продолжаем
      if (event.type === SynodicProtocol.EVENT_HEARTBEAT &&
          this.expected.playing && this.adapter.isPaused()) {
        if (this.armed) this.commandPlay();
        else {
          this.pendingPlay = true;
          this.onPendingPlay();
        }
      }

      // обновляем ожидаемое состояние
      this.applyExpectedFromRemote(event);
    }

    applyExpectedFromRemote(event) {
      let playing = this.expected.playing;
      if (event.type === SynodicProtocol.EVENT_PLAY) playing = true;
      else if (event.type === SynodicProtocol.EVENT_PAUSE) playing = false;

      this.expected = {
        playing,
        time: Number.isFinite(event.currentTime) ? event.currentTime : this.expected.time,
        rate: Number.isFinite(event.rate) ? event.rate : this.expected.rate,
        at: performance.now(),
      };
    }

    expectedNow() {
      const elapsed = (performance.now() - this.expected.at) / 1000;
      return {
        playing: this.expected.playing,
        time: this.expected.playing ? this.expected.time + elapsed * this.expected.rate : this.expected.time,
        rate: this.expected.rate,
      };
    }

    checkDrift() {
      if (!this.adapter || !this.expected.playing || this.adapter.isPaused()) return;
      const sampleAge = performance.now() - this.localSample.at;
      if (sampleAge > DRIFT_SAMPLE_FRESH_MS) return; // замер несвежий — не корректируем

      const diff = this.localSample.time - this.expectedNow().time;
      if (Math.abs(diff) > DRIFT_LIMIT_S) {
        this.commandSeek(this.expectedNow().time, this.expectedNow().time);
      }
    }

    // ─── команды плееру с установкой эхо-защиты ──────────────────────

    commandPlay() {
      this.expectEcho(SynodicProtocol.EVENT_PLAY, () => true);
      this.adapter.play();
    }

    commandPause() {
      this.expectEcho(SynodicProtocol.EVENT_PAUSE, () => true);
      this.adapter.pause();
    }

    commandSeek(target, echoTarget) {
      this.seekGen += 1;
      const gen = this.seekGen;
      const startedAt = Date.now();
      this.expectEcho(SynodicProtocol.EVENT_SEEK, (event) =>
        Math.abs(event.time - echoTarget) <= 0.75);
      this.adapter.seek(target);
      // embed-плеер может молча проглотить seek сразу после загрузки —
      // добиваем повторами, пока позиция не доехала
      this.retrySeek(gen, startedAt, target, echoTarget, 5);
    }

    retrySeek(gen, startedAt, target, echoTarget, attemptsLeft) {
      setTimeout(() => {
        if (!this.adapter || this.seekGen !== gen) return; // уже неактуально
        if (this.lastUserActionAt > startedAt) return;      // пользователь успел вмешаться
        if (Math.abs(this.adapter.getTime() - target) <= 1.5) return; // доехало
        if (attemptsLeft <= 0) return;
        this.expectEcho(SynodicProtocol.EVENT_SEEK, (event) =>
          Math.abs(event.time - echoTarget) <= 0.75);
        this.adapter.seek(target);
        this.retrySeek(gen, startedAt, target, echoTarget, attemptsLeft - 1);
      }, 900);
    }

    commandRate(rate) {
      this.expectEcho(SynodicProtocol.EVENT_RATE, (event) =>
        Math.abs(event.rate - rate) <= 0.001);
      this.adapter.setRate(rate);
      this.lastRate = rate;
    }

    // ─── эхо-защита (окно после применённой команды) ─────────────────

    expectEcho(type, matches) {
      const guards = this.guards.get(type) || [];
      guards.push({ expiresAt: Date.now() + ECHO_GUARD_MS, matches });
      this.guards.set(type, guards);
    }

    consumeEcho(type, event) {
      const now = Date.now();
      const guards = (this.guards.get(type) || []).filter((guard) => guard.expiresAt > now);
      const index = guards.findIndex((guard) => guard.matches(event));

      if (index === -1) {
        if (guards.length) this.guards.set(type, guards);
        else this.guards.delete(type);
        return false;
      }

      guards.splice(index, 1);
      if (guards.length) this.guards.set(type, guards);
      else this.guards.delete(type);
      return true;
    }

    destroy() {
      clearInterval(this.driftTimer);
    }
  }

  return { SyncEngine };
})();
