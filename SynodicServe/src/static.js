/**
 * Раздача статики фронтенда (SynodicWeb) без внешних зависимостей.
 * Каталог задаётся SYNODIC_STATIC_DIR; по умолчанию — ./public (деплой),
 * а для локальной разработки — ../SynodicWeb.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export function resolveStaticDir() {
  if (process.env.SYNODIC_STATIC_DIR) return process.env.SYNODIC_STATIC_DIR;
  const candidates = [
    path.join(PROJECT_ROOT, 'public'),       // деплой: deploy.sh кладёт сюда
    path.join(PROJECT_ROOT, '..', 'SynodicWeb'), // дев: репозиторий рядом
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

/** Отдать файл или 404. Возвращает true, если запрос обработан. */
export function serveStatic(staticDir, req, res, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (pathname.includes('\0')) return false;

  const dir = path.resolve(staticDir);
  const dirWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  let filePath = path.normalize(path.join(dir, pathname));
  if (filePath !== dir && !filePath.startsWith(dirWithSep)) return false; // защита от выхода наружу

  if (pathname === '/' || pathname === '') {
    filePath = path.join(dir, 'index.html');
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  // код (html/js/css) всегда ревалидируем — после деплоя клиенты сразу
  // видят новую версию; картинки и шрифты можно кешировать подольше
  const cache = /\.(js|css|mjs|html)$/.test(filePath)
    ? 'no-cache'
    : 'public, max-age=3600';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': cache,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
}
