/**
 * Smoke-тест: создаёт комнату, подключает двух участников и проверяет,
 * что событие от одного доходит до другого.
 *
 * Запуск при поднятом сервере:  node scripts/smoke.mjs [baseUrl]
 */
import { WebSocket } from 'ws';

const base = process.argv[2] || 'http://localhost:8787';
const wsBase = base.replace(/^http/, 'ws');

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const res = await fetch(`${base}/api/rooms`, { method: 'POST' });
if (res.status !== 201) fail(`POST /api/rooms → ${res.status}`);
const { code } = await res.json();

const a = new WebSocket(`${wsBase}/ws?room=${code}`);
const b = new WebSocket(`${wsBase}/ws?room=${code}`);

const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('таймаут ожидания сообщений')), 5000);

  a.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    // когда B вошёл в комнату — A жмёт play
    if (msg.type === 'peer-joined') {
      a.send(JSON.stringify({
        type: 'sync',
        event: { type: 'play', currentTime: 42, ts: Date.now() },
      }));
    }
  };
  b.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'sync') return;
    clearTimeout(timer);
    if (msg.event.type === 'play' && msg.event.currentTime === 42) resolve();
    else reject(new Error(`неожиданное событие: ${e.data}`));
  };
  for (const ws of [a, b]) {
    ws.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`соединение закрыто (code ${e.code})`));
    };
  }
});

try {
  await done;
  console.log(`✓ комната ${code}: оба участника подключены, sync доставлен`);
  a.close();
  b.close();
  process.exit(0);
} catch (e) {
  fail(e.message);
}
