/** Безопасное получение embed-hash публичного VK Video без пользовательского токена. */

const VK_OWNER_ID = /^-?\d{1,20}$/;
const VK_VIDEO_ID = /^\d{1,20}$/;
const VK_HASH = /^[A-Za-z0-9_-]{8,128}$/;
const VK_EMBED_HOSTS = new Set(['vk.com', 'vk.ru', 'vkvideo.ru']);
const VK_API_VERSION = '5.199';

export class VkVideoUnavailableError extends Error {}

export function validateVkIds(ownerId, videoId) {
  return typeof ownerId === 'string' && VK_OWNER_ID.test(ownerId) &&
    typeof videoId === 'string' && VK_VIDEO_ID.test(videoId);
}

/**
 * Разобрать только официальный iframe из ответа oEmbed и убедиться, что VK
 * вернул ровно тот ролик, который мы запрашивали.
 */
export function parseVkOembedHtml(html, ownerId, videoId) {
  if (typeof html !== 'string' || !validateVkIds(ownerId, videoId)) return null;
  const match = html.match(/<iframe\b[^>]*\bsrc=(['"])(.*?)\1/i);
  if (!match) return null;

  const rawSrc = match[2]
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&');
  let embed;
  try {
    embed = new URL(rawSrc);
  } catch {
    return null;
  }

  const host = embed.hostname.toLowerCase().replace(/^www\./, '');
  if (embed.protocol !== 'https:' || !VK_EMBED_HOSTS.has(host) ||
      (embed.pathname !== '/video_ext.php' && embed.pathname !== '/video_embed.php') ||
      embed.searchParams.get('oid') !== ownerId || embed.searchParams.get('id') !== videoId) {
    return null;
  }

  const hash = embed.searchParams.get('hash');
  return VK_HASH.test(hash || '') ? { hash } : null;
}

export async function fetchVkOembed(ownerId, videoId, fetchImpl = fetch) {
  if (!validateVkIds(ownerId, videoId)) throw new TypeError('invalid VK video id');

  const publicVideo = `https://vkvideo.ru/video${ownerId}_${videoId}`;
  const endpoint = new URL('https://api.vk.com/method/video.getOembed');
  endpoint.searchParams.set('url', publicVideo);
  endpoint.searchParams.set('v', VK_API_VERSION);

  const response = await fetchImpl(endpoint, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`VK oEmbed ответил ${response.status}`);

  const payload = await response.json();
  if (payload?.error) throw new VkVideoUnavailableError('VK не отдал embed для этого видео');
  const resolved = parseVkOembedHtml(payload?.response?.html, ownerId, videoId);
  if (!resolved) throw new VkVideoUnavailableError('VK не отдал корректный embed для этого видео');
  return resolved;
}
