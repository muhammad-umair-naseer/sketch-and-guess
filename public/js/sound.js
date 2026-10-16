/*
 * Sound effects synthesized with WebAudio (no audio files).
 * Browsers only allow audio after a user gesture, so pages call Sound.unlock()
 * on the first click/keypress; play() before that is silently ignored.
 */
(function () {
  'use strict';

  const KEY = 'sg_muted';
  let muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) { /* storage blocked: default unmuted */ }

  let ctx = null;
  let master = null;
  let unlocked = false; // set by the first user gesture

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
    return ctx;
  }

  /**
   * One enveloped oscillator note. `at` is seconds from now; optional
   * `slideTo` glides the pitch over the note's duration.
   */
  function tone(freq, at, dur, { type = 'triangle', vol = 0.5, slideTo } = {}) {
    const t0 = ctx.currentTime + at;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    // Quick attack, exponential decay: avoids clicks and sounds plucky.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // Note frequencies (Hz).
  const C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880, C6 = 1046.5, E6 = 1318.5, G4 = 392;

  const SOUNDS = {
    correct() { // rising major arpeggio
      [C5, E5, G5, C6].forEach((f, i) => tone(f, i * 0.07, 0.22, { vol: 0.45 }));
    },
    tick() { // short woodblock-ish click
      tone(1500, 0, 0.035, { type: 'square', vol: 0.12 });
    },
    turn() { // two-tone "your attention please"
      tone(G4, 0, 0.16, { type: 'sine', vol: 0.5 });
      tone(C5, 0.14, 0.26, { type: 'sine', vol: 0.5 });
    },
    podium() { // little fanfare ending on a held chord
      [[C5, 0], [C5, 0.12], [C5, 0.24], [G5, 0.36]].forEach(([f, at]) => tone(f, at, 0.14, { type: 'square', vol: 0.18 }));
      [C6, G5, E5].forEach((f) => tone(f, 0.52, 0.9, { type: 'triangle', vol: 0.3 }));
    },
    hint() { // sparkle
      tone(A5, 0, 0.12, { type: 'sine', vol: 0.35 });
      tone(E6, 0.08, 0.2, { type: 'sine', vol: 0.3 });
    },
    close() { // "ooh, almost": a small downward wobble
      tone(E5, 0, 0.12, { type: 'sine', vol: 0.4 });
      tone(C5 * 1.06, 0.1, 0.22, { type: 'sine', vol: 0.4, slideTo: C5 });
    },
    pop() { // bubble pop
      tone(500, 0, 0.08, { type: 'sine', vol: 0.5, slideTo: 1200 });
    },
    join() { // friendly hello
      tone(E5, 0, 0.1, { vol: 0.35 });
      tone(A5, 0.08, 0.18, { vol: 0.35 });
    }
  };

  const Sound = {
    play(name) {
      // Before unlock, skip instead of queueing: a suspended context would
      // otherwise dump every queued sound at once when it finally resumes.
      if (muted || !unlocked || !SOUNDS[name] || !ensure()) return;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      try { SOUNDS[name](); } catch (e) { /* audio glitches must never break the game */ }
    },
    unlock() {
      unlocked = true;
      if (ensure() && ctx.state === 'suspended') ctx.resume().catch(() => {});
    },
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* not persisted, still works */ }
      return muted;
    }
  };

  window.Sound = Sound;
})();
