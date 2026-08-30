/**
 * Безопасно извлекает источник, который сайт Synodic умеет открыть сам.
 * Произвольные адреса страниц расширение на сервер не отправляет.
 */
globalThis.SynodicVideoSource = Object.freeze((() => {
  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  const RUTUBE_ID = /^[0-9a-f]{32}$/i;
  const VK_OWNER_ID = /^-?\d{1,20}$/;
  const VK_VIDEO_ID = /^\d{1,20}$/;
  const VK_HASH = /^[A-Za-z0-9_-]{8,128}$/;

  function parseStart(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number(value);
    const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match) return 0;
    const [, hours, minutes, seconds] = match;
    return Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0);
  }

  function youtube(url) {
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    let videoId = null;
    if (host === 'youtu.be') {
      videoId = url.pathname.slice(1).split('/')[0];
    } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (url.pathname === '/watch') videoId = url.searchParams.get('v');
      else videoId = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/)?.[1] || null;
    }
    if (!videoId || !YOUTUBE_ID.test(videoId)) return null;
    return {
      provider: SynodicProtocol.PROVIDER_YOUTUBE,
      videoId,
      startAt: parseStart(url.searchParams.get('t') || url.searchParams.get('start')),
    };
  }

  function rutube(url) {
    if (!url.hostname.replace(/^www\./, '').endsWith('rutube.ru')) return null;
    const videoId = url.pathname.match(/^\/play\/embed\/([^/?]+)/)?.[1]
      || url.pathname.match(/^\/video\/(?:private\/)?([^/?]+)/)?.[1]
      || url.pathname.match(/^\/shorts\/([^/?]+)/)?.[1]
      || null;
    if (!videoId || !RUTUBE_ID.test(videoId)) return null;
    const source = {
      provider: SynodicProtocol.PROVIDER_RUTUBE,
      videoId,
      startAt: parseStart(url.searchParams.get('t')),
    };
    const p = url.searchParams.get('p');
    if (p) source.p = p;
    return source;
  }

  function vk(url) {
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host !== 'vk.com' && host !== 'vk.ru' && host !== 'vkvideo.ru') return null;

    let ownerId = null;
    let videoId = null;
    let hash;
    if (url.pathname === '/video_ext.php' || url.pathname === '/video_embed.php') {
      ownerId = url.searchParams.get('oid');
      videoId = url.searchParams.get('id');
      const rawHash = url.searchParams.get('hash');
      if (rawHash && VK_HASH.test(rawHash)) hash = rawHash;
    } else {
      const match = url.pathname.match(/^\/video(-?\d{1,20})_(\d{1,20})(?:\/|$)/);
      if (match) [, ownerId, videoId] = match;
    }

    if (!VK_OWNER_ID.test(ownerId || '') || !VK_VIDEO_ID.test(videoId || '')) return null;
    const source = {
      provider: SynodicProtocol.PROVIDER_VK,
      ownerId,
      videoId,
    };
    if (hash) source.hash = hash;
    return source;
  }

  return {
    parse(raw) {
      let url;
      try {
        url = new URL(String(raw || ''));
      } catch {
        return null;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return youtube(url) || rutube(url) || vk(url);
    },
  };
})());
