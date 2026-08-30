/**
 * UI-логика сайта: стартовый экран, комната, плеер и оверлей готовности.
 */

(() => {
  const $ = (id) => document.getElementById(id);

  const elements = {
    connection: $('connection'),
    connectionLabel: $('connection-label'),
    info: $('info'),
    infoModal: $('info-modal'),
    infoClose: $('info-close'),
    startView: $('start-view'),
    posters: $('posters'),
    roomView: $('room-view'),
    videoUrl: $('video-url'),
    createForm: $('create-form'),
    create: $('create'),
    code: $('code'),
    joinForm: $('join-form'),
    roomCode: $('room-code'),
    copy: $('copy'),
    peerPill: $('peer-pill'),
    leave: $('leave'),
    playerHost: $('player-host'),
    armOverlay: $('arm-overlay'),
    armTitle: $('arm-title'),
    armText: $('arm-text'),
    arm: $('arm'),
    changeVideoToggle: $('change-video-toggle'),
    changeVideoForm: $('change-video-form'),
    newVideoUrl: $('new-video-url'),
    feedback: $('feedback'),
  };

  const SESSION_KEY = 'synodic-room';

  let connection = null;
  let engine = null;
  let adapter = null;
  let armed = false;
  let peerOnline = false;
  let peerReady = false;
  let feedbackTimer = null;

  init();

  function init() {
    // отладочный доступ из консоли и автотестов
    window.__synodic = {
      get state() {
        return {
          code: elements.roomCode.textContent,
          armed,
          peerOnline,
          peerReady,
          adapterTime: adapter ? adapter.getTime() : null,
          adapterPaused: adapter ? adapter.isPaused() : null,
          expected: engine ? engine.expectedNow() : null,
        };
      },
      debug: {
        play() { engine?.commandPlay(); },
        pause() { engine?.commandPause(); },
        seek(t) { engine?.commandSeek(t, t); },
      },
    };

    elements.createForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runBusy('Создаём комнату…', async () => {
        const { source, message } = SynodicLinks.diagnose(elements.videoUrl.value);
        if (!source) throw new Error(message);
        const code = await SynodicNet.createRoom({
          provider: source.provider,
          videoId: source.videoId,
        });
        openRoom(code, source);
      });
    });

    elements.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      runBusy('Подключаемся…', async () => {
        const code = normalizedCode();
        if (code.length !== 4) throw new Error('Введите код из четырёх символов');
        openRoom(code, null);
      });
    });

    elements.code.addEventListener('input', () => {
      const normalized = elements.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (elements.code.value !== normalized) elements.code.value = normalized;
      clearFeedback();
    });

    elements.leave.addEventListener('click', leaveRoom);
    elements.copy.addEventListener('click', copyInvite);
    elements.arm.addEventListener('click', armViewing);
    elements.videoUrl.addEventListener('input', clearFeedback);

    elements.changeVideoToggle.addEventListener('click', () => {
      const hidden = elements.changeVideoForm.hidden;
      elements.changeVideoForm.hidden = !hidden;
      if (hidden) elements.newVideoUrl.focus();
    });
    elements.changeVideoForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const { source, message } = SynodicLinks.diagnose(elements.newVideoUrl.value);
      if (!source) {
        showError(message);
        return;
      }
      connection?.sendVideo({ provider: source.provider, videoId: source.videoId });
      elements.changeVideoForm.hidden = true;
      elements.newVideoUrl.value = '';
      applyVideoChange(source, { local: true });
      showFeedback('Включаем новое видео', 'success');
    });

    elements.info.addEventListener('click', () => elements.infoModal.showModal());
    elements.infoClose.addEventListener('click', () => elements.infoModal.close());
    elements.infoModal.addEventListener('click', (event) => {
      if (event.target === elements.infoModal) elements.infoModal.close();
    });

    loadPosters();
    restoreSession();
  }

  // ─── комната ────────────────────────────────────────────────────────

  function openRoom(code, knownSource) {
    closeRoom({ quiet: true });
    sessionStorage.setItem(SESSION_KEY, code);

    connection = new SynodicNet.RoomConnection(code);
    engine = new SynodicSync.SyncEngine(connection);
    engine.onPendingPlay = showPendingPlay;

    let mountedForVideo = null; // source, по которому смонтирован плеер

    connection.on('status', ({ connected, reconnecting }) => {
      elements.connection.hidden = false;
      if (connected) {
        setConnection('online');
        updatePeerPill(peerOnline ? 'together' : 'waiting');
      } else if (reconnecting) {
        setConnection('error', 'Нет связи');
        updatePeerPill('lost');
      }
    });

    connection.on('joined', async (message) => {
      elements.roomCode.textContent = message.code;
      elements.code.value = message.code;
      showRoomView();

      // если напарник уже в комнате, peer-joined нам не придёт
      if (Number(message.peers) > 1) {
        peerOnline = true;
        elements.copy.hidden = true;
        updatePeerPill('together');
      }

      const source = knownSource || message.video;
      if (!source?.videoId) {
        showPlayerPlaceholder('Напарник ещё не выбрал видео — оно появится здесь само.');
        return;
      }
      if (mountedForVideo?.videoId !== source.videoId) {
        mountedForVideo = source;
        await mountPlayer(source);
      }
      engine.applySnapshot(message.state);
    });

    connection.on('peer', ({ online }) => {
      peerOnline = online;
      elements.copy.hidden = online;
      if (online) updatePeerPill('together');
      else {
        peerReady = false;
        updatePeerPill('waiting');
      }
    });

    connection.on('peerReady', () => {
      if (!peerOnline) return;
      peerReady = true;
      if (armed) maybeStartTogether();
      else showFeedback('Второй готов — нажмите «Смотреть вместе»', 'success');
    });

    connection.on('event', (event) => engine.handleRemote(event));

    connection.on('video', (video) => {
      if (!video?.videoId) return;
      mountedForVideo = video;
      applyVideoChange(video, { local: false });
    });

    connection.on('closed', ({ code: closeCode }) => {
      if (closeCode === 4000) showError('Комната заполнена — в ней уже двое');
      else if (closeCode === 4004) showError('Комната не найдена — возможно, сервер перезапускался');
      leaveRoom({ quiet: true });
    });
  }

  async function mountPlayer(source) {
    destroyAdapter();
    clearPlayerHost();

    try {
      adapter = SynodicPlayers.create(source);
      adapter.onError = (message) => showError(message);
      await adapter.mount(elements.playerHost);
      engine.setAdapter(adapter);
      if (!armed) showArmOverlay(false);
      else elements.armOverlay.hidden = true;
    } catch (error) {
      showPlayerPlaceholder('Плеер не загрузился. Проверьте ссылку и попробуйте сменить видео.');
      showError(error.message);
    }
  }

  function applyVideoChange(source, { local }) {
    engine.expected = { playing: false, time: 0, rate: 1, at: performance.now() };
    engine.lastRate = 1;
    engine.pendingPlay = false;
    mountPlayer(source);
    if (!local) showFeedback('Напарник сменил видео — включаем новое', 'success');
  }

  function armViewing() {
    armed = true;
    elements.armOverlay.hidden = true;
    connection?.sendReady();
    engine?.arm();
    maybeStartTogether();
  }

  /**
   * Одновременный старт: когда оба нажали «Смотреть вместе», а видео ещё
   * не начали, — запускаем у себя; событие play уедет напарнику
   * (задержка ≈ полпинга, у нас выходило 20–90 мс).
   */
  function maybeStartTogether() {
    if (!armed || !peerReady || !adapter || !engine) return;
    if (engine.expectedNow().playing) return; // уже смотрим
    engine.startTogether();
  }

  function leaveRoom({ quiet } = {}) {
    closeRoom({ quiet });
    sessionStorage.removeItem(SESSION_KEY);
    showStartView();
    if (!quiet) clearFeedback();
  }

  function closeRoom() {
    engine?.destroy();
    engine = null;
    destroyAdapter();
    connection?.close();
    connection = null;
    armed = false;
    peerOnline = false;
    peerReady = false;
    elements.copy.hidden = false;
    elements.armOverlay.hidden = true;
  }

  function destroyAdapter() {
    try {
      adapter?.destroy();
    } catch {
      // плеер мог не успеть создаться
    }
    adapter = null;
  }

  function clearPlayerHost() {
    elements.playerHost.replaceChildren();
  }

  function showPlayerPlaceholder(text) {
    clearPlayerHost();
    const div = document.createElement('div');
    div.className = 'player-empty';
    div.textContent = text;
    elements.playerHost.appendChild(div);
  }

  function showArmOverlay(urgent) {
    elements.armOverlay.hidden = false;
    elements.armOverlay.classList.toggle('urgent', !!urgent);
    if (urgent) {
      elements.armTitle.textContent = 'Второй уже смотрит';
      elements.armText.textContent = 'Нажмите — продолжим с той же секунды.';
    } else {
      elements.armTitle.textContent = 'Всё готово';
      elements.armText.textContent = 'Когда оба нажмут — начнём одновременно.';
    }
  }

  function showPendingPlay() {
    if (!armed) showArmOverlay(true);
  }

  // ─── витрина постеров (необязательная) ──────────────────────────────

  /** Появляется, только если серверу выдали TMDB_TOKEN; иначе тихо молчим. */
  async function loadPosters() {
    try {
      const res = await fetch('/api/posters');
      if (!res.ok) return;
      const { items } = await res.json();
      if (!Array.isArray(items) || items.length === 0) return;

      const strip = document.createElement('div');
      strip.className = 'posters-strip';
      strip.setAttribute('aria-hidden', 'true');
      for (const item of items) {
        const img = document.createElement('img');
        img.src = item.poster;
        img.alt = '';
        img.title = item.title || '';
        img.referrerPolicy = 'no-referrer';
        strip.appendChild(img);
      }
      const note = document.createElement('p');
      note.className = 'posters-note';
      note.textContent = 'В топе на этой неделе · по данным TMDB';
      elements.posters.replaceChildren(strip, note);
      elements.posters.hidden = false;
    } catch {
      // витрина — украшение: без неё стартовый экран просто чище
    }
  }

  // ─── восстановление сессии ──────────────────────────────────────────

  function restoreSession() {
    const params = new URLSearchParams(location.search);
    const fromLink = params.get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
    const saved = sessionStorage.getItem(SESSION_KEY) || '';
    const code = fromLink || saved;
    if (!code || code.length !== 4) return;

    if (fromLink) {
      params.delete('room');
      const query = params.toString();
      history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
    }
    openRoom(code, null);
  }

  // ─── мелкие помощники UI ───────────────────────────────────────────

  function showRoomView() {
    elements.startView.hidden = true;
    elements.roomView.hidden = false;
  }

  function showStartView() {
    elements.roomView.hidden = true;
    elements.startView.hidden = false;
    elements.connection.hidden = true;
    elements.videoUrl.value = '';
    elements.code.value = '';
    clearPlayerHost();
  }

  function setConnection(tone, label = '') {
    elements.connection.dataset.tone = tone;
    elements.connectionLabel.textContent = label;
    elements.connection.title = label ||
      (tone === 'online' ? 'Связь с сервером установлена' : '');
  }

  const PEER_TITLES = {
    waiting: 'Ждём второго участника',
    together: 'Оба на месте',
    lost: 'Нет связи — переподключаемся',
  };

  /** Баббл «1 → 1+1»: второй пузырь упруго приклеивается, тултип поясняет. */
  function updatePeerPill(state) {
    const wasWaiting = elements.peerPill.dataset.state === 'waiting';
    elements.peerPill.dataset.state = state;
    elements.peerPill.title = PEER_TITLES[state];
    elements.peerPill.setAttribute('aria-label', PEER_TITLES[state]);
    if (state !== 'waiting' && wasWaiting) {
      elements.peerPill.classList.remove('pop');
      void elements.peerPill.offsetWidth; // перезапуск анимации склеивания
      elements.peerPill.classList.add('pop');
    }
  }

  function normalizedCode() {
    return elements.code.value.trim().toUpperCase();
  }

  async function copyInvite() {
    const code = elements.roomCode.textContent?.trim();
    if (!code || code === '····') return;
    const link = `${location.origin}${location.pathname}?room=${code}`;
    try {
      await navigator.clipboard.writeText(link);
      showFeedback('Ссылка скопирована — отправьте её напарнику', 'success');
    } catch {
      showError(`Не удалось скопировать. Ссылка: ${link}`);
    }
  }

  async function runBusy(progressText, action) {
    clearFeedback();
    setBusy(true);
    if (progressText) showFeedback(progressText, 'success', false);
    let succeeded = false;
    try {
      await action();
      succeeded = true;
    } catch (error) {
      showError(error.message);
    } finally {
      setBusy(false);
      if (succeeded) clearFeedback();
    }
  }

  function setBusy(busy) {
    document.querySelectorAll('#start-view button, #start-view input').forEach((element) => {
      element.disabled = busy;
    });
  }

  function showError(text) {
    showFeedback(text, 'error', false);
  }

  function showFeedback(text, tone = 'error', autoHide = true) {
    clearTimeout(feedbackTimer);
    elements.feedback.textContent = text;
    elements.feedback.dataset.tone = tone;
    elements.feedback.hidden = false;
    if (autoHide) feedbackTimer = setTimeout(clearFeedback, 3200);
  }

  function clearFeedback() {
    clearTimeout(feedbackTimer);
    elements.feedback.hidden = true;
    elements.feedback.textContent = '';
  }
})();
