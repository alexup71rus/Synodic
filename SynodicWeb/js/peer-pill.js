/**
 * Небольшой canvas-индикатор участников.
 * Два одинаковых metaball-центра расходятся из одной точки в 1 + 1.
 * Плюс остаётся знаком на общей перемычке, а не отдельным пузырём.
 */

(() => {
  const WIDTH_CLOSED = 32;
  const WIDTH_OPEN = 72;
  const CANVAS_WIDTH = 76;
  const HEIGHT = 32;
  const DURATION_OPEN = 720;
  const DURATION_CLOSE = 440;

  class PeerPillRenderer {
    constructor(host) {
      this.host = host;
      this.canvas = host.querySelector('canvas');
      this.context = this.canvas.getContext('2d');
      this.maskCanvas = document.createElement('canvas');
      this.maskContext = this.maskCanvas.getContext('2d', { willReadFrequently: true });
      this.shapeCanvas = document.createElement('canvas');
      this.shapeContext = this.shapeCanvas.getContext('2d');
      this.maskImage = null;
      this.pixelRatio = 1;
      this.progress = 0;
      this.startProgress = 0;
      this.targetProgress = 0;
      this.state = 'waiting';
      this.frame = 0;
      this.startedAt = 0;
      this.duration = 0;
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

      this.resize();
      this.draw();
      window.addEventListener('resize', () => this.resize(), { passive: true });
    }

    setState(state) {
      if (!['waiting', 'together', 'lost'].includes(state)) return;

      this.state = state;
      this.host.dataset.state = state;
      const target = state === 'waiting' ? 0 : 1;

      if (this.reduceMotion.matches) {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.progress = target;
        this.targetProgress = target;
        this.host.style.width = `${this.widthFor(target)}px`;
        this.draw();
        return;
      }

      if (target === this.targetProgress && this.frame) return;
      if (target === this.progress && !this.frame) {
        this.draw();
        return;
      }

      cancelAnimationFrame(this.frame);
      this.startProgress = this.progress;
      this.targetProgress = target;
      this.startedAt = performance.now();
      this.duration = target > this.progress ? DURATION_OPEN : DURATION_CLOSE;
      this.frame = requestAnimationFrame((time) => this.animate(time));
    }

    animate(time) {
      const elapsed = Math.min(1, (time - this.startedAt) / this.duration);
      const easing = this.targetProgress > this.startProgress
        ? this.easeOutBack(elapsed)
        : this.easeInOutCubic(elapsed);

      this.progress = this.startProgress + (this.targetProgress - this.startProgress) * easing;
      this.host.style.width = `${this.widthFor(this.progress)}px`;
      this.draw();

      if (elapsed < 1) {
        this.frame = requestAnimationFrame((nextTime) => this.animate(nextTime));
      } else {
        this.frame = 0;
        this.progress = this.targetProgress;
        this.host.style.width = `${this.widthFor(this.progress)}px`;
        this.draw();
      }
    }

    draw() {
      const ctx = this.context;
      const progress = Math.max(0, Math.min(1.06, this.progress));
      const settledProgress = Math.min(1, progress);
      const pulse = Math.sin(Math.PI * settledProgress);
      const activation = this.smoothstep(0, 0.55, settledProgress);
      const leftX = 16;
      const rightX = leftX + 36 * progress;
      const plusX = (leftX + rightX) / 2;
      const outerStrength = 14.5;
      const leftStrength = outerStrength * (1 + 0.025 * pulse);
      const rightStrength = outerStrength * activation * (1 + 0.08 * pulse);
      const labelProgress = this.smoothstep(0.48, 0.82, progress);

      const balls = [
        { x: leftX, y: HEIGHT / 2, strength: leftStrength },
        { x: rightX, y: HEIGHT / 2, strength: rightStrength },
      ];
      this.renderMask(balls);

      const shape = this.shapeContext;
      shape.clearRect(0, 0, CANVAS_WIDTH, HEIGHT);
      const gradient = shape.createLinearGradient(2, 2, Math.max(30, rightX + rightStrength), HEIGHT - 2);
      if (this.state === 'lost') {
        gradient.addColorStop(0, '#777064');
        gradient.addColorStop(1, '#5f665e');
      } else {
        gradient.addColorStop(0, '#9a7843');
        gradient.addColorStop(1, '#6e7658');
      }
      shape.fillStyle = gradient;
      shape.fillRect(0, 0, CANVAS_WIDTH, HEIGHT);
      shape.save();
      shape.setTransform(1, 0, 0, 1, 0, 0);
      shape.globalCompositeOperation = 'destination-in';
      shape.drawImage(this.maskCanvas, 0, 0);
      shape.restore();

      shape.save();
      shape.globalCompositeOperation = 'source-atop';
      const sheen = shape.createLinearGradient(0, 2, 0, HEIGHT);
      sheen.addColorStop(0, 'rgba(255, 241, 205, 0.18)');
      sheen.addColorStop(0.46, 'rgba(255, 241, 205, 0)');
      sheen.addColorStop(1, 'rgba(26, 27, 24, 0.12)');
      shape.fillStyle = sheen;
      shape.fillRect(0, 0, CANVAS_WIDTH, HEIGHT);
      shape.restore();

      ctx.clearRect(0, 0, CANVAS_WIDTH, HEIGHT);
      ctx.save();
      ctx.shadowColor = this.state === 'lost'
        ? 'rgba(0, 0, 0, 0.25)'
        : 'rgba(151, 116, 59, 0.22)';
      ctx.shadowBlur = 7;
      ctx.shadowOffsetY = 1.5;
      ctx.drawImage(this.shapeCanvas, 0, 0, CANVAS_WIDTH, HEIGHT);
      ctx.restore();

      this.drawLabels(ctx, leftX, plusX, rightX, labelProgress);
    }

    renderMask(balls) {
      const width = this.maskCanvas.width;
      const height = this.maskCanvas.height;
      const ratio = this.pixelRatio;
      const pixels = this.maskImage.data;

      for (let pixelY = 0; pixelY < height; pixelY += 1) {
        const y = (pixelY + 0.5) / ratio;
        for (let pixelX = 0; pixelX < width; pixelX += 1) {
          const x = (pixelX + 0.5) / ratio;
          let field = 0;

          for (const ball of balls) {
            if (ball.strength <= 0) continue;
            const offsetX = x - ball.x;
            const offsetY = y - ball.y;
            const distanceSquared = offsetX * offsetX + offsetY * offsetY;
            field += (ball.strength * ball.strength) / Math.max(0.01, distanceSquared);
          }

          const alpha = this.smoothstep(0.9, 1.08, field);
          const index = (pixelY * width + pixelX) * 4;
          pixels[index] = 255;
          pixels[index + 1] = 255;
          pixels[index + 2] = 255;
          pixels[index + 3] = Math.round(alpha * 255);
        }
      }

      this.maskContext.putImageData(this.maskImage, 0, 0);
    }

    drawLabels(ctx, leftX, plusX, rightX, labelProgress) {
      ctx.save();
      ctx.fillStyle = '#f3e8c9';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '780 12px Inter, system-ui, sans-serif';
      ctx.fillText('1', leftX, HEIGHT / 2 + 0.5);

      if (labelProgress > 0) {
        ctx.globalAlpha = labelProgress;
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillText('+', plusX, HEIGHT / 2 + 0.2);
        ctx.font = '780 12px Inter, system-ui, sans-serif';
        ctx.fillText('1', rightX, HEIGHT / 2 + 0.5);
      }
      ctx.restore();
    }

    resize() {
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      const physicalWidth = Math.round(CANVAS_WIDTH * ratio);
      const physicalHeight = Math.round(HEIGHT * ratio);
      if (
        !this.maskImage
        || this.canvas.width !== physicalWidth
        || this.canvas.height !== physicalHeight
        || this.maskCanvas.width !== physicalWidth
        || this.maskCanvas.height !== physicalHeight
      ) {
        this.pixelRatio = ratio;
        this.canvas.width = physicalWidth;
        this.canvas.height = physicalHeight;
        this.maskCanvas.width = physicalWidth;
        this.maskCanvas.height = physicalHeight;
        this.shapeCanvas.width = physicalWidth;
        this.shapeCanvas.height = physicalHeight;
        this.maskImage = this.maskContext.createImageData(physicalWidth, physicalHeight);
        this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.shapeContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      }
      this.draw();
    }

    widthFor(progress) {
      return Math.min(CANVAS_WIDTH, WIDTH_CLOSED + (WIDTH_OPEN - WIDTH_CLOSED) * Math.max(0, progress));
    }

    easeOutBack(value) {
      const overshoot = 1.15;
      const shifted = value - 1;
      return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
    }

    easeInOutCubic(value) {
      return value < 0.5
        ? 4 * value ** 3
        : 1 - ((-2 * value + 2) ** 3) / 2;
    }

    smoothstep(start, end, value) {
      const normalized = Math.max(0, Math.min(1, (value - start) / (end - start)));
      return normalized * normalized * (3 - 2 * normalized);
    }
  }

  window.SynodicPeerPill = {
    create(host) {
      return new PeerPillRenderer(host);
    },
  };
})();
