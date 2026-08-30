/**
 * Service worker Synodic: единственная точка связи с сервером.
 * Держит WebSocket к SynodicServe и пересылает события:
 *   content script <-> service worker <-> сервер.
 *
 * Активная комната хранится в chrome.storage.session, поэтому переживает
 * выгрузку service worker, но не перезапуск браузера. WebSocket-активность
 * раз в 20 с не даёт Chrome 116+ выгрузить worker при живом соединении.
 */

importScripts(
  '../shared/config.js',
  '../shared/protocol.js',
  '../shared/video-source.js',
);

const DEFAULT_SERVER_URL = SynodicConfig.SERVER_URL;
const ACTIVE_ROOM_KEY = 'activeRoom';
const RECONNECT_ALARM = 'synodic-reconnect';
const CONNECT_TIMEOUT_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 20000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const VIDEO_CANDIDATE_TTL_MS = 10000;
const MAX_VIDEO_TIME_S = 7 * 24 * 60 * 60;
const MAX_PLAYBACK_RATE = 16;
const LOCAL_EVENT_TYPES = new Set([
  SynodicProtocol.EVENT_PLAY,
  SynodicProtocol.EVENT_PAUSE,
  SynodicProtocol.EVENT_SEEK,
  SynodicProtocol.EVENT_RATE,
]);
const REMOTE_EVENT_TYPES = new Set([
  ...LOCAL_EVENT_TYPES,
  SynodicProtocol.EVENT_HEARTBEAT,
]);

let ws = null;
let room = null; // комната + вкладка/frame выбранного видео
let latestState = null; // снапшот для навигации и поздно найденного video
const videoCandidates = new Map();
const staleDocumentIds = new Set();
let currentServerUrl = DEFAULT_SERVER_URL;
let connectionAttempt = null;
let connectionReady = false;
let reconnectAttempt = 0;
let reconnectTimer = null;
let keepaliveTimer = null;
let sessionWrite = Promise.resolve();
let needsInitialHostState = false;
let initialStateRequest = null;
let currentRoomVideo = null;
let announcedSourceKey = null;

const initialized = restoreSession();

chrome.tabs.onRemoved.addListener((tabId) => {
  initialized.then(() => {
    if (room?.tabId === tabId) leaveRoom();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  initialized.then(() => {
    if (room?.tabId !== tabId) return;
    staleDocumentIds.clear();
    for (const candidate of videoCandidates.values()) {
      if (candidate.documentId) staleDocumentIds.add(candidate.documentId);
    }
    if (room.targetDocumentId) staleDocumentIds.add(room.targetDocumentId);
    videoCandidates.clear();
    clearVideoTarget();
    notifyRoomState();
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== RECONNECT_ALARM) return;
  if (ws && !connectionReady) {
    try {
      ws.close(4001, 'join timeout');
    } catch {
      // onclose или следующий alarm продолжат восстановление
    }
    return;
  }
  reconnectNow();
});

// --- сообщения от popup и content script'ов --------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.kind) return false;

  switch (message.kind) {
    case SynodicProtocol.MSG_GET_STATUS:
      respond(initialized.then(statusForPopup), sendResponse);
      return true;
    case SynodicProtocol.MSG_GET_CONTENT_STATE:
      respond(initialized.then(() => ({
        active: !!room && sender.tab?.id === room.tabId,
      })), sendResponse);
      return true;
    case SynodicProtocol.MSG_CREATE_ROOM:
      respond(initialized.then(() => createRoom(message.serverUrl)), sendResponse);
      return true;
    case SynodicProtocol.MSG_JOIN_ROOM:
      respond(
        initialized.then(() => joinRoom(message.serverUrl, message.code)),
        sendResponse,
      );
      return true;
    case SynodicProtocol.MSG_LEAVE_ROOM:
      respond(initialized.then(leaveRoom), sendResponse);
      return true;
    case SynodicProtocol.MSG_READY:
      respond(initialized.then(markReady), sendResponse);
      return true;
    case SynodicProtocol.MSG_SELECT_TAB:
      respond(initialized.then(selectCurrentTab), sendResponse);
      return true;
    case SynodicProtocol.MSG_VIDEO_EVENT:
      initialized.then(() => handleVideoEvent(message.event, sender));
      return false;
    case SynodicProtocol.MSG_VIDEO_CANDIDATE:
      initialized.then(() => registerVideoCandidate(message, sender));
      return false;
    default:
      return false;
  }
});

function respond(promise, sendResponse) {
  promise
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
}

function status() {
  const connected = !!room && connectionReady && ws?.readyState === WebSocket.OPEN;
  return {
    connected,
    reconnecting: !!room && !connected,
    room: room ? {
      code: room.code,
      role: room.role,
      peerOnline: room.peerOnline,
      videoReady: room.videoReady,
      localReady: room.localReady,
      peerReady: room.peerReady,
      startingTogether: room.startingTogether,
      startedTogether: room.startedTogether,
      startFailed: room.startFailed,
    } : null,
    serverUrl: currentServerUrl,
  };
}

async function statusForPopup() {
  const state = status();
  if (!room) return { ...state, currentTabMatches: true };
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { ...state, currentTabMatches: tab?.id === room.tabId };
}

// --- комната и соединение ----------------------------------------------------

async function restoreSession() {
  try {
    const stored = await chrome.storage.session.get(ACTIVE_ROOM_KEY);
    const activeRoom = stored[ACTIVE_ROOM_KEY];
    if (!isStoredRoom(activeRoom)) return;

    try {
      await chrome.tabs.get(activeRoom.tabId);
    } catch {
      await chrome.storage.session.remove(ACTIVE_ROOM_KEY);
      return;
    }

    currentServerUrl = activeRoom.serverUrl;
    room = createRoomState(activeRoom.code, activeRoom.role, activeRoom.tabId);
    try {
      await ensureContentScripts(activeRoom.tabId);
    } catch (error) {
      console.warn('[synodic] вкладка комнаты ещё не подключена:', error.message);
    }
    notifyRoomState();
    reconnectNow();
  } catch (error) {
    console.warn('[synodic] не удалось восстановить комнату:', error.message);
  }
}

function isStoredRoom(value) {
  return value &&
    typeof value.serverUrl === 'string' &&
    typeof value.code === 'string' &&
    Number.isInteger(value.tabId) &&
    (value.role === 'host' || value.role === 'guest');
}

function createRoomState(code, role, tabId) {
  return {
    code,
    role,
    tabId,
    peerOnline: false,
    videoReady: false,
    localReady: false,
    peerReady: false,
    startingTogether: false,
    startedTogether: false,
    startFailed: false,
    targetFrameId: null,
    targetDocumentId: null,
    targetArea: 0,
  };
}

async function createRoom(serverUrl) {
  const base = serverUrl || currentServerUrl;
  try {
    const tabId = await getActiveVideoTabId();
    await ensureContentScripts(tabId);
    const res = await fetch(new URL('/api/rooms', base), {
      method: 'POST',
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[synodic] создание комнаты: ${base} ответил ${res.status}`);
      return { ok: false, error: 'Не удалось подключиться к Synodic' };
    }
    const { code } = await res.json();
    return connect(base, code, 'host', tabId);
  } catch (error) {
    console.error(`[synodic] создание комнаты через ${base}:`, error);
    return { ok: false, error: error.message || 'Не удалось подключиться к Synodic' };
  }
}

async function joinRoom(serverUrl, code) {
  const tabId = await getActiveVideoTabId();
  await ensureContentScripts(tabId);
  return connect(serverUrl, code, 'guest', tabId);
}

async function getActiveVideoTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!Number.isInteger(tab?.id) || !/^https?:\/\//i.test(tab.url || '')) {
    throw new Error('Откройте обычную страницу с видео и повторите');
  }
  return tab.id;
}

async function ensureContentScripts(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      kind: SynodicProtocol.MSG_CONTENT_PING,
    });
    if (response?.ok) return;
  } catch {
    // Вкладка могла быть открыта до установки/перезагрузки расширения.
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/shared/protocol.js', 'src/content/content.js'],
    });
    const response = await chrome.tabs.sendMessage(tabId, {
      kind: SynodicProtocol.MSG_CONTENT_PING,
    });
    if (response?.ok) return;
  } catch (error) {
    console.warn('[synodic] не удалось подключить страницу:', error.message);
  }

  throw new Error('Не удалось подключиться к этой странице. Обновите вкладку и попробуйте ещё раз');
}

async function selectCurrentTab() {
  if (!room) throw new Error('Сначала войдите в комнату');
  const tabId = await getActiveVideoTabId();
  await ensureContentScripts(tabId);
  if (tabId === room.tabId) return { ok: true, ...(await statusForPopup()) };

  const previousTabId = room.tabId;
  sendInactiveRoomState(previousTabId);
  room.tabId = tabId;
  room.localReady = false;
  room.peerReady = false;
  room.startingTogether = false;
  room.startedTogether = false;
  room.startFailed = false;
  videoCandidates.clear();
  staleDocumentIds.clear();
  clearVideoTarget();
  initialStateRequest = null;
  persistSession();
  notifyRoomState();
  return { ok: true, ...(await statusForPopup()) };
}

async function connect(serverUrl, code, role, tabId) {
  await clearConnection({ forgetRoom: true, notify: false });

  currentServerUrl = serverUrl || currentServerUrl;
  room = createRoomState(String(code || '').trim(), role, tabId);
  notifyRoomState();
  return openConnection(false);
}

function openConnection(isReconnect) {
  if (!room) return Promise.resolve({ ok: false, error: 'комната не выбрана' });
  if (connectionAttempt?.socket === ws) return connectionAttempt.promise;
  if (connectionReady && ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve({ ok: true, ...status() });
  }

  const targetCode = room.code;
  let socket;
  try {
    socket = openWebSocket(currentServerUrl, targetCode);
  } catch (error) {
    if (isReconnect) scheduleReconnect();
    else resetRoomState();
    notifyRoomState();
    return Promise.resolve({ ok: false, error: error.message });
  }

  ws = socket;
  connectionReady = false;
  chrome.alarms.create(RECONNECT_ALARM, {
    when: Date.now() + CONNECT_TIMEOUT_MS,
  }).catch(() => {});
  let joined = false;
  let settled = false;
  let connectTimer;

  const promise = new Promise((resolve) => {
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (connectionAttempt?.socket === socket) connectionAttempt = null;
      resolve(value);
    };

    connectTimer = setTimeout(() => {
      if (ws === socket && !joined) socket.close(4001, 'join timeout');
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (ws === socket) startKeepalive(socket);
    };

    socket.onmessage = (event) => {
      if (ws !== socket) return;
      const message = parseServerMessage(event.data);
      if (!message) return;

      if (message.type === SynodicProtocol.SERVER_JOINED) {
        joined = true;
        connectionReady = true;
        room.peerOnline = Number(message.peers) > 1;
        room.peerReady = false;
        room.startingTogether = false;
        room.startedTogether = false;
        room.startFailed = false;
        currentRoomVideo = normalizeRoomVideo(message.video);
        announcedSourceKey = sourceKey(currentRoomVideo);
        reconnectAttempt = 0;
        clearReconnectSchedule();
        persistSession();
        notifyRoomState();
        needsInitialHostState = room.role === 'host' && isPristineSnapshot(message.state);
        latestState = needsInitialHostState ? null : normalizeSnapshot(message.state);
        if (needsInitialHostState) requestInitialHostState();
        else sendSnapshotToTarget();
        announceTargetVideo();
        if (room.localReady) sendClientMessage(SynodicProtocol.CLIENT_READY);
        // create/join всегда привязываются к текущей активной вкладке.
        done({ ok: true, ...status(), currentTabMatches: true });
        return;
      }

      handleServerMessage(message);
    };

    socket.onerror = () => {
      // onclose даст итоговый код и запустит reconnect при необходимости
    };

    socket.onclose = (event) => {
      const isCurrent = ws === socket;
      if (isCurrent) {
        ws = null;
        connectionReady = false;
        stopKeepalive();
      }

      if (!isCurrent) {
        done({ ok: false, error: 'подключение отменено' });
        return;
      }

      // После обрыва старый socket может ещё занимать слот на сервере до
      // transport heartbeat. Для обычного входа 4000 окончателен, а при
      // reconnect ждём освобождения собственного старого соединения.
      const terminal = event.code === 4004 || (event.code === 4000 && !isReconnect);
      const shouldReconnect = !!room && !terminal && (joined || isReconnect);
      if (shouldReconnect) {
        room.peerOnline = false;
        room.peerReady = false;
        room.startingTogether = false;
        room.startedTogether = false;
        notifyRoomState();
        scheduleReconnect();
      } else {
        resetRoomState();
        clearReconnectSchedule();
        chrome.storage.session.remove(ACTIVE_ROOM_KEY).catch(() => {});
        notifyRoomState();
      }

      done({ ok: false, error: closeError(event) });
    };
  });

  connectionAttempt = { socket, promise };
  return promise;
}

function closeError(event) {
  if (event.code === 4000) return 'комната заполнена';
  if (event.code === 4004) return 'комната не найдена';
  if (event.code === 4001) return 'сервер не подтвердил вход вовремя';
  return 'соединение с сервером разорвано';
}

async function leaveRoom() {
  await clearConnection({ forgetRoom: true, notify: true });
  return { ok: true, ...status(), currentTabMatches: true };
}

async function clearConnection({ forgetRoom, notify }) {
  clearReconnectSchedule();
  stopKeepalive();

  const socket = ws;
  ws = null;
  connectionReady = false;
  connectionAttempt = null;
  if (socket) {
    try {
      socket.close(1000, 'left room');
    } catch {
      // уже закрыт
    }
  }

  if (forgetRoom) {
    resetRoomState();
    reconnectAttempt = 0;
    await sessionWrite;
    await chrome.storage.session.remove(ACTIVE_ROOM_KEY);
  }
  if (notify) notifyRoomState();
}

function openWebSocket(serverUrl, code) {
  const url = new URL(serverUrl.replace(/\/+$/, ''));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  url.searchParams.set('room', code);
  return new WebSocket(url);
}

function persistSession() {
  if (!room) return;
  const activeRoom = {
    serverUrl: currentServerUrl,
    code: room.code,
    role: room.role,
    tabId: room.tabId,
  };
  sessionWrite = sessionWrite
    .then(() => chrome.storage.session.set({ [ACTIVE_ROOM_KEY]: activeRoom }))
    .catch((error) => {
      console.warn('[synodic] не удалось сохранить комнату:', error.message);
    });
}

// --- keepalive и reconnect ---------------------------------------------------

function startKeepalive(socket) {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    if (ws !== socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: SynodicProtocol.CLIENT_KEEPALIVE }));
    } catch {
      socket.close();
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive() {
  clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function scheduleReconnect() {
  if (!room || ws || reconnectTimer) return;

  const delay = Math.min(
    RECONNECT_BASE_MS * (2 ** reconnectAttempt),
    RECONNECT_MAX_MS,
  );
  reconnectAttempt += 1;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectNow();
  }, delay);

  chrome.alarms.create(RECONNECT_ALARM, { when: Date.now() + delay }).catch(() => {});
}

function reconnectNow() {
  if (!room || ws) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  openConnection(true).then((result) => {
    if (!result.ok && room && !ws && !reconnectTimer) scheduleReconnect();
  });
}

function clearReconnectSchedule() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
}

// --- события сервера ---------------------------------------------------------

function parseServerMessage(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function handleServerMessage(message) {
  switch (message.type) {
    case SynodicProtocol.SERVER_PEER_JOINED:
      if (room) room.peerOnline = true;
      notifyRoomState();
      break;
    case SynodicProtocol.SERVER_PEER_LEFT:
      if (room) {
        room.peerOnline = false;
        room.peerReady = false;
        room.startingTogether = false;
        room.startedTogether = false;
      }
      notifyRoomState();
      break;
    case SynodicProtocol.SERVER_PEER_READY:
      if (room) room.peerReady = true;
      notifyRoomState();
      maybeStartTogether();
      break;
    case SynodicProtocol.SERVER_SYNC:
      handleRemoteVideoEvent(message.event);
      break;
    case SynodicProtocol.SERVER_VIDEO:
      currentRoomVideo = normalizeRoomVideo(message.video);
      announcedSourceKey = sourceKey(currentRoomVideo);
      break;
  }
}

function normalizeSnapshot(state) {
  if (!state || !validCurrentTime(state.currentTime)) {
    return null;
  }
  return {
    isPlaying: !!state.isPlaying,
    currentTime: state.currentTime,
    rate: validRate(state.rate) ? state.rate : 1,
    updatedAt: Date.now(),
  };
}

function isPristineSnapshot(state) {
  return state && state.updatedAt === 0 && state.currentTime === 0 && !state.isPlaying;
}

function applyStateEvent(event) {
  if (!event || !validCurrentTime(event.currentTime)) return;
  if (!latestState) {
    latestState = {
      isPlaying: false,
      currentTime: 0,
      rate: 1,
      updatedAt: Date.now(),
    };
  }

  if (event.type === SynodicProtocol.EVENT_PLAY ||
      event.type === SynodicProtocol.EVENT_HEARTBEAT) {
    latestState.isPlaying = true;
  }
  if (event.type === SynodicProtocol.EVENT_PAUSE) latestState.isPlaying = false;
  latestState.currentTime = event.currentTime;
  if (validRate(event.rate)) latestState.rate = event.rate;
  latestState.updatedAt = Date.now();
}

function snapshotToEvent(state, now = Date.now()) {
  let currentTime = state.currentTime;
  if (state.isPlaying && state.updatedAt > 0) {
    currentTime += (now - state.updatedAt) / 1000 * state.rate;
  }
  return {
    type: state.isPlaying ? SynodicProtocol.EVENT_PLAY : SynodicProtocol.EVENT_PAUSE,
    currentTime,
    rate: state.rate,
    ts: now,
  };
}

function validRate(rate) {
  return Number.isFinite(rate) && rate > 0 && rate <= MAX_PLAYBACK_RATE;
}

function validCurrentTime(currentTime) {
  return Number.isFinite(currentTime) && currentTime >= 0 && currentTime <= MAX_VIDEO_TIME_S;
}

function normalizeVideoEvent(event, allowedTypes) {
  if (!event || !allowedTypes.has(event.type) || !validCurrentTime(event.currentTime)) {
    return null;
  }
  if (event.rate !== undefined && !validRate(event.rate)) return null;

  const normalized = {
    type: event.type,
    currentTime: event.currentTime,
  };
  if (event.rate !== undefined) normalized.rate = event.rate;
  if (Number.isFinite(event.ts)) normalized.ts = event.ts;
  return normalized;
}

// --- пересылка ---------------------------------------------------------------

function forwardToServer(event) {
  sendClientMessage(SynodicProtocol.CLIENT_SYNC, { event });
}

function sendClientMessage(type, payload = {}) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify({ type, ...payload }));
  return true;
}

async function markReady() {
  if (!room || !connectionReady) throw new Error('Нет связи с комнатой');
  if (!room.peerOnline) throw new Error('Сначала дождитесь напарника');
  if (!room.videoReady) throw new Error('Видео пока не найдено');

  room.localReady = true;
  if (room.startFailed) room.startedTogether = false;
  room.startFailed = false;
  sendClientMessage(SynodicProtocol.CLIENT_READY);
  notifyRoomState();
  maybeStartTogether();
  return { ok: true, ...(await statusForPopup()) };
}

function maybeStartTogether() {
  if (!room?.localReady || !room.peerReady || !room.videoReady ||
      room.startingTogether || room.startedTogether) return;

  room.startingTogether = true;
  room.startFailed = false;
  notifyRoomState();
  requestTarget({ kind: SynodicProtocol.MSG_START_VIDEO }).then((response) => {
    if (!room) return;
    room.startingTogether = false;
    room.startFailed = !response?.ok;
    room.startedTogether = !!response?.ok;
    notifyRoomState();
  }).catch(() => {
    if (!room) return;
    room.startingTogether = false;
    room.startedTogether = false;
    room.startFailed = true;
    notifyRoomState();
  });
}

function handleVideoEvent(event, sender) {
  if (!isTargetSender(sender)) return;
  const normalized = normalizeEventForRoom(normalizeVideoEvent(event, LOCAL_EVENT_TYPES));
  if (!normalized) return;
  needsInitialHostState = false;
  applyStateEvent(normalized);
  forwardToServer(normalized);
}

function handleRemoteVideoEvent(event) {
  const normalized = normalizeEventForRoom(normalizeVideoEvent(event, REMOTE_EVENT_TYPES));
  if (!normalized) return;
  // Первое реальное действие напарника уже делает комнату непустой и важнее
  // позднего локального seed хозяина.
  needsInitialHostState = false;
  applyStateEvent(normalized);
  sendToTarget({ kind: SynodicProtocol.MSG_APPLY_EVENT, event: normalized });
}

function normalizeEventForRoom(event) {
  if (!event || currentRoomVideo?.provider !== SynodicProtocol.PROVIDER_VK) return event;
  if (event.type === SynodicProtocol.EVENT_RATE) return null;
  return { ...event, rate: 1 };
}

function registerVideoCandidate(message, sender) {
  if (!room || sender.tab?.id !== room.tabId || !Number.isInteger(sender.frameId)) return;
  if (typeof sender.documentId === 'string' && staleDocumentIds.has(sender.documentId)) return;

  const key = candidateKey(sender.documentId, sender.frameId);
  if (!message.available) {
    videoCandidates.delete(key);
  } else {
    const area = Number(message.area);
    if (!Number.isFinite(area) || area <= 0) return;
    // iframe может навигироваться без tabs.onUpdated. Новый document в том же
    // frameId заменяет старый сразу, а не ждёт истечения его lease.
    for (const [candidateKeyValue, candidate] of videoCandidates) {
      if (candidate.frameId === sender.frameId && candidate.key !== key) {
        videoCandidates.delete(candidateKeyValue);
      }
    }
    videoCandidates.set(key, {
      key,
      frameId: sender.frameId,
      documentId: typeof sender.documentId === 'string' ? sender.documentId : null,
      area,
      pageUrl: typeof message.pageUrl === 'string' && message.pageUrl.length <= 4096
        ? message.pageUrl
        : '',
      lastSeen: Date.now(),
    });
  }

  selectVideoTarget();
}

function candidateKey(documentId, frameId) {
  return typeof documentId === 'string' ? `document:${documentId}` : `frame:${frameId}`;
}

function selectVideoTarget() {
  if (!room) return;

  const now = Date.now();
  for (const [key, candidate] of videoCandidates) {
    if (now - candidate.lastSeen > VIDEO_CANDIDATE_TTL_MS) videoCandidates.delete(key);
  }

  const currentKey = room.targetDocumentId
    ? candidateKey(room.targetDocumentId, room.targetFrameId)
    : Number.isInteger(room.targetFrameId)
      ? candidateKey(null, room.targetFrameId)
      : null;
  let best = currentKey ? videoCandidates.get(currentKey) : null;
  for (const candidate of videoCandidates.values()) {
    if (!best || candidate.area > best.area) best = candidate;
  }

  const changed = room.videoReady !== !!best ||
    room.targetFrameId !== (best?.frameId ?? null) ||
    room.targetDocumentId !== (best?.documentId ?? null);
  room.videoReady = !!best;
  room.targetFrameId = best?.frameId ?? null;
  room.targetDocumentId = best?.documentId ?? null;
  room.targetArea = best?.area ?? 0;

  if (!changed) return;
  notifyRoomState();
  announceTargetVideo();
  sendSnapshotToTarget();
  requestInitialHostState();
  maybeStartTogether();
}

function clearVideoTarget() {
  if (!room) return;
  room.videoReady = false;
  room.targetFrameId = null;
  room.targetDocumentId = null;
  room.targetArea = 0;
}

function isTargetSender(sender) {
  if (!room?.videoReady || sender.tab?.id !== room.tabId) return false;
  if (room.targetDocumentId && sender.documentId) {
    return room.targetDocumentId === sender.documentId;
  }
  return sender.frameId === room.targetFrameId;
}

function sendSnapshotToTarget() {
  if (!latestState) return;
  sendToTarget({
    kind: SynodicProtocol.MSG_APPLY_EVENT,
    event: snapshotToEvent(latestState),
  });
}

function announceTargetVideo() {
  if (room?.role !== 'host' || !room.videoReady || !connectionReady) return;
  const target = selectedCandidate();
  const source = SynodicVideoSource.parse(target?.pageUrl);
  const key = sourceKey(source);
  if (!source || !key || key === announcedSourceKey) return;

  announcedSourceKey = key;
  currentRoomVideo = source;
  sendClientMessage(SynodicProtocol.CLIENT_VIDEO, { video: source });
}

function selectedCandidate() {
  if (!room?.videoReady) return null;
  return videoCandidates.get(candidateKey(room.targetDocumentId, room.targetFrameId)) || null;
}

function normalizeRoomVideo(video) {
  if (!video || typeof video !== 'object') return null;
  if (video.provider === SynodicProtocol.PROVIDER_VK) {
    if (typeof video.ownerId !== 'string' || !/^-?\d{1,20}$/.test(video.ownerId) ||
        typeof video.videoId !== 'string' || !/^\d{1,20}$/.test(video.videoId)) return null;
    return { ...video };
  }
  if (video.provider !== SynodicProtocol.PROVIDER_YOUTUBE &&
      video.provider !== SynodicProtocol.PROVIDER_RUTUBE) return null;
  if (typeof video.videoId !== 'string' || !video.videoId) return null;
  return { ...video };
}

function sourceKey(source) {
  if (!source) return null;
  return source.provider === SynodicProtocol.PROVIDER_VK
    ? `${source.provider}:${source.ownerId}:${source.videoId}`
    : `${source.provider}:${source.videoId}:${source.p || ''}`;
}

function requestInitialHostState() {
  if (!needsInitialHostState || initialStateRequest || !room?.videoReady ||
      !connectionReady || ws?.readyState !== WebSocket.OPEN) {
    return;
  }

  const target = {
    tabId: room.tabId,
    frameId: room.targetFrameId,
    documentId: room.targetDocumentId,
  };
  const options = target.documentId
    ? { documentId: target.documentId }
    : { frameId: target.frameId };

  const targetRoomCode = room.code;
  const request = chrome.tabs.sendMessage(target.tabId, {
    kind: SynodicProtocol.MSG_READ_VIDEO_STATE,
  }, options);
  initialStateRequest = request;
  request.then((response) => {
    if (initialStateRequest !== request || room?.code !== targetRoomCode ||
        !needsInitialHostState || !isCurrentTarget(target)) {
      return;
    }
    const event = normalizeVideoEvent(response?.event, LOCAL_EVENT_TYPES);
    if (!response?.ok || !event) return;
    needsInitialHostState = false;
    applyStateEvent(event);
    forwardToServer(event);
  }).catch(() => {}).finally(() => {
    if (initialStateRequest !== request) return;
    initialStateRequest = null;
    if (!needsInitialHostState) return;
    if (!isCurrentTarget(target)) {
      requestInitialHostState();
      return;
    }
    videoCandidates.delete(candidateKey(target.documentId, target.frameId));
    selectVideoTarget();
  });
}

function isCurrentTarget(target) {
  if (!room?.videoReady || room.tabId !== target.tabId) return false;
  if (target.documentId) return room.targetDocumentId === target.documentId;
  return !room.targetDocumentId && room.targetFrameId === target.frameId;
}

function sendToTarget(message) {
  if (!room?.videoReady || !Number.isInteger(room.tabId)) return;

  const target = {
    tabId: room.tabId,
    frameId: room.targetFrameId,
    documentId: room.targetDocumentId,
  };
  const options = target.documentId
    ? { documentId: target.documentId }
    : { frameId: target.frameId };

  chrome.tabs.sendMessage(target.tabId, message, options).catch(() => {
    if (!room || room.tabId !== target.tabId) return;
    const stillSelected = target.documentId
      ? room.targetDocumentId === target.documentId
      : !room.targetDocumentId && room.targetFrameId === target.frameId;
    if (!stillSelected) return;
    videoCandidates.delete(candidateKey(target.documentId, target.frameId));
    selectVideoTarget();
  });
}

function requestTarget(message) {
  if (!room?.videoReady || !Number.isInteger(room.tabId)) {
    return Promise.resolve({ ok: false });
  }
  const target = {
    tabId: room.tabId,
    frameId: room.targetFrameId,
    documentId: room.targetDocumentId,
  };
  const options = target.documentId
    ? { documentId: target.documentId }
    : { frameId: target.frameId };
  return chrome.tabs.sendMessage(target.tabId, message, options);
}

function notifyRoomState() {
  const message = { kind: SynodicProtocol.MSG_ROOM_STATE, state: status() };
  if (Number.isInteger(room?.tabId)) {
    // Это только запрос обнаружения: команды видео сюда не попадают.
    chrome.tabs.sendMessage(room.tabId, message).catch(() => {});
  }
  chrome.runtime.sendMessage(message).catch(() => {});
}

function sendInactiveRoomState(tabId) {
  if (!Number.isInteger(tabId)) return;
  chrome.tabs.sendMessage(tabId, {
    kind: SynodicProtocol.MSG_ROOM_STATE,
    state: { ...status(), room: null },
  }).catch(() => {});
}

function resetRoomState() {
  const previousTabId = room?.tabId;
  room = null;
  latestState = null;
  videoCandidates.clear();
  staleDocumentIds.clear();
  needsInitialHostState = false;
  initialStateRequest = null;
  currentRoomVideo = null;
  announcedSourceKey = null;
  if (Number.isInteger(previousTabId)) {
    chrome.tabs.sendMessage(previousTabId, {
      kind: SynodicProtocol.MSG_ROOM_STATE,
      state: status(),
    }).catch(() => {});
  }
}
