/*
 * Canvas engine: renders drawing ops onto a fixed 800x600 bitmap.
 * Ops use normalized 0..1 coordinates; the bitmap size never changes (CSS
 * scales it), so every client rasterizes identically and flood fill agrees.
 */
(function () {
  'use strict';

  const W = Shared.CANVAS_W;
  const H = Shared.CANVAS_H;
  const BG = '#ffffff';
  const FILL_TOLERANCE = 40; // max per-channel difference still counted as "same color"

  const clone = (op) => (op.type === 'stroke' ? { ...op, points: op.points.slice() } : { ...op });

  // willReadFrequently keeps the canvas on the CPU: fast getImageData for
  // fills and fewer GPU-dependent rasterization differences between clients.
  function context(canvasEl) {
    return canvasEl.getContext('2d', { willReadFrequently: true });
  }

  function paintBackground(ctx) {
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
  }

  /**
   * Draw a stroke starting at point index `from` (points already on screen).
   * Path for P0..Pn-1: moveTo(P0), quadraticCurveTo(Pi, mid(Pi, Pi+1)) for
   * i = 1..n-2, lineTo(Pn-1). Resuming at `from` = m restarts at
   * mid(Pm-2, Pm-1), where the previous curve ended; the old straight tail
   * gets overdrawn by the new curve, which is invisible with opaque colors.
   */
  function drawStroke(ctx, op, from) {
    const p = op.points;
    const n = p.length / 2;
    if (n === 0 || from >= n) return;
    const X = (i) => p[2 * i] * W;
    const Y = (i) => p[2 * i + 1] * H;

    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = op.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (n === 1) { // a click without movement is a dot
      ctx.beginPath();
      ctx.arc(X(0), Y(0), op.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    ctx.beginPath();
    let i;
    if (from <= 1) {
      ctx.moveTo(X(0), Y(0));
      i = 1;
    } else {
      ctx.moveTo((X(from - 2) + X(from - 1)) / 2, (Y(from - 2) + Y(from - 1)) / 2);
      i = from - 1;
    }
    for (; i <= n - 2; i++) {
      ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    }
    ctx.lineTo(X(n - 1), Y(n - 1));
    ctx.stroke();
  }

  function hexToRgb(hex) {
    const v = parseInt(hex.slice(1), 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  /**
   * Scanline flood fill on the bitmap. Deterministic: same pixels in, same
   * pixels out. Pixels within FILL_TOLERANCE of the seed color are replaced.
   * ponytail: no anti-alias fringe blending, a faint halo can stay next to
   * stroke edges; add a 1px boundary dilation if it bothers anyone.
   */
  function floodFill(ctx, nx, ny, hex) {
    const x0 = Math.min(W - 1, Math.max(0, Math.floor(nx * W)));
    const y0 = Math.min(H - 1, Math.max(0, Math.floor(ny * H)));
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const [fr, fg, fb] = hexToRgb(hex);
    const s = (y0 * W + x0) * 4;
    const tr = d[s], tg = d[s + 1], tb = d[s + 2], ta = d[s + 3];
    if (tr === fr && tg === fg && tb === fb && ta === 255) return; // nothing would change

    const seen = new Uint8Array(W * H); // guards against re-matching painted pixels
    const match = (i) => {
      if (seen[i]) return false;
      const k = i * 4;
      return Math.abs(d[k] - tr) <= FILL_TOLERANCE && Math.abs(d[k + 1] - tg) <= FILL_TOLERANCE &&
        Math.abs(d[k + 2] - tb) <= FILL_TOLERANCE && Math.abs(d[k + 3] - ta) <= FILL_TOLERANCE;
    };

    const stack = [x0, y0];
    while (stack.length) {
      const y = stack.pop();
      const x = stack.pop();
      const row = y * W;
      if (!match(row + x)) continue;
      let lx = x;
      let rx = x;
      while (lx > 0 && match(row + lx - 1)) lx--;
      while (rx < W - 1 && match(row + rx + 1)) rx++;
      for (let xx = lx; xx <= rx; xx++) {
        const i = row + xx;
        const k = i * 4;
        seen[i] = 1;
        d[k] = fr; d[k + 1] = fg; d[k + 2] = fb; d[k + 3] = 255;
      }
      // Queue one seed per contiguous matching run in the rows above and below.
      for (const ny2 of [y - 1, y + 1]) {
        if (ny2 < 0 || ny2 >= H) continue;
        const r2 = ny2 * W;
        let inRun = false;
        for (let xx = lx; xx <= rx; xx++) {
          if (match(r2 + xx)) {
            if (!inRun) { stack.push(xx, ny2); inRun = true; }
          } else {
            inRun = false;
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** A canvas plus the op list it shows. Keeps its own copies of every op. */
  class Board {
    constructor(canvasEl) {
      this.canvas = canvasEl;
      canvasEl.width = W;
      canvasEl.height = H;
      this.ctx = context(canvasEl);
      this._ops = [];
      this._byId = new Map();
      paintBackground(this.ctx);
    }

    get ops() { return this._ops; }

    reset() {
      this._ops = [];
      this._byId.clear();
      paintBackground(this.ctx);
    }

    load(ops) {
      this.reset();
      for (const op of ops || []) this.apply(op);
    }

    apply(op) {
      if (!op) return;
      switch (op.type) {
        case 'stroke': {
          const existing = this._byId.get(op.id);
          if (existing) {
            if (existing.type !== 'stroke') return;
            const from = existing.points.length / 2;
            existing.points.push(...op.points); // continuation chunk
            drawStroke(this.ctx, existing, from);
          } else {
            const copy = clone(op);
            this._ops.push(copy);
            this._byId.set(copy.id, copy);
            drawStroke(this.ctx, copy, 0);
          }
          break;
        }
        case 'fill': {
          if (this._byId.has(op.id)) return;
          const copy = clone(op);
          this._ops.push(copy);
          this._byId.set(copy.id, copy);
          floodFill(this.ctx, copy.x, copy.y, copy.color);
          break;
        }
        case 'undo': {
          const i = this._ops.findIndex((o) => o.id === op.strokeId);
          if (i < 0) return;
          this._byId.delete(this._ops[i].id);
          this._ops.splice(i, 1);
          this.redraw(); // fills depend on everything under them, so repaint all
          break;
        }
        case 'clear':
          this.reset();
          break;
      }
    }

    redraw() {
      paintBackground(this.ctx);
      for (const op of this._ops) {
        if (op.type === 'stroke') drawStroke(this.ctx, op, 0);
        else if (op.type === 'fill') floodFill(this.ctx, op.x, op.y, op.color);
      }
    }

    lastOpId() {
      const last = this._ops[this._ops.length - 1];
      return last ? last.id : null;
    }

    snapshot() {
      return this._ops.map(clone);
    }
  }

  function renderOps(canvasEl, ops) {
    new Board(canvasEl).load(ops);
  }

  /**
   * Feeds ops into a board a few "units" at a time (1 unit = 1 stroke point
   * or 1 fill) so replay and GIF export show the drawing being built.
   * Strokes are fed as growing chunks, reusing Board's incremental drawing.
   */
  function makeStepper(board, ops) {
    const list = (ops || []).map(clone);
    const units = (op) => (op.type === 'stroke' ? op.points.length / 2 : op.type === 'fill' ? 1 : 0);
    const total = list.reduce((sum, op) => sum + units(op), 0);
    let opIdx = 0;
    let ptIdx = 0;
    let done = 0;

    /** Apply ops until `target` units have been drawn (or everything is). */
    function advanceTo(target) {
      while (done < target && opIdx < list.length) {
        const op = list[opIdx];
        if (op.type === 'stroke') {
          const n = op.points.length / 2;
          const take = Math.min(n - ptIdx, target - done);
          if (take > 0) {
            board.apply({ type: 'stroke', id: op.id, color: op.color, size: op.size, points: op.points.slice(ptIdx * 2, (ptIdx + take) * 2) });
            ptIdx += take;
            done += take;
          }
          if (ptIdx >= n) { opIdx++; ptIdx = 0; }
        } else {
          board.apply(op);
          done += units(op);
          opIdx++;
        }
      }
    }

    return { total, advanceTo, get done() { return done; } };
  }

  // One running replay per canvas; starting another cancels the previous one.
  const replayTokens = new WeakMap();

  /** Timelapse of `ops`. Resolves true when finished, false if cancelled. */
  function replay(canvasEl, ops, durationMs = 3500) {
    const token = {};
    replayTokens.set(canvasEl, token);
    const stepper = makeStepper(new Board(canvasEl), ops);
    return new Promise((resolve) => {
      if (!stepper.total) return resolve(true);
      const start = performance.now();
      const frame = (now) => {
        if (replayTokens.get(canvasEl) !== token) return resolve(false);
        const t = Math.min(1, (now - start) / durationMs);
        stepper.advanceTo(Math.ceil(t * stepper.total));
        if (t >= 1) {
          replayTokens.delete(canvasEl);
          return resolve(true);
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  const GIF_W = 400;
  const GIF_H = 300;
  const GIF_FRAMES = 40;

  /** Build an animated GIF timelapse and download it. Resolves with the Blob. */
  function exportGif(ops, filename = 'drawing.gif', onProgress) {
    return new Promise((resolve, reject) => {
      if (typeof window.GIF !== 'function') return reject(new Error('GIF encoder not loaded'));

      const full = document.createElement('canvas');
      const stepper = makeStepper(new Board(full), ops);
      const small = document.createElement('canvas');
      small.width = GIF_W;
      small.height = GIF_H;
      const sctx = small.getContext('2d', { willReadFrequently: true });

      const gif = new window.GIF({
        workers: 2,
        quality: 10,
        width: GIF_W,
        height: GIF_H,
        background: BG,
        workerScript: '/vendor/gif/gif.worker.js'
      });

      for (let f = 1; f <= GIF_FRAMES; f++) {
        stepper.advanceTo(Math.round((stepper.total * f) / GIF_FRAMES));
        sctx.drawImage(full, 0, 0, GIF_W, GIF_H);
        // Last frame lingers so the finished drawing is readable before looping.
        gif.addFrame(sctx, { copy: true, delay: f === GIF_FRAMES ? 2500 : 80 });
      }

      if (onProgress) gif.on('progress', onProgress);
      gif.on('abort', () => reject(new Error('GIF export aborted')));
      gif.on('finished', (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = /\.gif$/i.test(filename) ? filename : filename + '.gif';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        resolve(blob);
      });
      gif.render();
    });
  }

  window.Canvas = { Board, renderOps, replay, exportGif };
})();
