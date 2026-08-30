#!/usr/bin/env node

/** Регрессия reconnect: каждая новая попытка должна заново дождаться joined. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const sockets = [];
const timers = [];

class FakeWebSocket {
  static OPEN = 1;

  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.sent = [];
    this.closedWith = null;
    sockets.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(value) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code, reason });
  }
}

const context = vm.createContext({
  AbortSignal,
  URL,
  WebSocket: FakeWebSocket,
  location: { origin: 'https://synodic.example', protocol: 'https:' },
  fetch: async () => ({ ok: true, json: async () => ({ code: 'ABCD' }) }),
  setTimeout(callback, delay) {
    const timer = { callback, delay, active: true };
    timers.push(timer);
    return timer;
  },
  clearTimeout(timer) {
    if (timer) timer.active = false;
  },
  setInterval() { return {}; },
  clearInterval() {},
});

for (const filename of ['js/protocol.js', 'js/links.js', 'js/net.js']) {
  vm.runInContext(await readFile(new URL(filename, root), 'utf8'), context, { filename });
}

const parseVideoLink = vm.runInContext('SynodicLinks.parse', context);
assert.deepEqual(
  JSON.parse(JSON.stringify(parseVideoLink('https://vkvideo.ru/video-31038184_456244573'))),
  { provider: 'vk', ownerId: '-31038184', videoId: '456244573' },
  'обычная ссылка VK Video не распознана',
);
assert.deepEqual(
  JSON.parse(JSON.stringify(parseVideoLink(
    'https://vk.com/video_ext.php?oid=-31038184&id=456244573&hash=3d1ea1738f548565&hd=4',
  ))),
  {
    provider: 'vk',
    ownerId: '-31038184',
    videoId: '456244573',
    hash: '3d1ea1738f548565',
  },
  'embed-ссылка VK Video не распознана',
);

const RoomConnection = vm.runInContext('SynodicNet.RoomConnection', context);
const connection = new RoomConnection('ABCD');
const statuses = [];
const terminalCloses = [];
connection.on('status', (state) => statuses.push(state));
connection.on('closed', (event) => terminalCloses.push(event));

const first = sockets[0];
first.open();
first.message({ type: 'joined', code: 'ABCD', peers: 1, state: null, video: null });
first.close(1006, 'network lost');
runTimer(1000);

const reconnect = sockets[1];
assert(reconnect, 'reconnect не создал новый WebSocket');
reconnect.open();
runTimer(10000);

assert.deepEqual(
  reconnect.closedWith,
  { code: 4001, reason: 'join timeout' },
  'reconnect без joined не закрылся по таймауту',
);
assert.equal(terminalCloses.length, 0, 'временный reconnect забыл комнату');
assert.equal(statuses.at(-1)?.reconnecting, true, 'после таймаута не запланирован reconnect');

console.log('✓ web net smoke: reconnect повторно требует joined');

function runTimer(delay) {
  const timer = timers.find((candidate) => candidate.active && candidate.delay === delay);
  assert(timer, `нет активного таймера ${delay} мс`);
  timer.active = false;
  timer.callback();
}
