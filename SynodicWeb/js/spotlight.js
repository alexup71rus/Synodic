/**
 * Небольшая нерегулярность кинотеатрального луча: короткий сбой при включении
 * и редкое естественное мерцание, пока поле ссылки остаётся в фокусе.
 */

const SynodicSpotlight = (() => {
  const form = document.querySelector('.create-form');
  if (!form) return null;

  const mobile = window.matchMedia('(max-width: 640px)');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const timers = new Set();
  let active = false;
  let viewingCommitted = false;

  function later(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
  }

  function clearTimers() {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    document.body.classList.remove('spotlight-flicker', 'spotlight-flicker-soft');
  }

  function canFlicker() {
    return active && !document.body.classList.contains('spotlight-room') &&
      !mobile.matches && !reduceMotion.matches;
  }

  function blink({ soft = false, double = false } = {}) {
    if (!canFlicker()) return;

    const className = soft ? 'spotlight-flicker-soft' : 'spotlight-flicker';
    document.body.classList.add(className);
    later(() => {
      document.body.classList.remove(className);
      if (!double || !canFlicker()) return;
      later(() => {
        if (!canFlicker()) return;
        document.body.classList.add('spotlight-flicker-soft');
        later(() => document.body.classList.remove('spotlight-flicker-soft'), 46);
      }, 72);
    }, soft ? 48 : 58);
  }

  function scheduleNextBlink() {
    if (!canFlicker()) return;
    const delay = 7000 + Math.random() * 11000;
    later(() => {
      blink({
        soft: Math.random() > 0.68,
        double: Math.random() > 0.78,
      });
      scheduleNextBlink();
    }, delay);
  }

  function start() {
    active = true;
    clearTimers();
    if (!canFlicker()) return;

    // Лампа быстро разгорается и один раз слегка «цепляется» на старте.
    later(() => blink({ soft: true, double: Math.random() > 0.55 }), 105);
    scheduleNextBlink();
  }

  function stop() {
    active = false;
    clearTimers();
  }

  function enterRoom() {
    stop();
    viewingCommitted = false;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.classList.add('spotlight-room');
    document.body.classList.remove('spotlight-anticipating', 'spotlight-playing');
  }

  function leaveRoom() {
    viewingCommitted = false;
    document.body.classList.remove(
      'spotlight-room',
      'spotlight-anticipating',
      'spotlight-playing',
    );
  }

  function anticipateViewing(anticipating) {
    if (!document.body.classList.contains('spotlight-room') ||
        document.body.classList.contains('spotlight-playing')) return;
    if (!anticipating && viewingCommitted) return;
    document.body.classList.toggle('spotlight-anticipating', anticipating);
  }

  function commitViewing() {
    if (!document.body.classList.contains('spotlight-room')) return;
    viewingCommitted = true;
    document.body.classList.add('spotlight-anticipating');
  }

  function setPlaying(playing) {
    if (!document.body.classList.contains('spotlight-room')) return;
    viewingCommitted = false;
    document.body.classList.remove('spotlight-anticipating');
    document.body.classList.toggle('spotlight-playing', playing);
  }

  form.addEventListener('focusin', start);
  form.addEventListener('focusout', () => later(() => {
    if (!form.matches(':focus-within')) stop();
  }, 0));
  mobile.addEventListener('change', () => {
    if (mobile.matches) clearTimers();
    else if (form.matches(':focus-within')) start();
  });
  reduceMotion.addEventListener('change', () => {
    if (reduceMotion.matches) clearTimers();
    else if (form.matches(':focus-within')) start();
  });

  return { enterRoom, leaveRoom, anticipateViewing, commitViewing, setPlaying };
})();
