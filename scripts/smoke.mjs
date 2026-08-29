/**
 * Smoke-тест: проверяет комнату на двоих, heartbeat, снапшот при повторном
 * подключении и отказ третьему участнику.
 *
 * Запуск при поднятом сервере: node scripts/smoke.mjs [baseUrl]
 */
import { WebSocket } from 'ws';

const base = process.argv[2] || 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');
const peers = [];

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

try {
  const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
  assert(res.status === 201, `POST /api/rooms → ${res.status}`);
  const { code } = await res.json();
  const roomUrl = `${wsBase}/ws?room=${encodeURIComponent(code)}`;

  const a = createPeer(roomUrl);
  peers.push(a);
  const joinedA = await a.waitFor((message) => message.type === 'joined', 'joined для A');
  assert(joinedA.peers === 1, `A получил peers=${joinedA.peers}, ожидалось 1`);

  const peerJoinedA = a.waitFor(
    (message) => message.type === 'peer-joined',
    'peer-joined для A',
  );
  const b = createPeer(roomUrl);
  peers.push(b);
  const joinedB = await b.waitFor((message) => message.type === 'joined', 'joined для B');
  assert(joinedB.peers === 2, `B получил peers=${joinedB.peers}, ожидалось 2`);
  await peerJoinedA;

  const playB = b.waitFor(
    (message) => message.type === 'sync' && message.event?.type === 'play',
    'play для B',
  );
  a.send({
    type: 'sync',
    event: { type: 'play', currentTime: 12.5, rate: 1.25, ts: Date.now() },
  });
  await playB;

  const heartbeatB = b.waitFor(
    (message) => message.type === 'sync' && message.event?.type === 'heartbeat',
    'heartbeat для B',
  );
  const heartbeat = await heartbeatB;
  assert(heartbeat.event.currentTime >= 12.5, 'heartbeat отстал от play-события');
  assert(heartbeat.event.currentTime < 18, 'heartbeat неожиданно далеко ушёл вперёд');
  assert(heartbeat.event.rate === 1.25, 'heartbeat потерял скорость');

  const peerLeftA = a.waitFor((message) => message.type === 'peer-left', 'peer-left для A');
  b.close();
  await peerLeftA;

  a.send({
    type: 'sync',
    event: { type: 'play', currentTime: 42, rate: 1.25, ts: Date.now() },
  });

  const peerRejoinedA = a.waitFor(
    (message) => message.type === 'peer-joined',
    'повторный peer-joined для A',
  );
  const reconnected = createPeer(roomUrl);
  peers.push(reconnected);
  const joinedAgain = await reconnected.waitFor(
    (message) => message.type === 'joined',
    'joined после reconnect',
  );
  await peerRejoinedA;
  assert(joinedAgain.peers === 2, 'reconnect не видит первого участника');
  assert(joinedAgain.state.isPlaying === true, 'снапшот потерял play');
  assert(joinedAgain.state.currentTime >= 42, 'снапшот отстал от play-события');
  assert(joinedAgain.state.currentTime < 44, 'снапшот неожиданно далеко ушёл вперёд');
  assert(joinedAgain.state.rate === 1.25, 'снапшот потерял скорость');

  const third = createPeer(roomUrl);
  peers.push(third);
  const close = await third.waitForClose();
  assert(close.code === 4000, `третий участник получил close ${close.code}, ожидалось 4000`);

  const missing = createPeer(`${wsBase}/ws?room=missing-room`);
  peers.push(missing);
  const missingClose = await missing.waitForClose();
  assert(
    missingClose.code === 4004,
    `неизвестная комната получила close ${missingClose.code}, ожидалось 4004`,
  );

  console.log(`✓ комната ${code}: sync, reconnect и ошибки входа проверены`);
} catch (error) {
  fail(error.message);
} finally {
  for (const peer of peers) peer.close();
}

function createPeer(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  let closed = null;
  const closeWaiters = [];

  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex === -1) {
      messages.push(message);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });

  ws.on('close', (code, reason) => {
    closed = { code, reason: reason.toString() };
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`соединение закрыто до ${waiter.label} (code ${code})`));
    }
    for (const waiter of closeWaiters.splice(0)) waiter.resolve(closed);
  });

  ws.on('error', () => {
    // onclose завершит ожидающие проверки с понятным сообщением
  });

  return {
    send(message) {
      ws.send(JSON.stringify(message));
    },
    waitFor(predicate, label, timeoutMs = 5000) {
      const queuedIndex = messages.findIndex(predicate);
      if (queuedIndex !== -1) return Promise.resolve(messages.splice(queuedIndex, 1)[0]);
      if (closed) return Promise.reject(new Error(`соединение закрыто до ${label}`));

      return new Promise((resolve, reject) => {
        const waiter = { predicate, label, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`таймаут: ${label}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    waitForClose(timeoutMs = 5000) {
      if (closed) return Promise.resolve(closed);
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(value) {
            clearTimeout(waiter.timer);
            resolve(value);
          },
          timer: setTimeout(() => {
            const index = closeWaiters.indexOf(waiter);
            if (index !== -1) closeWaiters.splice(index, 1);
            reject(new Error('таймаут ожидания закрытия соединения'));
          }, timeoutMs),
        };
        closeWaiters.push(waiter);
      });
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
