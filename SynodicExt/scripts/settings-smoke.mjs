#!/usr/bin/env node
/** Поведение настройки сервера и восстановления worker без Chrome и зависимостей. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const sources = await Promise.all([
  'src/shared/config.js', 'src/shared/protocol.js', 'src/shared/video-source.js',
  'src/background/service-worker.js',
].map(async (name) => [name, await readFile(new URL(name, root), 'utf8')]));
const popup = { id: 'test', url: 'chrome-extension://test/src/popup/popup.html' };
const oldRoom = { serverUrl: 'https://old.example.com', code: 'ABCD', role: 'host', tabId: 11 };

function harness({ local = {}, session = {}, beforeRead = null, readFails = false } = {}) {
  let listener;
  const calls = [];
  const broadcasts = [];
  const sockets = [];
  let writeFails = false;
  let removeFails = false;
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = String(url); this.readyState = 0; sockets.push(this); }
    send() {}
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    join() {
      this.readyState = 1;
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ type: 'joined', peers: 1, state: null }) });
    }
  }
  const context = vm.createContext({
    console: { warn() {}, error() {} }, URL, AbortSignal, WebSocket: Socket,
    fetch: async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ code: 'ABCD' }) };
    },
    importScripts() {}, setTimeout: () => 1, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
    chrome: {
      runtime: {
        id: 'test', getURL: (path) => `chrome-extension://test/${path}`,
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage: async (message) => { broadcasts.push(message); },
      },
      tabs: {
        query: async () => [{ id: 11, url: 'https://video.example.com' }],
        get: async (id) => ({ id }), sendMessage: async () => ({ ok: true }),
        onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      },
      scripting: { executeScript: async () => {} },
      alarms: { create: async () => {}, clear: async () => {}, onAlarm: { addListener() {} } },
      storage: {
        local: {
          async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
          async get(key) {
            if (beforeRead) await beforeRead;
            if (readFails) throw new Error('read failed');
            return { [key]: local[key] };
          },
          async set(value) {
            if (writeFails) throw new Error('write failed');
            Object.assign(local, value);
          },
        },
        session: {
          async get(key) { return { [key]: session[key] }; },
          async set(value) { Object.assign(session, value); },
          async remove(key) {
            if (removeFails) throw new Error('remove failed');
            delete session[key];
          },
        },
      },
    },
  });
  for (const [filename, source] of sources) vm.runInContext(source, context, { filename });
  return {
    local, session, sockets, calls, broadcasts,
    failRemoves(value) { removeFails = value; },
    failWrites(value) { writeFails = value; },
    dispatch(message, sender = popup) {
      return new Promise((resolve) => {
        if (!listener(message, sender, resolve)) queueMicrotask(() => resolve(undefined));
      });
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const save = (h, serverUrl) => h.dispatch({ kind: 'set-server', serverUrl });
const status = (h) => h.dispatch({ kind: 'get-status' });

const fresh = harness({ session: { activeRoom: { ...oldRoom } } });
assert.equal((await status(fresh)).serverUrl, '', 'старая сессия не должна задавать сервер');
assert.equal(fresh.session.activeRoom, undefined);
for (const kind of ['create-room', 'join-room']) {
  assert.equal((await fresh.dispatch({ kind, code: 'ABCD', serverUrl: oldRoom.serverUrl })).ok, false);
}
assert.equal(fresh.calls.length + fresh.sockets.length, 0, 'без настройки сеть не используется');
for (const url of ['', 'example.com', 'ftp://example.com', 'https://u:p@example.com',
  'https://example.com?x=1', 'https://example.com#fragment', 'https://example.com?',
  'https://example.com/#', 'https://exa mple.com', 'https://example.com\\api']) {
  assert.equal((await save(fresh, url)).ok, false, `некорректный URL принят: ${url}`);
}
assert.equal((await fresh.dispatch({ kind: 'set-server', serverUrl: oldRoom.serverUrl }, {
  id: 'test', url: 'https://video.example.com', tab: { id: 11 },
})).ok, false, 'content script не может менять сервер');
assert.equal((await fresh.dispatch({ kind: 'set-server', serverUrl: oldRoom.serverUrl }, {
  id: 'another-extension', url: popup.url,
})).ok, false);
assert.equal((await save(fresh, '  HTTPS://Backend.EXAMPLE.com:443/synodic///  ')).ok, true);
assert.equal(fresh.local.serverUrl, 'https://backend.example.com/synodic');
assert.equal(fresh.calls.length + fresh.sockets.length, 0, 'сохранение не открывает комнату');
const create = fresh.dispatch({ kind: 'create-room', serverUrl: 'https://ignored.example.com' });
await tick();
assert.deepEqual(fresh.calls, ['https://backend.example.com/synodic/api/rooms']);
assert.equal(fresh.sockets[0].url, 'wss://backend.example.com/synodic/ws?room=ABCD');
fresh.sockets[0].join();
assert.equal((await create).ok, true);
await tick();
const same = await save(fresh, 'https://BACKEND.example.com:443/synodic/');
assert.equal(same.room.code, 'ABCD', 'тот же адрес должен сохранить комнату');
assert.equal(fresh.sockets.length, 1);
assert.equal(fresh.sockets[0].readyState, 1);
fresh.failWrites(true);
assert.equal((await save(fresh, 'http://localhost:8787')).ok, false);
assert.equal((await status(fresh)).room.code, 'ABCD', 'ошибка записи не должна отключать комнату');
assert.equal((await status(fresh)).serverUrl, 'https://backend.example.com/synodic');
fresh.failWrites(false);

const resumed = harness({ local: fresh.local, session: { ...fresh.session } });
assert.equal((await status(resumed)).reconnecting, true);
assert.equal(resumed.sockets[0].url, 'wss://backend.example.com/synodic/ws?room=ABCD');
resumed.sockets[0].join();
const restartedBrowser = harness({ local: fresh.local });
assert.equal((await status(restartedBrowser)).serverUrl, fresh.local.serverUrl);
assert.equal((await status(restartedBrowser)).room, null);
assert.equal(restartedBrowser.sockets.length, 0);

fresh.failRemoves(true);
const changed = await save(fresh, 'http://localhost:8787/new-base');
assert.equal(changed.ok, true, 'ошибка уборки старой сессии не отменяет сохранённую настройку');
assert.equal(changed.leftRoom, true);
assert.equal(changed.room, null);
assert.equal(fresh.sockets[0].readyState, 3);
assert.equal(fresh.session.activeRoom.serverUrl, 'https://backend.example.com/synodic');
assert.equal(fresh.local.serverUrl, 'http://localhost:8787/new-base');
assert.equal(fresh.broadcasts.at(-1).state.serverUrl, 'http://localhost:8787/new-base');
assert.equal(fresh.broadcasts.at(-1).state.room, null, 'popup должен узнать об отключении даже при ошибке уборки');
const failedCleanupRestart = harness({ local: fresh.local, session: { ...fresh.session } });
assert.equal((await status(failedCleanupRestart)).room, null);
assert.equal(failedCleanupRestart.sockets.length, 0, 'неудалённая старая сессия не должна восстановиться');
fresh.failRemoves(false);
const join = fresh.dispatch({ kind: 'join-room', code: 'QWER', serverUrl: oldRoom.serverUrl });
await tick();
assert.equal(fresh.sockets[1].url, 'ws://localhost:8787/new-base/ws?room=QWER');
fresh.sockets[1].join();
assert.equal((await join).ok, true);

const mismatch = harness({ local: { serverUrl: 'https://new.example.com' }, session: { activeRoom: oldRoom } });
assert.equal((await status(mismatch)).room, null);
assert.equal(mismatch.sockets.length, 0, 'несовпадающая сессия не подключается к старому серверу');
const corrupt = harness({ local: { serverUrl: 'javascript:bad' }, session: { activeRoom: oldRoom } });
assert.equal((await status(corrupt)).serverUrl, '');
assert((await status(corrupt)).configurationError);
assert.equal(corrupt.sockets.length, 0);
const unreadable = harness({ readFails: true });
assert((await status(unreadable)).configurationError);
assert.equal((await save(unreadable, 'https://backend.example.com')).ok, true);
assert.equal((await status(unreadable)).configurationError, null);

let releaseRead;
const delayed = harness({ local: { serverUrl: oldRoom.serverUrl }, beforeRead: new Promise((resolve) => { releaseRead = resolve; }) });
const pendingSave = save(delayed, 'https://new.example.com');
await tick();
assert.equal(delayed.local.serverUrl, oldRoom.serverUrl, 'запись должна дождаться чтения');
releaseRead();
assert.equal((await pendingSave).serverUrl, 'https://new.example.com');
assert.equal((await status(delayed)).serverUrl, 'https://new.example.com');

const concurrent = harness({ local: { serverUrl: oldRoom.serverUrl } });
const pendingCreate = concurrent.dispatch({ kind: 'create-room' });
await tick();
const queuedSave = save(concurrent, 'https://new.example.com');
concurrent.sockets[0].join();
await pendingCreate;
assert.equal((await queuedSave).serverUrl, 'https://new.example.com');
assert.equal((await status(concurrent)).room, null, 'старое подключение не должно восстановить комнату после смены сервера');
assert.equal(concurrent.session.activeRoom, undefined);
console.log('✓ settings smoke: setup, URL validation, authority, paths, persistence, migration, failures and races');
