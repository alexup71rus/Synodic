/**
 * Разбор ссылок на видео: обычных и embed.
 * Возвращает нормализованный источник для комнаты:
 *   { provider: 'youtube' | 'rutube', videoId, startAt?, p? }
 */

const SynodicLinks = (() => {
  const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
  const RUTUBE_ID = /^[0-9a-f]{32}$/i;

  /** `90`, `1m30s`, `58s` → секунды */
  function parseStart(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number(value);
    const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match) return 0;
    const [, h, m, s] = match;
    return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0);
  }

  function youtube(url) {
    const host = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
    let id = null;

    if (host === 'youtu.be') {
      id = url.pathname.slice(1).split('/')[0];
    } else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (url.pathname === '/watch') {
        id = url.searchParams.get('v');
      } else {
        const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
        if (match) id = match[1];
      }
    }

    if (!id || !YOUTUBE_ID.test(id)) return null;
    return {
      provider: SynodicProtocol.PROVIDER_YOUTUBE,
      videoId: id,
      startAt: parseStart(url.searchParams.get('t') || url.searchParams.get('start')),
    };
  }

  function rutube(url) {
    if (!url.hostname.replace(/^www\./, '').endsWith('rutube.ru')) return null;

    let id = null;
    let p = url.searchParams.get('p') || undefined;

    const embed = url.pathname.match(/^\/play\/embed\/([^/?]+)/);
    const plain = url.pathname.match(/^\/video\/(?:private\/)?([^/?]+)/);
    const shorts = url.pathname.match(/^\/shorts\/([^/?]+)/);
    if (embed) id = embed[1];
    else if (plain) id = plain[1];
    else if (shorts) id = shorts[1];

    if (!id || !RUTUBE_ID.test(id)) return null;
    return {
      provider: SynodicProtocol.PROVIDER_RUTUBE,
      videoId: id,
      p,
      startAt: parseStart(url.searchParams.get('t')),
    };
  }

  return {
    /** Строка → источник или null. Принимает мусор спокойно. */
    parse(raw) {
      const text = String(raw || '').trim();
      if (!text) return null;
      let url;
      try {
        url = new URL(text.startsWith('http') ? text : `https://${text}`);
      } catch {
        return null;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return youtube(url) || rutube(url);
    },
  };
})();
