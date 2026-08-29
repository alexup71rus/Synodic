/**
 * SynodicServe — сервер комнат для Synodic.
 *
 * HTTP:
 *   POST /api/rooms  → { code }   создать комнату
 *   GET  /health     → { ok }     живой ли процесс
 * WebSocket:
 *   /ws?room=<code>              войти в комнату (MVP: максимум 2 участника)
 *
 * Протокол (JSON):
 *   клиент → сервер:  { type: 'sync', event: { type, currentTime, rate, ts } }
 *                     { type: 'keepalive' }
 *   сервер → клиент:  { type: 'joined', code, state }
 *                     { type: 'peer-joined' | 'peer-left', peers }
 *                     { type: 'sync', event }   — событие или heartbeat
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomRegistry } from './rooms.js';

const PORT = Number(process.env.PORT || 8787);
const MAX_PEERS = 2; // MVP: просмотр вдвоём
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const VIDEO_HEARTBEAT_MS = 3 * 1000;
const TRANSPORT_HEARTBEAT_MS = 30 * 1000;

process.title = 'synodic-serve'; // чтобы deploy.sh мог делать pkill -x synodic-serve

const registry = new RoomRegistry();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const room = registry.create();
    return sendJson(res, 201, { code: room.code });
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, rooms: registry.size() });
  }
  return sendJson(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') return socket.destroy();
  const room = registry.get(url.searchParams.get('room'));

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (!room) {
      ws.close(4004, 'room not found');
      return;
    }
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    room.join(ws, MAX_PEERS);
  });
});

setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS).unref();
setInterval(() => registry.heartbeat(), VIDEO_HEARTBEAT_MS).unref();
setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, TRANSPORT_HEARTBEAT_MS).unref();

server.listen(PORT, () => {
  console.log(`[synodic-serve] listening on :${PORT}`);
});

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // расширение ходит с chrome-extension://
  });
  res.end(JSON.stringify(body));
}
