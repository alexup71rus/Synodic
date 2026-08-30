/**
 * Content script Synodic: находит на странице HTML5-<video>, отслеживает
 * его состояние (play / pause / seek / скорость) и применяет события,
 * пришедшие от второго участника через service worker.
 *
 * MVP-подход: работаем с самым большим видимым видео вне рекламных блоков и
 * перепроверяем выбор поллингом — плееры часто создаются динамически.
 */

(() => {
const CONTENT_REVISION = '0.3.1-20260830-1';
if (globalThis.__synodicContentRevision === CONTENT_REVISION) return;
globalThis.__synodicContentRevision = CONTENT_REVISION;
const SynodicProtocol = globalThis.SynodicProtocol;

const FIND_INTERVAL_MS = 1500; // как часто ищем видео, пока его нет
const RECHECK_INTERVAL_MS = 3000;
const MIN_VIDEO_WIDTH = 120;
const MIN_VIDEO_HEIGHT = 68;
const SEEK_EPSILON_S = 0.3;       // порог для явных play / pause / seek
const HEARTBEAT_EPSILON_S = 0.5;  // heartbeat не дёргает видео при малом дрейфе
const ECHO_GUARD_MS = 1500;
const MAX_VIDEO_TIME_S = 7 * 24 * 60 * 60;
const MAX_PLAYBACK_RATE = 16;
const LOCAL_EVENT_TYPES = ['play', 'pause', 'seeked', 'ratechange'];
const MEDIA_READY_EVENT_TYPES = ['loadedmetadata', 'durationchange'];
const PROMO_CONTEXT_DEPTH = 6;
const PROMO_TOKEN = /(?:^|[-_: \t])(ads?|advert(?:isement)?|commercial|promo(?:tional)?|pre-?roll|mid-?roll|post-?roll|sponsor(?:ed)?|banner|vast)(?:$|[-_: \t])/i;
const PROMO_DATA_ATTRIBUTES = [
  'data-ad',
  'data-ads',
  'data-ad-slot',
  'data-ad-unit',
  'data-advertisement',
  'data-promo',
];

let video = null;
let pendingRemoteEvent = null;
let monitoring = false;
let watchTimer = null;
let intersectionAreas = new WeakMap();
const observedVideos = new Set();
const expectedEchoes = new Map();
const visibilityObserver = typeof IntersectionObserver === 'function'
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        intersectionAreas.set(entry.target, entry.intersectionRect);
      }
      if (monitoring) refreshVideoSelection();
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1] })
  : null;

// --- поиск и подключение к видео -------------------------------------------

function pickVideo() {
  const lightVideos = document.querySelectorAll('video');
  return pickBestVideo(lightVideos) || pickBestVideo(findShadowVideos(document));
}

function pickBestVideo(candidates) {
  let best = null;
  let bestArea = 0;
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    const area = visibleVideoArea(candidate, rect);
    if (area === 0 || isPromotionalVideo(candidate)) continue;
    if (document.fullscreenElement?.contains(candidate)) return candidate;

    if (area > bestArea || (area === bestArea && candidate === video)) {
      bestArea = area;
      best = candidate;
    }
  }
  return best;
}

function findShadowVideos(root) {
  const videos = [];
  for (const host of root.querySelectorAll('*')) {
    let shadowRoot = host.shadowRoot;
    try {
      if (!shadowRoot && host.localName?.includes('-')) {
        shadowRoot = chrome.dom?.openOrClosedShadowRoot?.(host) || null;
      }
    } catch {
      shadowRoot = null;
    }
    if (!shadowRoot) continue;
    videos.push(...shadowRoot.querySelectorAll('video'));
    videos.push(...findShadowVideos(shadowRoot));
  }
  return videos;
}

function visibleVideoArea(candidate, rect) {
  observeVideo(candidate);
  if (candidate.hidden || candidate.getAttribute('aria-hidden') === 'true') {
    return 0;
  }
  const style = getComputedStyle(candidate);
  if (style.display === 'none' || style.visibility === 'hidden' ||
      Number.parseFloat(style.opacity || '1') <= 0) {
    return 0;
  }

  // IntersectionObserver с implicit root учитывает clipping на пути через
  // nested browsing contexts. До первого async-замера используем viewport
  // текущего frame как безопасный fallback.
  const intersection = intersectionAreas.get(candidate);
  const visibleWidth = intersection
    ? intersection.width
    : Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
  const visibleHeight = intersection
    ? intersection.height
    : Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
  if (visibleWidth < MIN_VIDEO_WIDTH || visibleHeight < MIN_VIDEO_HEIGHT) return 0;
  return visibleWidth * visibleHeight;
}

function observeVideo(candidate) {
  if (!visibilityObserver || observedVideos.has(candidate)) return;
  observedVideos.add(candidate);
  visibilityObserver.observe(candidate);
}

function isPromotionalVideo(candidate) {
  let node = candidate;
  for (let depth = 0; node && depth < PROMO_CONTEXT_DEPTH; depth += 1) {
    if (node === document.body || node === document.documentElement) break;
    if (PROMO_DATA_ATTRIBUTES.some((attribute) => node.hasAttribute(attribute))) {
      return true;
    }

    const context = [
      node.id,
      typeof node.className === 'string' ? node.className : '',
      node.getAttribute('aria-label'),
      node.getAttribute('data-testid'),
      node.getAttribute('data-test'),
    ].filter(Boolean).join(' ');
    if (PROMO_TOKEN.test(context)) return true;
    node = node.parentElement || node.getRootNode?.().host || null;
  }
  return false;
}

function watchForVideo() {
  watchTimer = null;
  if (!monitoring) return;
  refreshVideoSelection();
  watchTimer = setTimeout(watchForVideo, video ? RECHECK_INTERVAL_MS : FIND_INTERVAL_MS);
}

function refreshVideoSelection() {
  if (!monitoring) return;
  const found = pickVideo();
  if (found !== video) {
    detachVideo();
    if (found) {
      video = found;
      for (const type of LOCAL_EVENT_TYPES) {
        video.addEventListener(type, onLocalEvent);
      }
      for (const type of MEDIA_READY_EVENT_TYPES) {
        video.addEventListener(type, retryPendingEvent);
      }
      reportVideoCandidate(true);
      console.info('[synodic] видео найдено:', video.currentSrc || video);
    }
  } else if (video) {
    // Service worker использует эти сигналы как lease: исчезнувший iframe
    // сам освободит выбор, даже если unload не успел отправить сообщение.
    reportVideoCandidate(true);
  }
}

function setMonitoring(active) {
  const next = active === true;
  if (monitoring === next) {
    if (monitoring && video) reportVideoCandidate(true);
    return;
  }

  monitoring = next;
  clearTimeout(watchTimer);
  watchTimer = null;
  if (monitoring) watchForVideo();
  else {
    detachVideo();
    visibilityObserver?.disconnect();
    observedVideos.clear();
    intersectionAreas = new WeakMap();
  }
}

function detachVideo() {
  if (!video) return;
  reportVideoCandidate(false);
  for (const type of LOCAL_EVENT_TYPES) {
    video.removeEventListener(type, onLocalEvent);
  }
  for (const type of MEDIA_READY_EVENT_TYPES) {
    video.removeEventListener(type, retryPendingEvent);
  }
  video = null;
  pendingRemoteEvent = null;
  expectedEchoes.clear();
}

function reportVideoCandidate(available) {
  const rect = available && video ? video.getBoundingClientRect() : null;
  sendToBackground({
    kind: SynodicProtocol.MSG_VIDEO_CANDIDATE,
    available,
    area: rect ? Math.round(visibleVideoArea(video, rect)) : 0,
    pageUrl: location.href,
  });
}

// --- локальные события -> service worker ------------------------------------

function onLocalEvent(event) {
  const source = event.currentTarget;
  if (source !== video || consumeExpectedEcho(event.type, source)) return;

  const type = event.type === 'seeked'
    ? SynodicProtocol.EVENT_SEEK
    : event.type;

  sendVideoEvent(type);
}

function sendVideoEvent(type) {
  if (!video || !Number.isFinite(video.currentTime)) return;
  sendToBackground({
    kind: SynodicProtocol.MSG_VIDEO_EVENT,
    event: {
      type,
      currentTime: video.currentTime,
      rate: video.playbackRate,
      ts: Date.now(),
    },
  });
}

function sendToBackground(message) {
  try {
    return chrome.runtime.sendMessage(message)?.catch(() => undefined);
  } catch {
    // контекст расширения мог перезапуститься — переживём
    return Promise.resolve(undefined);
  }
}

function expectEcho(type, matches) {
  const guard = { expiresAt: Date.now() + ECHO_GUARD_MS, matches };
  const guards = expectedEchoes.get(type) || [];
  guards.push(guard);
  expectedEchoes.set(type, guards);

  return () => {
    const current = expectedEchoes.get(type);
    if (!current) return;
    const index = current.indexOf(guard);
    if (index !== -1) current.splice(index, 1);
    if (current.length === 0) expectedEchoes.delete(type);
  };
}

function consumeExpectedEcho(type, source) {
  const now = Date.now();
  const guards = (expectedEchoes.get(type) || [])
    .filter((guard) => guard.expiresAt > now);
  const index = guards.findIndex((guard) => guard.matches(source));

  if (index === -1) {
    if (guards.length) expectedEchoes.set(type, guards);
    else expectedEchoes.delete(type);
    return false;
  }

  guards.splice(index, 1);
  if (guards.length) expectedEchoes.set(type, guards);
  else expectedEchoes.delete(type);
  return true;
}

// --- события от напарника -> к видео ---------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind === SynodicProtocol.MSG_CONTENT_PING) {
    sendResponse({ ok: true, revision: CONTENT_REVISION });
    return false;
  }
  if (message?.kind === SynodicProtocol.MSG_ROOM_STATE) {
    setMonitoring(!!message.state?.room);
    return false;
  }
  if (message?.kind === SynodicProtocol.MSG_READ_VIDEO_STATE) {
    if (!video || !Number.isFinite(video.currentTime)) {
      sendResponse({ ok: false });
      return false;
    }
    sendResponse({
      ok: true,
      event: {
        type: video.paused ? SynodicProtocol.EVENT_PAUSE : SynodicProtocol.EVENT_PLAY,
        currentTime: video.currentTime,
        rate: video.playbackRate,
        ts: Date.now(),
      },
    });
    return false;
  }
  if (message?.kind === SynodicProtocol.MSG_START_VIDEO) {
    if (!video) {
      sendResponse({ ok: false });
      return false;
    }
    try {
      Promise.resolve(video.play()).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: error?.message || 'play blocked' }),
      );
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'play blocked' });
      return false;
    }
    return true;
  }
  if (message?.kind !== SynodicProtocol.MSG_APPLY_EVENT) return false;
  sendResponse({ ok: applyEvent(message.event) });
  return false;
});

function applyEvent(event) {
  if (!video || !validRemoteEvent(event)) return false;

  let retryWhenReady = video.readyState === HTMLMediaElement.HAVE_NOTHING;

  if (Number.isFinite(event.rate) &&
      Math.abs(video.playbackRate - event.rate) > 0.001) {
    const cancelGuard = expectEcho('ratechange', (source) =>
      Math.abs(source.playbackRate - event.rate) <= 0.001);
    try {
      video.playbackRate = event.rate;
    } catch {
      cancelGuard();
      retryWhenReady = true;
    }
  }

  const seekEpsilon = event.type === SynodicProtocol.EVENT_HEARTBEAT
    ? HEARTBEAT_EPSILON_S
    : SEEK_EPSILON_S;
  if (Number.isFinite(event.currentTime) && event.currentTime >= 0 &&
      Math.abs(video.currentTime - event.currentTime) > seekEpsilon) {
    const targetTime = event.currentTime;
    const cancelGuard = expectEcho('seeked', (source) =>
      Math.abs(source.currentTime - targetTime) <= SEEK_EPSILON_S);
    try {
      video.currentTime = targetTime;
    } catch {
      cancelGuard();
      retryWhenReady = true;
    }
  }

  if (event.type === SynodicProtocol.EVENT_PAUSE && !video.paused) {
    const cancelGuard = expectEcho('pause', (source) => source.paused);
    try {
      video.pause();
    } catch {
      cancelGuard();
    }
  }
  if ((event.type === SynodicProtocol.EVENT_PLAY ||
      event.type === SynodicProtocol.EVENT_HEARTBEAT) && video.paused) {
    const cancelGuard = expectEcho('play', (source) => !source.paused);
    try {
      video.play().catch(cancelGuard); // автоплей может быть заблокирован браузером
    } catch {
      cancelGuard();
    }
  }

  pendingRemoteEvent = retryWhenReady ? { ...event } : null;
  return true;
}

function validRemoteEvent(event) {
  if (!event || !Number.isFinite(event.currentTime) || event.currentTime < 0 ||
      event.currentTime > MAX_VIDEO_TIME_S) {
    return false;
  }
  return event.rate === undefined ||
    (Number.isFinite(event.rate) && event.rate > 0 && event.rate <= MAX_PLAYBACK_RATE);
}

function retryPendingEvent() {
  if (!video || !pendingRemoteEvent) return;
  const event = pendingRemoteEvent;
  pendingRemoteEvent = null;
  applyEvent(event);
}

sendToBackground({ kind: SynodicProtocol.MSG_GET_CONTENT_STATE })
  .then((state) => setMonitoring(state?.active === true));
})();
