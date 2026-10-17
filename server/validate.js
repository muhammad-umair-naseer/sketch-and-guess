'use strict';
/**
 * Payload validation and rate limiting. Every client message goes through here.
 */
const Shared = require('../public/js/shared');
const { isProfane } = require('./profanity');
const { parseCustomWords } = require('./words');

const COLORS = new Set(Shared.PALETTE);
const ID_RE = /^[a-z0-9]{1,16}$/i;
const MAX_CHUNK_NUMBERS = 400; // 200 points per stroke chunk

/** Token bucket: `capacity` burst, refilled at `perSec`. Returns a () => boolean. */
function rateLimiter(capacity, perSec) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * perSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/** Per-player limiters, one bucket per event family. */
function makeLimits() {
  return {
    chat: rateLimiter(5, 1.5),
    draw: rateLimiter(80, 40),
    react: rateLimiter(4, 1),
    action: rateLimiter(15, 5)
  };
}

const unit = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
const round4 = (n) => Math.round(n * 10000) / 10000;

/** Validate a drawing action. Returns a clean copy or null. */
function sanitizeOp(op) {
  if (!op || typeof op !== 'object') return null;
  const id = typeof op.id === 'string' && ID_RE.test(op.id) ? op.id : null;
  switch (op.type) {
    case 'stroke': {
      const pts = op.points;
      if (!id || !COLORS.has(op.color) || !Shared.SIZES.includes(op.size)) return null;
      if (!Array.isArray(pts) || pts.length < 2 || pts.length > MAX_CHUNK_NUMBERS || pts.length % 2) return null;
      if (!pts.every(unit)) return null;
      return { type: 'stroke', id, color: op.color, size: op.size, points: pts.map(round4) };
    }
    case 'fill':
      if (!id || !COLORS.has(op.color) || !unit(op.x) || !unit(op.y)) return null;
      return { type: 'fill', id, x: round4(op.x), y: round4(op.y), color: op.color };
    case 'undo':
      return typeof op.strokeId === 'string' && ID_RE.test(op.strokeId) ? { type: 'undo', strokeId: op.strokeId } : null;
    case 'clear':
      return { type: 'clear' };
    default:
      return null;
  }
}

/** Player name: 1–16 printable chars, no profanity. Returns string or null. */
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return n && !isProfane(n) ? n : null;
}

function cleanAvatar(a) {
  return Number.isInteger(a) && a >= 0 && a < Shared.AVATARS.length ? a : 0;
}

/** Chat text: 1–100 chars, control chars stripped. Returns string or null. */
function cleanChat(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\p{C}/gu, '').trim().slice(0, 100);
  return t || null;
}

/** Merge a partial settings update into `current`, ignoring anything invalid. */
function sanitizeSettings(input, current, playerCount) {
  const s = { ...current };
  if (!input || typeof input !== 'object') return s;
  const int = (v) => (Number.isInteger(v) ? v : parseInt(v, 10));

  const rounds = int(input.rounds);
  if (rounds >= Shared.MIN_ROUNDS && rounds <= Shared.MAX_ROUNDS) s.rounds = rounds;
  const drawTime = int(input.drawTime);
  if (Shared.DRAW_TIMES.includes(drawTime)) s.drawTime = drawTime;
  const maxPlayers = int(input.maxPlayers);
  if (maxPlayers >= Math.max(Shared.MIN_PLAYERS, playerCount) && maxPlayers <= Shared.MAX_PLAYERS) s.maxPlayers = maxPlayers;
  if (Array.isArray(input.categories)) {
    const cats = [...new Set(input.categories.filter((c) => Object.hasOwn(Shared.CATEGORIES, c)))];
    if (cats.length) s.categories = cats;
  }
  if (typeof input.customWords === 'string') s.customWords = parseCustomWords(input.customWords.slice(0, 6000), (w) => !isProfane(w));
  if (typeof input.customOnly === 'boolean') s.customOnly = input.customOnly;
  if (typeof input.hints === 'boolean') s.hints = input.hints;
  return s;
}

const isToken = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);

module.exports = { rateLimiter, makeLimits, sanitizeOp, cleanName, cleanAvatar, cleanChat, sanitizeSettings, isToken };
