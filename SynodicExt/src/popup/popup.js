/** Popup: простой сценарий создания комнаты, приглашения и входа по коду. */

const $ = (id) => document.getElementById(id);
const codeInput = $('code');
const feedback = $('feedback');
let feedbackTimer = null;
let latestState = null;
let isBusy = false;

init();

async function init() {
  bindEvents();

  try {
    const status = await send({ kind: SynodicProtocol.MSG_GET_STATUS });
    refreshUi(status);
  } catch (error) {
    showError(`Расширение не запустилось: ${error.message}`);
    setConnection('error', 'Ошибка');
  }
}

function bindEvents() {
  $('create').addEventListener('click', () => runAction('Создаём комнату…', async () => {
    const result = await send({
      kind: SynodicProtocol.MSG_CREATE_ROOM,
      serverUrl: SynodicConfig.SERVER_URL,
    });
    afterConnect(result);
  }));

  $('join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    runAction('Подключаемся…', async () => {
      const code = normalizedCode();
      if (code.length !== 4) throw new Error('Введите код из четырёх символов');
      const result = await send({
        kind: SynodicProtocol.MSG_JOIN_ROOM,
        serverUrl: SynodicConfig.SERVER_URL,
        code,
      });
      afterConnect(result);
    });
  });

  $('leave').addEventListener('click', () => runAction('Выходим…', async () => {
    const result = await send({ kind: SynodicProtocol.MSG_LEAVE_ROOM });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось выйти из комнаты');
    codeInput.value = '';
    refreshUi(result);
  }));

  $('select-tab').addEventListener('click', () => runAction('Подключаем вкладку…', async () => {
    const result = await send({ kind: SynodicProtocol.MSG_SELECT_TAB });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось выбрать вкладку');
    refreshUi(result);
  }));

  $('ready').addEventListener('click', () => runAction('Подтверждаем готовность…', async () => {
    const result = await send({ kind: SynodicProtocol.MSG_READY });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось начать просмотр');
    refreshUi(result);
  }));

  $('copy').addEventListener('click', copyRoomCode);
  codeInput.addEventListener('input', () => {
    const normalized = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (codeInput.value !== normalized) codeInput.value = normalized;
    clearFeedback();
  });

  chrome.runtime.onMessage.addListener(refreshUi);
}

function afterConnect(result) {
  if (!result?.ok) throw new Error(result?.error || 'Не удалось подключиться');
  refreshUi(result);
}

function refreshUi(message) {
  const state = message?.kind === SynodicProtocol.MSG_ROOM_STATE ? message.state : message;
  if (!state || state.connected === undefined) return;
  latestState = {
    ...state,
    currentTabMatches: state.currentTabMatches ?? latestState?.currentTabMatches,
  };

  const current = latestState;
  const hasRoom = !!current.room && (current.connected || current.reconnecting);
  $('start-view').hidden = hasRoom;
  $('room-view').hidden = !hasRoom;

  if (!hasRoom) {
    setConnection('idle', 'Готов');
    $('select-tab').hidden = true;
    $('ready').hidden = true;
    return;
  }

  const { room } = current;
  $('room-code').textContent = room.code;
  codeInput.value = room.code;
  $('select-tab').hidden = current.currentTabMatches !== false;
  $('select-tab').disabled = isBusy;
  $('ready').hidden = true;

  if (current.reconnecting) {
    setConnection('error', 'Нет связи');
    $('room-eyebrow').textContent = 'Комната сохранена';
    $('room-title').textContent = 'Возвращаемся';
    $('room-description').hidden = false;
    $('room-description').textContent = 'Synodic восстановит соединение автоматически.';
    return;
  }

  setConnection('online', 'На связи');

  if (!room.videoReady) {
    $('room-eyebrow').textContent = room.peerOnline ? 'Оба на месте' : 'Комната готова';
    $('room-title').textContent = 'Ищем видео';
    $('room-description').hidden = false;
    $('room-description').textContent = current.currentTabMatches === false
      ? 'Комната работает в другой вкладке. Переключите её только если хотите.'
      : 'Запустите страницу с видео — Synodic найдёт основной плеер сам.';
    return;
  }

  if (current.currentTabMatches === false) {
    $('room-eyebrow').textContent = room.peerOnline ? 'Оба на месте' : 'Комната активна';
    $('room-title').textContent = 'Видео в другой вкладке';
    $('room-description').hidden = false;
    $('room-description').textContent = 'Вернитесь к ней или явно выберите текущую.';
    return;
  }

  if (!room.peerOnline) {
    $('room-eyebrow').textContent = 'Комната готова';
    $('room-title').textContent = 'Ждём второго';
    $('room-description').hidden = false;
    $('room-description').textContent = 'Отправьте напарнику код комнаты.';
    return;
  }

  $('room-eyebrow').textContent = 'Оба на месте';
  $('room-description').hidden = false;

  if (room.startFailed) {
    $('room-title').textContent = 'Браузер ждёт клика';
    $('room-description').textContent = 'Попробуйте ещё раз или нажмите Play прямо на видео.';
    showReadyButton('Попробовать ещё', false);
  } else if (room.startingTogether) {
    $('room-title').textContent = 'Начинаем';
    $('room-description').textContent = 'Запускаем видео у обоих.';
    showReadyButton('Начинаем…', true);
  } else if (room.localReady && room.peerReady) {
    $('room-title').textContent = 'Смотрите вместе';
    $('room-description').textContent = 'Пауза, перемотка и продолжение теперь общие.';
  } else if (room.localReady) {
    $('room-title').textContent = 'Ждём напарника';
    $('room-description').textContent = 'Начнём, когда он тоже нажмёт кнопку.';
    showReadyButton('Ждём напарника…', true);
  } else if (room.peerReady) {
    $('room-title').textContent = 'Напарник готов';
    $('room-description').textContent = 'Нажмите — и начнёте одновременно.';
    showReadyButton('Смотреть вместе', false);
  } else {
    $('room-title').textContent = 'Всё готово';
    $('room-description').textContent = 'Когда оба нажмут — начнёте одновременно.';
    showReadyButton('Смотреть вместе', false);
  }
}

function setConnection(tone, label) {
  $('connection').dataset.tone = tone;
  $('connection-label').textContent = label;
}

function showReadyButton(label, disabled) {
  $('ready').hidden = false;
  $('ready').textContent = label;
  $('ready').disabled = isBusy || disabled;
}

function normalizedCode() {
  return codeInput.value.trim().toUpperCase();
}

async function copyRoomCode() {
  const code = latestState?.room?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showFeedback('Код скопирован — отправьте его напарнику', 'success');
  } catch {
    showError(`Не удалось скопировать. Код комнаты: ${code}`);
  }
}

async function runAction(progressText, action) {
  clearFeedback();
  setBusy(true, progressText);
  let succeeded = false;
  try {
    await action();
    succeeded = true;
  } catch (error) {
    showError(error.message);
    if (!latestState?.connected) setConnection('error', 'Ошибка');
  } finally {
    setBusy(false);
    if (latestState) refreshUi(latestState);
    if (succeeded) clearFeedback();
  }
}

function setBusy(busy, progressText = '') {
  isBusy = busy;
  document.querySelectorAll('button, input').forEach((element) => {
    element.disabled = busy;
  });
  if (busy && progressText) showFeedback(progressText, 'success', false);
}

function showError(text) {
  showFeedback(text, 'error', false);
}

function showFeedback(text, tone = 'error', autoHide = true) {
  clearTimeout(feedbackTimer);
  feedback.textContent = text;
  feedback.dataset.tone = tone;
  feedback.hidden = false;
  if (autoHide) feedbackTimer = setTimeout(clearFeedback, 2800);
}

function clearFeedback() {
  clearTimeout(feedbackTimer);
  feedback.hidden = true;
  feedback.textContent = '';
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}
