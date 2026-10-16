/*
 * Full-screen confetti burst on a temporary canvas that removes itself.
 * Does nothing when the user prefers reduced motion.
 */
(function () {
  'use strict';

  const COLORS = ['#ffd166', '#06d6a0', '#118ab2', '#ef476f', '#a78bfa', '#ff9f1c', '#2ec4b6', '#f72585'];

  /**
   * opts: {count=160, x=0.5, y=0.4 (origin as viewport fractions),
   *        spread=1 (velocity multiplier), colors, duration=3500 ms}
   */
  function burst(opts = {}) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const {
      count = 160, x = 0.5, y = 0.4, spread = 1,
      colors = COLORS, duration = 3500
    } = opts;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const canvas = document.createElement('canvas');
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Velocities in px/frame at 60fps, biased upward so pieces arc then fall.
    const scale = Math.max(vw, vh) / 900;
    const parts = [];
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
      const speed = (6 + Math.random() * 10) * scale * spread;
      parts.push({
        x: x * vw,
        y: y * vh,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        w: 6 + Math.random() * 6,
        h: 8 + Math.random() * 8,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        tilt: Math.random() * Math.PI, // drives the flutter (width squash)
        color: colors[i % colors.length]
      });
    }

    const start = performance.now();
    let last = start;
    function frame(now) {
      const k = Math.min(3, (now - last) / 16.67); // frame-rate independent step
      last = now;
      ctx.clearRect(0, 0, vw, vh);
      let alive = 0;
      const fade = Math.max(0, Math.min(1, (start + duration - now) / 600));
      for (const p of parts) {
        p.vx *= Math.pow(0.985, k);
        p.vy = p.vy * Math.pow(0.985, k) + 0.28 * scale * k;
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.rot += p.vr * k;
        p.tilt += 0.12 * k;
        if (p.y > vh + 20) continue;
        alive++;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(Math.cos(p.tilt), 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive && fade > 0) requestAnimationFrame(frame);
      else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  window.Confetti = { burst };
})();
