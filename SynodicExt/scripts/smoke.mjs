#!/usr/bin/env node

/**
 * Изолированный smoke-тест service worker без Chrome: проверяет привязку
 * комнаты к одной вкладке/document, фильтрацию событий и сброс при навигации.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const tabMessages = [];
const stored = {};
const contentTabs = new Set();
let activeTab = { id: 11, url: 'https://www.youtube.com/watch?v=18n-uEz_sPM' };
let injectionCount = 0;
let runtimeListener;
let tabUpdatedListener;
let alarmListener;
let socket;

class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    socket = this;
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const context = vm.createContext({
  console,
  URL,
  AbortSignal,
  WebSocket: FakeWebSocket,
  fetch: async () => ({ ok: true, json: async () => ({ code: 'ABCD' }) }),
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
  importScripts: () => {},
  chrome: {
    runtime: {
      onMessage: { addListener(listener) { runtimeListener = listener; } },
      sendMessage() { return Promise.resolve(); },
    },
    tabs: {
      query: async () => [activeTab],
      get: async (tabId) => ({ id: tabId }),
      sendMessage(tabId, message, options) {
        tabMessages.push({ tabId, message, options });
        if (message.kind === 'content-ping') {
          return contentTabs.has(tabId)
            ? Promise.resolve({ ok: true, revision: 'test' })
            : Promise.reject(new Error('receiving end does not exist'));
        }
        if (message.kind === 'read-video-state') {
          return Promise.resolve({
            ok: true,
            event: { type: 'pause', currentTime: 77, rate: 1, ts: Date.now() },
          });
        }
        return Promise.resolve({ ok: true });
      },
      onRemoved: { addListener() {} },
      onUpdated: { addListener(listener) { tabUpdatedListener = listener; } },
    },
    scripting: {
      async executeScript({ target }) {
        injectionCount += 1;
        contentTabs.add(target.tabId);
      },
    },
    alarms: {
      create: async () => {},
      clear: async () => {},
      onAlarm: { addListener(listener) { alarmListener = listener; } },
    },
    storage: {
      session: {
        async get(key) { return { [key]: stored[key] }; },
        async set(value) { Object.assign(stored, value); },
        async remove(key) { delete stored[key]; },
      },
    },
  },
});

for (const filename of [
  'src/shared/config.js',
  'src/shared/protocol.js',
  'src/shared/video-source.js',
  'src/background/service-worker.js',
]) {
  const source = await readFile(new URL(filename, root), 'utf8');
  vm.runInContext(source, context, { filename });
}

assert(runtimeListener, 'service worker не подписался на runtime.onMessage');
assert(tabUpdatedListener, 'service worker не подписался на tabs.onUpdated');
assert(alarmListener, 'service worker не подписался на alarms.onAlarm');
assert.deepEqual(
  plain(context.SynodicVideoSource.parse(
    'https://rutube.ru/video/private/0123456789abcdef0123456789abcdef/?p=private-token',
  )),
  {
    provider: 'rutube',
    videoId: '0123456789abcdef0123456789abcdef',
    startAt: 0,
    p: 'private-token',
  },
  'приватная Rutube-ссылка разобрана не так, как на сайте',
);
assert.deepEqual(
  plain(context.SynodicVideoSource.parse(
    'https://rutube.ru/play/embed/abcdef0123456789abcdef0123456789?t=90',
  )),
  {
    provider: 'rutube',
    videoId: 'abcdef0123456789abcdef0123456789',
    startAt: 90,
  },
  'Rutube embed-ссылка не распознана',
);
assert.deepEqual(
  plain(context.SynodicVideoSource.parse(
    'https://vkvideo.ru/video-31038184_456244573',
  )),
  { provider: 'vk', ownerId: '-31038184', videoId: '456244573' },
  'обычная ссылка VK Video не распознана',
);
assert.deepEqual(
  plain(context.SynodicVideoSource.parse(
    'https://vkvideo.ru/video_ext.php?oid=-31038184&id=456244573&hash=3d1ea1738f548565&hd=4',
  )),
  {
    provider: 'vk',
    ownerId: '-31038184',
    videoId: '456244573',
    hash: '3d1ea1738f548565',
  },
  'embed-ссылка VK Video не распознана',
);

const connecting = dispatch({
  kind: 'create-room',
  serverUrl: 'https://synodic.khodyr.netcraze.pro',
});
await tick();
assert.equal(socket.url, 'wss://synodic.khodyr.netcraze.pro/ws?room=ABCD');
assert.equal(injectionCount, 1, 'content script не подключился к уже открытой вкладке');

socket.open();
socket.message({
  type: 'joined',
  code: 'ABCD',
  peers: 1,
  state: { isPlaying: false, currentTime: 0, rate: 1, updatedAt: 0 },
});
assert.equal((await connecting).ok, true);
await tick();
assert.equal(stored.activeRoom.tabId, 11, 'tabId не сохранился в сессии');

socket.message({
  type: 'sync',
  event: { type: 'play', currentTime: 13, rate: 1, ts: Date.now() },
});

tabMessages.length = 0;
await dispatch({ kind: 'video-candidate', available: true, area: 900000 }, {
  tab: { id: 99 },
  frameId: 2,
  documentId: 'wrong-tab',
});
assert.equal(appliedMessages().length, 0, 'кандидат из чужой вкладки был принят');

await dispatch({
  kind: 'video-candidate',
  available: true,
  area: 400000,
  pageUrl: activeTab.url,
}, {
  tab: { id: 11 },
  frameId: 3,
  documentId: 'chosen-document',
});
await tick();
assertTarget(
  appliedMessages()[0],
  11,
  'chosen-document',
);
assert(
  Math.abs(appliedMessages()[0].message.event.currentTime - 13) < 0.1,
  'remote snapshot неожиданно ушёл от позиции напарника',
);
assert.equal(
  tabMessages.some(({ message }) => message.kind === 'read-video-state'),
  false,
  'поздний host seed перетёр действие напарника',
);
assert.deepEqual(
  socket.sent.find(({ type }) => type === 'video')?.video,
  { provider: 'youtube', videoId: '18n-uEz_sPM', startAt: 0 },
  'YouTube-источник не был передан участнику на сайте',
);

socket.message({ type: 'peer-joined', peers: 2 });
const readyResult = await dispatch({ kind: 'ready' });
assert.equal(readyResult.ok, true, 'расширение не приняло готовность пользователя');
assert.equal(socket.sent.at(-1)?.type, 'ready', 'готовность не ушла на сервер');
socket.message({ type: 'peer-ready' });
await tick();
assertTarget(
  tabMessages.find(({ message }) => message.kind === 'start-video'),
  11,
  'chosen-document',
);
assert.equal(
  (await dispatch({ kind: 'get-status' })).room.startedTogether,
  true,
  'одновременный старт не завершился',
);

tabMessages.length = 0;
socket.message({
  type: 'sync',
  event: { type: 'play', currentTime: 13, rate: 1, ts: Date.now() },
});
await tick();
assert.equal(tabMessages.length, 1, 'входящее событие было разослано больше чем в один document');
assertTarget(tabMessages[0], 11, 'chosen-document');

const sentBefore = socket.sent.length;
await dispatch({
  kind: 'video-event',
  event: { type: 'ratechange', currentTime: 14, rate: 1000 },
}, {
  tab: { id: 11 },
  frameId: 3,
  documentId: 'chosen-document',
});
assert.equal(socket.sent.length, sentBefore, 'недопустимая скорость ушла на сервер');

await dispatch({
  kind: 'video-event',
  event: { type: 'pause', currentTime: 14, rate: 1 },
}, {
  tab: { id: 11 },
  frameId: 4,
  documentId: 'other-document',
});
assert.equal(socket.sent.length, sentBefore, 'событие из чужого document ушло на сервер');

await dispatch({
  kind: 'video-event',
  event: { type: 'pause', currentTime: 14, rate: 1 },
}, {
  tab: { id: 11 },
  frameId: 3,
  documentId: 'chosen-document',
});
assert.equal(socket.sent.at(-1).event.type, 'pause');

tabMessages.length = 0;
await dispatch({ kind: 'video-candidate', available: true, area: 300000 }, {
  tab: { id: 11 },
  frameId: 3,
  documentId: 'replacement-document',
});
await tick();
assertTarget(
  appliedMessages()[0],
  11,
  'replacement-document',
);

tabMessages.length = 0;
await dispatch({ kind: 'video-candidate', available: true, area: 800000 }, {
  tab: { id: 11 },
  frameId: 4,
  documentId: 'larger-document',
});
await tick();
assertTarget(appliedMessages()[0], 11, 'larger-document');

tabUpdatedListener(11, { status: 'loading' });
await tick();
const afterNavigation = await dispatch({ kind: 'get-status' });
assert.equal(afterNavigation.room.videoReady, false, 'навигация не сбросила старое видео');

await dispatch({ kind: 'video-candidate', available: true, area: 900000 }, {
  tab: { id: 11 },
  frameId: 4,
  documentId: 'larger-document',
});
assert.equal(
  (await dispatch({ kind: 'get-status' })).room.videoReady,
  false,
  'старый document вернулся в target после начала навигации',
);

await dispatch({ kind: 'video-candidate', available: true, area: 300000 }, {
  tab: { id: 11 },
  frameId: 0,
  documentId: 'new-document',
});
assert.equal(
  (await dispatch({ kind: 'get-status' })).room.videoReady,
  true,
  'новый document не стал target после навигации',
);

socket.close(1006, 'network lost');
await tick();
alarmListener({ name: 'synodic-reconnect' });
await tick();
socket.open();
socket.close(4000, 'old socket still occupies the room');
await tick();
const afterReconnectFull = await dispatch({ kind: 'get-status' });
assert(afterReconnectFull.room, 'reconnect забыл комнату после временного 4000');
assert.equal(afterReconnectFull.reconnecting, true);

alarmListener({ name: 'synodic-reconnect' });
await tick();
socket.open();
socket.message({
  type: 'joined',
  code: 'ABCD',
  peers: 2,
  state: { isPlaying: false, currentTime: 14, rate: 1, updatedAt: Date.now() },
});
await tick();
const afterReconnect = await dispatch({ kind: 'get-status' });
assert.equal(afterReconnect.connected, true, 'повторный reconnect не восстановил комнату');

socket.close(4004, 'room not found');
await tick();
const afterTerminalClose = await dispatch({ kind: 'get-status' });
assert.equal(afterTerminalClose.room, null, 'удалённая комната осталась в reconnect-цикле');

const seedConnect = dispatch({
  kind: 'create-room',
  serverUrl: 'https://synodic.khodyr.netcraze.pro',
});
await tick();
socket.open();
socket.message({
  type: 'joined',
  code: 'ABCD',
  peers: 1,
  state: { isPlaying: false, currentTime: 0, rate: 1, updatedAt: 0 },
});
assert.equal((await seedConnect).ok, true);
tabMessages.length = 0;
await dispatch({ kind: 'video-candidate', available: true, area: 400000 }, {
  tab: { id: 11 },
  frameId: 3,
  documentId: 'seed-document',
});
await tick();
assertTarget(
  tabMessages.find(({ message }) => message.kind === 'read-video-state'),
  11,
  'seed-document',
);
assert.equal(socket.sent.at(-1)?.event?.currentTime, 77, 'host не засеял комнату своей позицией');
assert.equal(appliedMessages().length, 0, 'пустой серверный снапшот сбросил host-плеер');

tabMessages.length = 0;
activeTab = { id: 12, url: 'https://example.com/another-video' };
const selectedTab = await dispatch({ kind: 'select-tab' });
await tick();
assert.equal(selectedTab.ok, true, 'комната не переключилась на выбранную вкладку');
assert.equal(selectedTab.currentTabMatches, true, 'popup не актуализировал выбранную вкладку');
assert.equal(stored.activeRoom.tabId, 12, 'новая вкладка не сохранилась в сессии');
assert.equal(injectionCount, 2, 'новая вкладка не получила content script');
assert(
  tabMessages.some(({ tabId, message }) => tabId === 11 && message.kind === 'room-state' && !message.state.room),
  'предыдущая вкладка продолжила мониторинг после явного переключения',
);

await checkContentScript();

console.log('✓ extension smoke: routing, media events, readiness, navigation and terminal close');

function dispatch(message, sender = {}) {
  return new Promise((resolve) => {
    const asyncResponse = runtimeListener(message, sender, resolve);
    if (!asyncResponse) queueMicrotask(() => resolve(undefined));
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function appliedMessages() {
  return tabMessages.filter(({ message }) => message.kind === 'apply-event');
}

function assertTarget(record, tabId, documentId) {
  assert(record, 'нет адресного apply-event');
  assert.equal(record.tabId, tabId);
  assert.equal(JSON.stringify(record.options), JSON.stringify({ documentId }));
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function checkContentScript() {
  const backgroundMessages = [];
  let contentListener;

  class FakeVideo {
    constructor() {
      this.hidden = false;
      this.paused = true;
      this.readyState = 1;
      this.currentSrc = 'https://video.example/movie.mp4';
      this.parentElement = null;
      this.failSeekWhenEmpty = false;
      this.listeners = new Map();
      this._currentTime = 0;
      this._playbackRate = 1;
      this.rect = { top: 0, left: 0, right: 640, bottom: 360, width: 640, height: 360 };
    }

    get currentTime() { return this._currentTime; }
    set currentTime(value) {
      if (this.failSeekWhenEmpty && this.readyState === 0) throw new Error('metadata not ready');
      this._currentTime = value;
      this.dispatch('seeked');
    }

    get playbackRate() { return this._playbackRate; }
    set playbackRate(value) {
      this._playbackRate = value;
      this.dispatch('ratechange');
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    dispatch(type) {
      for (const listener of this.listeners.get(type) || []) {
        listener({ type, currentTarget: this });
      }
    }

    play() {
      this.paused = false;
      this.dispatch('play');
      return Promise.resolve();
    }

    pause() {
      this.paused = true;
      this.dispatch('pause');
    }

    getBoundingClientRect() {
      return this.rect;
    }

    getAttribute() { return null; }
    hasAttribute() { return false; }
  }

  const video = new FakeVideo();
  const offscreenVideo = new FakeVideo();
  const shadowRoot = {
    querySelectorAll(selector) {
      if (selector === 'video') return [video];
      if (selector === '*') return [];
      return [];
    },
  };
  const shadowHost = { shadowRoot };
  const body = {};
  const documentElement = {};
  video.parentElement = body;
  offscreenVideo.parentElement = body;
  offscreenVideo.rect = {
    top: 900,
    left: 0,
    right: 1920,
    bottom: 1980,
    width: 1920,
    height: 1080,
  };

  const contentContext = vm.createContext({
    console: { ...console, info() {} },
    Date,
    Map,
    Set,
    Math,
    Number,
    Promise,
    HTMLMediaElement: { HAVE_NOTHING: 0 },
    window: { innerWidth: 1280, innerHeight: 720 },
    location: { href: 'https://www.youtube.com/watch?v=18n-uEz_sPM' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    setTimeout: () => 1,
    clearTimeout: () => {},
    document: {
      body,
      documentElement,
      fullscreenElement: null,
      querySelectorAll(selector) {
        if (selector === 'video') return [offscreenVideo];
        if (selector === '*') return [shadowHost];
        return [];
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener(listener) { contentListener = listener; } },
        sendMessage(message) {
          backgroundMessages.push(message);
          if (message.kind === 'get-content-state') return Promise.resolve({ active: false });
          return Promise.resolve(undefined);
        },
      },
    },
  });

  for (const filename of ['src/shared/protocol.js', 'src/content/content.js']) {
    const source = await readFile(new URL(filename, root), 'utf8');
    vm.runInContext(source, contentContext, { filename });
  }

  assert(contentListener, 'content script не подписался на runtime.onMessage');
  await tick();
  assert.equal(backgroundMessages[0]?.kind, 'get-content-state');
  assert.equal(videoCandidates().length, 0, 'неактивная вкладка начала искать видео');

  let ping;
  contentListener({ kind: 'content-ping' }, {}, (value) => { ping = value; });
  assert.equal(ping?.ok, true, 'content script не отвечает на проверку подключения');

  contentListener({ kind: 'room-state', state: { room: { code: 'ABCD' } } }, {}, () => {});
  assert.equal(videoCandidates().at(-1)?.available, true, 'активная вкладка не объявила видео');
  assert.equal(videoCandidates().at(-1)?.area, 640 * 360, 'выбрано видео вне viewport');

  let localState;
  contentListener({ kind: 'read-video-state' }, {}, (value) => { localState = value; });
  assert.equal(localState?.event?.currentTime, 0, 'content script не отдал локальную позицию');
  assert.equal(localState?.event?.type, 'pause', 'content script потерял локальную паузу');

  const started = await dispatchContent({ kind: 'start-video' });
  assert.equal(started?.ok, true, 'кнопка готовности не запустила выбранное видео');
  assert.equal(video.paused, false, 'выбранное видео осталось на паузе после старта');
  video.pause();
  backgroundMessages.length = 0;

  applyToContent({ type: 'play', currentTime: 12, rate: 1.25 });
  await tick();
  assert.equal(video.currentTime, 12);
  assert.equal(video.playbackRate, 1.25);
  assert.equal(video.paused, false);
  assert.equal(videoEvents().length, 0, 'удалённое событие вернулось эхом');

  video.pause();
  assert.equal(videoEvents().at(-1)?.event.type, 'pause', 'локальная пауза не ушла в worker');

  const localEventsBeforeHeartbeat = videoEvents().length;
  applyToContent({ type: 'heartbeat', currentTime: 13, rate: 1.25 });
  await tick();
  assert.equal(video.paused, false, 'heartbeat не возобновил неожиданно остановленное видео');
  assert.equal(videoEvents().length, localEventsBeforeHeartbeat, 'heartbeat вернулся эхом');

  video.readyState = 0;
  video.failSeekWhenEmpty = true;
  applyToContent({ type: 'pause', currentTime: 42, rate: 1.25 });
  assert.notEqual(video.currentTime, 42, 'fake video неожиданно принял seek без metadata');
  video.readyState = 1;
  video.dispatch('loadedmetadata');
  assert.equal(video.currentTime, 42, 'позиция не повторилась после loadedmetadata');

  const eventsBeforeLeave = videoEvents().length;
  contentListener({ kind: 'room-state', state: { room: null } }, {}, () => {});
  assert.equal(videoCandidates().at(-1)?.available, false, 'видео не снялось после выхода');
  video.pause();
  assert.equal(videoEvents().length, eventsBeforeLeave, 'неактивная вкладка продолжила слать события');

  function applyToContent(event) {
    let response;
    contentListener({ kind: 'apply-event', event }, {}, (value) => { response = value; });
    assert.equal(response?.ok, true, `content script не применил ${event.type}`);
  }

  function dispatchContent(message) {
    return new Promise((resolve) => {
      const asyncResponse = contentListener(message, {}, resolve);
      if (!asyncResponse) queueMicrotask(() => resolve(undefined));
    });
  }

  function videoEvents() {
    return backgroundMessages.filter(({ kind }) => kind === 'video-event');
  }

  function videoCandidates() {
    return backgroundMessages.filter(({ kind }) => kind === 'video-candidate');
  }
}
