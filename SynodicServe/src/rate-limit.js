/** Небольшой глобальный лимитер для публичных операций домашнего инстанса. */
export class SlidingWindowLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.timestamps = [];
  }

  /** 0 — запрос разрешён; положительное число — Retry-After в секундах. */
  consume(now = Date.now()) {
    while (this.timestamps.length && now - this.timestamps[0] >= this.windowMs) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limit) {
      return Math.max(
        1,
        Math.ceil((this.timestamps[0] + this.windowMs - now) / 1000),
      );
    }
    this.timestamps.push(now);
    return 0;
  }
}
