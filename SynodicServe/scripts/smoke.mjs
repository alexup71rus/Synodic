/**
 * Smoke-тест: проверяет комнату на двоих, heartbeat, снапшот при повторном
 * подключении и отказ третьему участнику.
 *
 * Запуск при поднятом сервере: node scripts/smoke.mjs [baseUrl]
 */
import { WebSocket } from 'ws';
import { SlidingWindowLimiter } from '../src/rate-limit.js';
import { RoomRegistry } from '../src/rooms.js';
import { parseVkOembedHtml } from '../src/vk-oembed.js';

const base = process.argv[2] || 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');
const peers = [];

const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

try {
  const boundedRegistry = new RoomRegistry({ maxRooms: 1 });
  const abandonedRoom = boundedRegistry.create();
  assert(abandonedRoom, 'ограниченный реестр не создал первую комнату');
  assert(boundedRegistry.create() === null, 'реестр превысил maxRooms');
  boundedRegistry.sweep(abandonedRoom.lastSeen + 15 * 60 * 1000 + 1);
  assert(boundedRegistry.size() === 0, 'непосещённая комната не истекла через 15 минут');

  const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
  assert(limiter.consume(1000) === 0 && limiter.consume(1100) === 0, 'лимитер рано отказал');
  assert(limiter.consume(1200) === 1, 'лимитер пропустил запрос сверх окна');
  assert(limiter.consume(2000) === 0, 'лимитер не освободил окно');

  const parsedVkEmbed = parseVkOembedHtml(
    '<iframe src="https://vk.com/video_ext.php?oid=-31038184&amp;id=456244573&amp;hash=3d1ea1738f548565"></iframe>',
    '-31038184',
    '456244573',
  );
  assert(parsedVkEmbed?.hash === '3d1ea1738f548565', 'oEmbed VK не разобран');
  assert(
    parseVkOembedHtml(
      '<iframe src="https://evil.example/video_ext.php?oid=-31038184&id=456244573&hash=3d1ea1738f548565"></iframe>',
      '-31038184',
      '456244573',
    ) === null,
    'oEmbed VK принял посторонний iframe',
  );

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
  // сервер принимает код в любом регистре, как обещает UI
  const b = createPeer(`${wsBase}/ws?room=${encodeURIComponent(code.toLowerCase())}`);
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

  const ignoredExtremeRate = b.expectNoMessage(
    (message) => message.type === 'sync' && message.event?.currentTime === 13,
    'событие с недопустимой скоростью',
  );
  a.send({
    type: 'sync',
    event: { type: 'ratechange', currentTime: 13, rate: 1000, ts: Date.now() },
  });
  await ignoredExtremeRate;

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

  // видео в комнате: создание с видео, смена и жест «готов»
  const videoRes = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      video: { provider: 'youtube', videoId: 'dQw4w9WgXcQ', startAt: 37 },
    }),
  });
  assert(videoRes.status === 201, `POST /api/rooms с видео → ${videoRes.status}`);
  const videoRoom = await videoRes.json();
  const videoRoomUrl = `${wsBase}/ws?room=${encodeURIComponent(videoRoom.code)}`;

  const host = createPeer(videoRoomUrl);
  peers.push(host);
  const guest = createPeer(videoRoomUrl);
  peers.push(guest);
  const joinedHost = await host.waitFor((message) => message.type === 'joined', 'joined для host');
  const joinedGuest = await guest.waitFor((message) => message.type === 'joined', 'joined для guest');
  assert(
    joinedHost.video?.provider === 'youtube' && joinedHost.video?.videoId === 'dQw4w9WgXcQ',
    'снапшот не отдал видео комнаты',
  );
  assert(joinedHost.video?.startAt === 37, 'снапшот потерял стартовую позицию');
  assert(joinedGuest.video?.videoId === 'dQw4w9WgXcQ', 'гость не получил видео комнаты');

  const videoOnGuest = guest.waitFor((message) => message.type === 'video', 'video для guest');
  host.send({
    type: 'video',
    video: { provider: 'rutube', videoId: 'a'.repeat(32), p: 'private_token-1', startAt: 12 },
  });
  const videoMessage = await videoOnGuest;
  assert(videoMessage.video?.provider === 'rutube', 'смена видео не дошла до напарника');
  assert(videoMessage.video?.p === 'private_token-1', 'смена видео потеряла приватный параметр');
  assert(videoMessage.video?.startAt === 12, 'смена видео потеряла стартовую позицию');

  const playAfterVideo = guest.waitFor(
    (message) => message.type === 'sync' && message.event?.type === 'play',
    'play после смены видео',
  );
  host.send({
    type: 'sync',
    event: { type: 'play', currentTime: 5, rate: 1, ts: Date.now() },
  });
  await playAfterVideo;

  const vkOnGuest = guest.waitFor((message) => message.type === 'video', 'VK video для guest');
  host.send({
    type: 'video',
    video: { provider: 'vk', ownerId: '-31038184', videoId: '456244573' },
  });
  const vkVideoMessage = await vkOnGuest;
  assert(vkVideoMessage.video?.provider === 'vk', 'VK-видео не дошло до напарника');
  assert(vkVideoMessage.video?.ownerId === '-31038184', 'VK-видео потеряло ownerId');

  const vkPlay = guest.waitFor(
    (message) => message.type === 'sync' && message.event?.type === 'play',
    'VK play для guest',
  );
  host.send({
    type: 'sync',
    event: { type: 'play', currentTime: 8, rate: 1.5, ts: Date.now() },
  });
  const vkPlayMessage = await vkPlay;
  assert(vkPlayMessage.event.rate === 1, 'VK play изменил серверную скорость');

  const ignoredVkRate = guest.expectNoMessage(
    (message) => message.type === 'sync' && message.event?.type === 'ratechange',
    'VK ratechange',
  );
  host.send({
    type: 'sync',
    event: { type: 'ratechange', currentTime: 9, rate: 1.5, ts: Date.now() },
  });
  await ignoredVkRate;

  const readyOnGuest = guest.waitFor((message) => message.type === 'peer-ready', 'peer-ready');
  host.send({ type: 'ready' });
  await readyOnGuest;

  // статика фронтенда
  const index = await fetch(`${base}/`);
  const indexHtml = await index.text();
  assert(index.status === 200 && indexHtml.includes('Synodic'), 'index.html не отдаётся');
  assert(indexHtml.includes('property="og:image"') && indexHtml.includes('/icons/og-cover.jpg'),
    'Open Graph-обложка не указана в index.html');
  const css = await fetch(`${base}/css/main.css`);
  assert(css.status === 200, 'css не отдаётся');
  const ogCover = await fetch(`${base}/icons/og-cover.jpg`);
  assert(ogCover.status === 200, 'Open Graph-обложка не отдаётся');
  assert(ogCover.headers.get('content-type') === 'image/jpeg',
    `Open Graph-обложка имеет Content-Type ${ogCover.headers.get('content-type')}`);

  const invalidVideo = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: { provider: 'youtube', videoId: 'bad' } }),
  });
  assert(invalidVideo.status === 400, `невалидное видео → ${invalidVideo.status}, ожидалось 400`);

  const invalidVk = await fetch(`${base}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: { provider: 'vk', ownerId: 'oops', videoId: '456244573' } }),
  });
  assert(invalidVk.status === 400, `невалидное VK-видео → ${invalidVk.status}, ожидалось 400`);

  const invalidVkOembed = await fetch(`${base}/api/vk-oembed?ownerId=oops&videoId=456244573`);
  assert(invalidVkOembed.status === 400, `невалидный VK oEmbed → ${invalidVkOembed.status}`);

  console.log(`✓ комната ${code}: sync, reconnect, видео, ready, статика проверены`);
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
    expectNoMessage(predicate, label, timeoutMs = 180) {
      const queuedIndex = messages.findIndex(predicate);
      if (queuedIndex !== -1) {
        messages.splice(queuedIndex, 1);
        return Promise.reject(new Error(`${label} не было отклонено`));
      }
      if (closed) return Promise.reject(new Error(`соединение закрыто при проверке: ${label}`));

      return new Promise((resolve, reject) => {
        const waiter = { predicate, label, resolve: null, reject: null, timer: null };
        waiter.resolve = () => {
          clearTimeout(waiter.timer);
          reject(new Error(`${label} не было отклонено`));
        };
        waiter.reject = reject;
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          resolve();
        }, timeoutMs);
        waiters.push(waiter);
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
