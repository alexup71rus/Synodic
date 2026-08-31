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
    tmdbCredit: $('tmdb-credit'),
    startView: $('start-view'),
    posters: $('posters'),
    roomView: $('room-view'),
    videoUrl: $('video-url'),
    createForm: $('create-form'),
    create: $('create'),
    code: $('code'),
    joinDisclosure: $('join-disclosure'),
    joinToggle: $('join-toggle'),
    joinForm: $('join-form'),
    join: $('join'),
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
    createFeedback: $('create-feedback'),
    joinFeedback: $('join-feedback'),
    feedback: $('feedback'),
  };

  const SESSION_KEY = 'synodic-room';
  const peerPillRenderer = SynodicPeerPill.create(elements.peerPill);

  let connection = null;
  let engine = null;
  let adapter = null;
  let armed = false;
  let peerOnline = false;
  let peerReady = false;
  let feedbackTimer = null;
  let copyResetTimer = null;
  let infoCloseTimer = null;
  let hoverOpenTimer = null;
  let viewportFrame = null;
  let viewportSettleTimer = null;
  const canHover = matchMedia('(hover: hover)').matches;

  init();

  function init() {
    initViewport();

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
        const code = await SynodicNet.createRoom(source);
        await openRoom(code, source);
      });
    });

    elements.joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitJoin();
    });

    elements.joinToggle.addEventListener('click', (event) => {
      event.preventDefault();
      clearTimeout(hoverOpenTimer);
      if (joinBusy()) return;
      if (elements.joinDisclosure.classList.contains('is-visible')) {
        closeJoinDisclosure();
        // осознанный клик при открытом поповере — назад к вводу ссылки
        elements.videoUrl.focus();
      } else {
        openJoinDisclosure();
      }
    });
    // задержка над «Войти по коду» на 300 мс — то же, что клик:
    // поповер открывается, фокус уходит в поле кода
    elements.joinToggle.addEventListener('mouseenter', () => {
      if (!canHover || joinBusy()) return;
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = setTimeout(() => {
        if (!elements.joinDisclosure.classList.contains('is-visible')) {
          openJoinDisclosure();
        }
      }, 300);
    });
    elements.joinToggle.addEventListener('mouseleave', () => clearTimeout(hoverOpenTimer));
    // клик мимо поповера — закрыть его
    document.addEventListener('click', (event) => {
      if (!elements.joinDisclosure.classList.contains('is-visible')) return;
      if (joinBusy() || elements.joinDisclosure.contains(event.target)) return;
      closeJoinDisclosure();
    });
    elements.joinForm.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (joinBusy()) return;
      closeJoinDisclosure();
      elements.joinToggle.focus();
    });

    elements.code.addEventListener('input', () => {
      const normalized = elements.code.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (elements.code.value !== normalized) elements.code.value = normalized;
      clearJoinNote();
      // четвёртый символ — код полный, можно входить без лишнего клика
      if (normalized.length === 4) submitJoin();
    });

    elements.leave.addEventListener('click', leaveRoom);
    elements.copy.addEventListener('click', copyInvite);
    elements.arm.addEventListener('click', armViewing);
    elements.arm.addEventListener('mouseenter', () => {
      SynodicSpotlight?.anticipateViewing(true);
    });
    elements.arm.addEventListener('mouseleave', () => {
      SynodicSpotlight?.anticipateViewing(false);
    });
    elements.arm.addEventListener('focus', () => {
      SynodicSpotlight?.anticipateViewing(true);
    });
    elements.arm.addEventListener('blur', () => {
      SynodicSpotlight?.anticipateViewing(false);
    });
    elements.videoUrl.addEventListener('input', clearCreateNote);

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
      connection?.sendVideo(source);
      elements.changeVideoForm.hidden = true;
      elements.newVideoUrl.value = '';
      applyVideoChange(source, { local: true });
      showFeedback('Включаем новое видео', 'success');
    });

    elements.info.addEventListener('click', openInfo);
    elements.infoClose.addEventListener('click', closeInfo);
    elements.infoModal.addEventListener('click', (event) => {
      if (event.target !== elements.infoModal) return;
      const bounds = elements.infoModal.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) closeInfo();
    });
    elements.infoModal.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeInfo();
    });

    loadPosters();
    restoreSession();
  }

  /**
   * Safari оставляет layout viewport прежней высоты, когда поднимается
   * клавиатура. VisualViewport даёт действительно видимую часть страницы.
   */
  function initViewport() {
    const viewport = window.visualViewport;

    const update = () => {
      cancelAnimationFrame(viewportFrame);
      viewportFrame = requestAnimationFrame(() => {
        const normalScale = !viewport || Math.abs(viewport.scale - 1) < 0.02;
        const visibleHeight = normalScale && viewport ? viewport.height : window.innerHeight;
        const keyboardOpen = !!viewport && normalScale && window.innerHeight - viewport.height > 120;

        document.documentElement.style.setProperty('--app-height', `${Math.round(visibleHeight)}px`);
        document.documentElement.dataset.keyboard = String(keyboardOpen);

        clearTimeout(viewportSettleTimer);
        if (!keyboardOpen || !(document.activeElement instanceof HTMLInputElement)) return;
        viewportSettleTimer = setTimeout(() => {
          document.activeElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
        }, 120);
      });
    };

    update();
    window.addEventListener('resize', update, { passive: true });
    viewport?.addEventListener('resize', update, { passive: true });
  }

  // ─── комната ────────────────────────────────────────────────────────

  /**
   * Открывает комнату. Возвращает промис: resolve — пришёл `joined`,
   * reject — первое подключение не удалось (4000/4004/таймаут/сеть),
   * причём показ ошибки остаётся на вызывающем: вход по коду выводит её
   * в поповер, создание и восстановление — заметкой над формой.
   */
  function openRoom(code, knownSource, { viaJoin = false } = {}) {
    closeRoom({ quiet: true });
    sessionStorage.setItem(SESSION_KEY, code);

    connection = new SynodicNet.RoomConnection(code);
    engine = new SynodicSync.SyncEngine(connection);
    engine.onPendingPlay = showPendingPlay;
    engine.onLocalApplied = updateTheaterLight;

    let mountedForVideoKey = null;
    let joined = false;

    return new Promise((resolve, reject) => {
      connection.on('status', ({ connected, reconnecting }) => {
        if (connected) {
          elements.connection.hidden = true;
          setConnection('online');
          updatePeerPill(peerOnline ? 'together' : 'waiting');
        } else if (reconnecting) {
          elements.connection.hidden = false;
          setConnection('error', 'Нет связи');
          updatePeerPill('lost');
        }
      });

      connection.on('joined', async (message) => {
        joined = true;
        elements.roomCode.textContent = message.code;
        updateCopyLabel(message.code);
        elements.code.value = message.code;
        showRoomView();

        // если напарник уже в комнате, peer-joined нам не придёт
        if (Number(message.peers) > 1) {
          peerOnline = true;
          updatePeerPill('together');
        }

        resolve();

        const source = knownSource || message.video;
        if (!source?.videoId) {
          showPlayerPlaceholder('Напарник ещё не выбрал видео — оно появится здесь само.');
          return;
        }
        const key = sourceKey(source);
        if (mountedForVideoKey !== key) {
          mountedForVideoKey = key;
          await mountPlayer(source);
        }
        engine.applySnapshot(message.state);
        SynodicSpotlight?.setPlaying(armed && !!message.state?.isPlaying);
      });

      connection.on('peer', ({ online }) => {
        peerOnline = online;
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

      connection.on('event', (event) => {
        engine.handleRemote(event);
        updateTheaterLight(event);
      });

      connection.on('video', (video) => {
        if (!video?.videoId) return;
        mountedForVideoKey = sourceKey(video);
        applyVideoChange(video, { local: false });
      });

      connection.on('closed', ({ code: closeCode }) => {
        const message = closeFailureMessage(closeCode, viaJoin);
        if (joined) {
          // комната была открыта и исчезла (перезапуск сервера)
          leaveRoom({ quiet: true });
          showError(message);
        } else if (viaJoin) {
          // поповер входа остаётся на месте — только подключение снесли
          closeRoom();
          sessionStorage.removeItem(SESSION_KEY);
        } else {
          leaveRoom({ quiet: true });
        }
        reject(new Error(message));
      });
    });
  }

  function closeFailureMessage(closeCode, viaJoin) {
    if (closeCode === 4000) return 'Комната заполнена — в ней уже двое';
    if (closeCode === 4004) {
      return viaJoin
        ? 'Комната не найдена — проверьте код'
        : 'Комната не найдена — возможно, сервер перезапускался';
    }
    return 'Не удалось подключиться — попробуйте ещё раз';
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
    SynodicSpotlight?.setPlaying(false);
    mountPlayer(source);
    if (!local) showFeedback('Напарник сменил видео — включаем новое', 'success');
  }

  function armViewing() {
    armed = true;
    elements.armOverlay.hidden = true;
    SynodicSpotlight?.commitViewing();
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
    clearTimeout(copyResetTimer);
    delete elements.copy.dataset.copied;
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
      elements.posters.replaceChildren(strip);
      elements.posters.hidden = false;
      elements.tmdbCredit.hidden = false;
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
    openRoom(code, null).catch((error) => showError(error.message));
  }

  // ─── мелкие помощники UI ───────────────────────────────────────────

  function showRoomView() {
    elements.startView.hidden = true;
    elements.roomView.hidden = false;
    SynodicSpotlight?.enterRoom();
  }

  function showStartView() {
    SynodicSpotlight?.leaveRoom();
    elements.roomView.hidden = true;
    elements.startView.hidden = false;
    elements.connection.hidden = true;
    elements.videoUrl.value = '';
    elements.code.value = '';
    closeJoinDisclosure();
    clearPlayerHost();
  }

  function openJoinDisclosure() {
    elements.joinDisclosure.classList.add('is-visible');
    elements.joinToggle.setAttribute('aria-expanded', 'true');
    // сразу в поле: на телефоне поднимется клавиатура, на десктопе — каретка
    elements.code.focus();
  }

  /**
   * Подключение по коду в полёте: поповер нельзя закрыть (клик мимо,
   * Escape, тогл), иначе ошибку входа будет некому показать.
   */
  function joinBusy() {
    return elements.code.disabled;
  }

  function closeJoinDisclosure() {
    elements.joinDisclosure.classList.remove('is-visible');
    elements.joinToggle.setAttribute('aria-expanded', 'false');
    clearJoinNote();
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

  /** Canvas-пилюля: один участник, мягкое раскрытие 1 + 1 или потеря связи. */
  function updatePeerPill(state) {
    peerPillRenderer.setState(state);
    elements.peerPill.title = PEER_TITLES[state];
    elements.peerPill.setAttribute('aria-label', PEER_TITLES[state]);
  }

  function updateTheaterLight(event) {
    if (event?.type === SynodicProtocol.EVENT_PAUSE) {
      SynodicSpotlight?.setPlaying(false);
    } else if (event?.type === SynodicProtocol.EVENT_PLAY && armed) {
      SynodicSpotlight?.setPlaying(true);
    }
  }

  function normalizedCode() {
    return elements.code.value.trim().toUpperCase();
  }

  /**
   * Вход по коду: вручную (кнопка ⏎ / Enter) или автоматически, когда
   * набран четвёртый символ. Поповер не закрывается — ошибка покажется
   * в нём же, код останется выделенным для правки или повтора.
   */
  function submitJoin() {
    if (elements.join.disabled) return; // уже подключаемся
    const code = normalizedCode();
    if (code.length !== 4) {
      showJoinNote('Введите код из четырёх символов');
      elements.code.focus();
      elements.code.select();
      return;
    }
    setBusy(true);
    showJoinNote('Подключаемся…', 'progress');
    openRoom(code, null, { viaJoin: true })
      .then(() => clearJoinNote())
      .catch((error) => {
        showJoinNote(error.message);
        elements.code.focus();
        elements.code.select();
      })
      .finally(() => setBusy(false));
  }

  function sourceKey(source) {
    if (!source) return null;
    return source.provider === SynodicProtocol.PROVIDER_VK
      ? `${source.provider}:${source.ownerId}:${source.videoId}`
      : `${source.provider}:${source.videoId}:${source.p || ''}`;
  }

  async function copyInvite() {
    const code = elements.roomCode.textContent?.trim();
    if (!code || code === '····') return;
    const link = `${location.origin}${location.pathname}?room=${code}`;
    try {
      await navigator.clipboard.writeText(link);
      elements.copy.dataset.copied = 'true';
      elements.copy.setAttribute('aria-label', 'Ссылка скопирована');
      clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        delete elements.copy.dataset.copied;
        updateCopyLabel(code);
      }, 1800);
      showFeedback('Ссылка скопирована — отправьте её напарнику', 'success');
    } catch {
      showError(`Не удалось скопировать. Ссылка: ${link}`);
    }
  }

  function updateCopyLabel(code) {
    const label = code && code !== '····'
      ? `Скопировать ссылку-приглашение, код ${code}`
      : 'Скопировать ссылку-приглашение';
    elements.copy.setAttribute('aria-label', label);
    elements.copy.title = label;
  }

  function openInfo() {
    clearTimeout(infoCloseTimer);
    if (!elements.infoModal.open) elements.infoModal.showModal();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        elements.infoModal.dataset.visible = 'true';
      });
    });
  }

  function closeInfo() {
    if (!elements.infoModal.open) return;
    delete elements.infoModal.dataset.visible;
    clearTimeout(infoCloseTimer);
    const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260;
    infoCloseTimer = setTimeout(() => elements.infoModal.close(), duration);
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

  // На стартовом экране заметка живёт у своей формы: ошибки создания —
  // строкой над формой; ошибки входа по коду — внутри поповера.
  function showFeedback(text, tone = 'error', autoHide = true) {
    clearTimeout(feedbackTimer);
    const feedback = elements.startView.hidden ? elements.feedback : elements.createFeedback;
    feedback.textContent = text;
    feedback.dataset.tone = tone;
    feedback.hidden = false;
    if (autoHide) feedbackTimer = setTimeout(clearFeedback, 3200);
  }

  /** Строка в поповере входа: ошибка висит до правки кода, статус — до исхода. */
  function showJoinNote(text, tone = 'error') {
    elements.joinFeedback.textContent = text;
    elements.joinFeedback.dataset.tone = tone;
    elements.joinFeedback.hidden = false;
    // поповер абсолютный: после роста убедимся, что он целиком в кадре —
    // на мобилке с открытой клавиатурой низ мог уехать за экран
    requestAnimationFrame(() => {
      elements.joinForm.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }

  function clearJoinNote() {
    elements.joinFeedback.hidden = true;
    elements.joinFeedback.textContent = '';
  }

  function clearCreateNote() {
    elements.createFeedback.hidden = true;
    elements.createFeedback.textContent = '';
  }

  function clearFeedback() {
    clearTimeout(feedbackTimer);
    [elements.createFeedback, elements.joinFeedback, elements.feedback].forEach((feedback) => {
      feedback.hidden = true;
      feedback.textContent = '';
    });
  }
})();
