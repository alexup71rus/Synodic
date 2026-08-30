/**
 * Медленная фоновая пыль. Частицы живут около минуты, плавно появляются,
 * опускаются с небольшим дрейфом и исчезают до удаления.
 */

(() => {
  const MIN_PARTICLES = 18;
  const MAX_PARTICLES = 42;
  const AREA_PER_PARTICLE = 38_000;
  const MIN_LIFETIME = 50;
  const MAX_LIFETIME = 80;
  const FRAME_INTERVAL = 1000 / 24;

  class DustField {
    constructor(canvas) {
      this.canvas = canvas;
      this.context = canvas.getContext('2d');
      this.particles = [];
      this.width = 0;
      this.height = 0;
      this.pixelRatio = 1;
      this.lastFrameAt = 0;
      this.frame = 0;
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

      this.resize();
      this.seed();
      this.draw();

      window.addEventListener('resize', () => this.resize(), { passive: true });
      document.addEventListener('visibilitychange', () => this.handleVisibility());
      this.reduceMotion.addEventListener('change', () => this.handleMotionPreference());

      if (!this.reduceMotion.matches) this.start();
    }

    get targetCount() {
      const count = Math.round((this.width * this.height) / AREA_PER_PARTICLE);
      return Math.max(MIN_PARTICLES, Math.min(MAX_PARTICLES, count));
    }

    seed() {
      this.particles = Array.from(
        { length: this.targetCount },
        () => this.createParticle(true),
      );
    }

    createParticle(populated = false) {
      const lifetime = this.random(MIN_LIFETIME, MAX_LIFETIME);
      const age = populated ? this.random(0, lifetime) : 0;

      return {
        age,
        lifetime,
        baseX: this.random(-12, this.width + 12),
        startY: -18,
        fallDistance: this.height * this.random(0.58, 1.08),
        drift: this.random(-0.7, 0.7),
        sway: this.random(3, 14),
        swayPeriod: this.random(18, 38),
        phase: this.random(0, Math.PI * 2),
        radius: this.random(0.5, 1.6),
        stretch: this.random(0.8, 1.45),
        angle: this.random(-0.7, 0.7),
        softness: Math.random(),
        opacity: this.random(0.08, 0.23),
        warmth: Math.random(),
      };
    }

    start() {
      cancelAnimationFrame(this.frame);
      this.lastFrameAt = performance.now();
      this.frame = requestAnimationFrame((time) => this.animate(time));
    }

    animate(time) {
      if (document.hidden || this.reduceMotion.matches) {
        this.frame = 0;
        return;
      }

      const elapsedMs = time - this.lastFrameAt;
      if (elapsedMs < FRAME_INTERVAL) {
        this.frame = requestAnimationFrame((nextTime) => this.animate(nextTime));
        return;
      }

      const elapsed = Math.min(0.1, elapsedMs / 1000);
      this.lastFrameAt = time;
      this.update(elapsed);
      this.draw();
      this.frame = requestAnimationFrame((nextTime) => this.animate(nextTime));
    }

    update(elapsed) {
      for (let index = this.particles.length - 1; index >= 0; index -= 1) {
        const particle = this.particles[index];
        particle.age += elapsed;

        if (particle.age >= particle.lifetime) {
          this.particles.splice(index, 1, this.createParticle());
        }
      }
    }

    draw() {
      const ctx = this.context;
      ctx.clearRect(0, 0, this.width, this.height);

      for (const particle of this.particles) {
        const progress = particle.age / particle.lifetime;
        const fadeIn = this.smoothstep(0, 0.09, progress);
        const fadeOut = 1 - this.smoothstep(0.72, 1, progress);
        const shimmer = 0.88 + 0.12 * Math.sin(particle.age * 0.35 + particle.phase);
        const alpha = particle.opacity * fadeIn * fadeOut * shimmer;
        if (alpha <= 0.002) continue;

        const sway = Math.sin(
          particle.phase + (particle.age / particle.swayPeriod) * Math.PI * 2,
        ) * particle.sway;
        const x = particle.baseX + particle.drift * particle.age + sway;
        const y = particle.startY + particle.fallDistance * progress;

        ctx.beginPath();
        ctx.ellipse(
          x,
          y,
          particle.radius,
          particle.radius * particle.stretch,
          particle.angle,
          0,
          Math.PI * 2,
        );
        const warm = particle.warmth > 0.7;
        ctx.fillStyle = warm
          ? `rgba(242, 220, 174, ${alpha})`
          : `rgba(221, 216, 205, ${alpha})`;
        ctx.shadowColor = warm
          ? `rgba(242, 220, 174, ${alpha * 0.5})`
          : `rgba(221, 216, 205, ${alpha * 0.45})`;
        ctx.shadowBlur = 0.8 + particle.softness * 3.2;
        ctx.fill();
      }
    }

    resize() {
      const previousWidth = this.width || window.innerWidth;
      const previousHeight = this.height || window.innerHeight;
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.pixelRatio = Math.min(1.5, window.devicePixelRatio || 1);

      this.canvas.width = Math.round(this.width * this.pixelRatio);
      this.canvas.height = Math.round(this.height * this.pixelRatio);
      this.context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);

      if (this.particles.length) {
        const scaleX = this.width / previousWidth;
        const scaleY = this.height / previousHeight;
        this.particles.forEach((particle) => {
          particle.baseX *= scaleX;
          particle.fallDistance *= scaleY;
        });

        while (this.particles.length < this.targetCount) {
          this.particles.push(this.createParticle(true));
        }
        this.particles.length = Math.min(this.particles.length, this.targetCount);
      }

      this.draw();
    }

    handleVisibility() {
      if (!document.hidden && !this.reduceMotion.matches && !this.frame) this.start();
    }

    handleMotionPreference() {
      if (this.reduceMotion.matches) {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.draw();
      } else if (!document.hidden) {
        this.start();
      }
    }

    smoothstep(start, end, value) {
      const normalized = Math.max(0, Math.min(1, (value - start) / (end - start)));
      return normalized * normalized * (3 - 2 * normalized);
    }

    random(minimum, maximum) {
      return minimum + Math.random() * (maximum - minimum);
    }
  }

  const canvas = document.querySelector('#dust');
  if (canvas) new DustField(canvas);
})();
