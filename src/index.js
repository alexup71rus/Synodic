/**
 * SynodicServe — сервер комнат для Synodic.
 *
 * HTTP:
 *   GET  /           → статика фронтенда (public/ или ../SynodicWeb)
 *   POST /api/rooms  → { code }   создать комнату (тело: { video? })
 *   GET  /health     → { ok }     живой ли процесс
 * WebSocket:
 *   /ws?room=<code>              войти в комнату (MVP: максимум 2 участника)
 *
 * Протокол (JSON):
 *   клиент → сервер:  { type: 'sync', event: { type, currentTime, rate, ts } }
 *                     { type: 'video', video: { provider, videoId, startAt?, p? } }
 *                     { type: 'ready' } / { type: 'keepalive' }
 *   сервер → клиент:  { type: 'joined', code, peers, state, video }
 *                     { type: 'peer-joined' | 'peer-left', peers }
 *                     { type: 'peer-ready' }
 *                     { type: 'sync', event }   — событие или heartbeat
 *                     { type: 'video', video }  — сменили видео
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { RoomRegistry, normalizeVideo } from './rooms.js';
import { resolveStaticDir, serveStatic } from './static.js';

const PORT = Number(process.env.PORT || 8787);
const MAX_PEERS = 2; // MVP: просмотр вдвоём
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const VIDEO_HEARTBEAT_MS = 3 * 1000;
const TRANSPORT_HEARTBEAT_MS = 30 * 1000;
const BODY_LIMIT = 4 * 1024;
const POSTERS_CACHE_MS = 12 * 60 * 60 * 1000;
const POSTERS_COUNT = 4;

process.title = 'synodic-serve'; // чтобы deploy.sh мог делать pkill -x synodic-serve

const registry = new RoomRegistry();
const staticDir = resolveStaticDir();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://synodic.local');

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return sendJson(res, parsed.status, { error: parsed.error });
    const body = parsed.body;
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      return sendJson(res, 400, { error: 'invalid json body' });
    }
    const hasVideo = body && Object.hasOwn(body, 'video');
    const video = hasVideo ? normalizeVideo(body.video) : null;
    if (hasVideo && !video) return sendJson(res, 400, { error: 'invalid video' });
    const room = registry.create(video);
    return sendJson(res, 201, { code: room.code });
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { ok: true, rooms: registry.size() });
  }
  if (req.method === 'GET' && url.pathname === '/api/posters') {
    return handlePosters(res);
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && staticDir &&
      serveStatic(staticDir, req, res, url)) {
    return;
  }
  return sendJson(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://synodic.local');
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

const sweepTimer = setInterval(() => registry.sweep(), SWEEP_INTERVAL_MS);
const videoHeartbeatTimer = setInterval(() => registry.heartbeat(), VIDEO_HEARTBEAT_MS);
const transportHeartbeatTimer = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, TRANSPORT_HEARTBEAT_MS);
sweepTimer.unref();
videoHeartbeatTimer.unref();
transportHeartbeatTimer.unref();

server.listen(PORT, () => {
  console.log(`[synodic-serve] listening on :${PORT}` + (staticDir ? `, static: ${staticDir}` : ', static: нет'));
});

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return resolve({ ok: false, status: 413, error: 'body too large' });
      if (chunks.length === 0) return resolve({ ok: true, body: null });
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, status: 400, error: 'invalid json' });
      }
    });
    req.on('error', () => resolve({ ok: false, status: 400, error: 'request error' }));
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // фронт и расширение могут жить где угодно
  });
  res.end(JSON.stringify(body));
}

// Витрина «в топе» на стартовом экране. Включается переменной окружения
// TMDB_TOKEN (бесплатный ключ с themoviedb.org — у Кинопоиска официального
// публичного API нет). Без токена отдаём пустой список, фронт молчит;
// ответ кешируется на 12 часов — дёргаем TMDB дважды в сутки.
let postersCache = { at: 0, items: [] };

async function handlePosters(res) {
  const token = process.env.TMDB_TOKEN;
  if (!token) return sendJson(res, 200, { items: [] });
  if (postersCache.items.length && Date.now() - postersCache.at < POSTERS_CACHE_MS) {
    return sendJson(res, 200, { items: postersCache.items });
  }
  try {
    const url = new URL('https://api.themoviedb.org/3/trending/movie/week');
    url.searchParams.set('language', 'ru-RU');
    url.searchParams.set('api_key', token);
    const api = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!api.ok) throw new Error(`tmdb ответил ${api.status}`);
    const data = await api.json();
    const items = (data.results || [])
      .filter((movie) => movie.poster_path)
      .slice(0, POSTERS_COUNT)
      .map((movie) => ({
        title: movie.title || movie.original_title || '',
        poster: `https://image.tmdb.org/t/p/w300${movie.poster_path}`,
      }));
    postersCache = { at: Date.now(), items };
    return sendJson(res, 200, { items });
  } catch (error) {
    console.warn('[synodic-serve] постеры TMDB не получены:', error.message);
    return sendJson(res, 200, { items: postersCache.items }); // отдаём stale-кэш
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[synodic-serve] ${signal}: завершаем соединения`);
  clearInterval(sweepTimer);
  clearInterval(videoHeartbeatTimer);
  clearInterval(transportHeartbeatTimer);
  for (const client of wss.clients) client.close(1012, 'server restart');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
