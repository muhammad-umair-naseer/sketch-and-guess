'use strict';
/**
 * Quick Play bots: seat fillers that guess but never draw. They are plain player
 * objects (negative ids, no socket, never stored), and every guess goes through
 * room.handleChat so validation and scoring are exactly what a human gets.
 */
const words = require('./words');
const { AVATARS } = require('../public/js/shared');

const NAMES = ['Doodlebot', 'Pixel Pete', 'Sketchy Sam', 'Crayon Kay', 'Brushy', 'Inky', 'Scribbles', 'Picasso-ish'];
const SKILL_BY_DIFFICULTY = { easy: 0.1, medium: 0, hard: -0.15 };
const HINT_BONUS = 0.1;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** A new bot with a name not already used in the room. */
function createBot(id, takenNames) {
  const free = NAMES.filter((n) => !takenNames.has(n));
  return {
    id, isBot: true, token: null, name: pick(free.length ? free : NAMES), avatar: Math.floor(Math.random() * AVATARS.length),
    score: 0, guessed: false, badges: 0, connected: true, socket: null, skill: rand(0.55, 0.85)
  };
}

/** Up to `n` wrong guesses from the room's categories: never within "so close" range of the answer and never sharing a word with it. */
function decoys(room, n) {
  const answer = words.normalize(room.turn.word);
  const parts = new Set(answer.split(/[\s-]+/));
  const pool = room.settings.categories.flatMap((c) => words.DIFFICULTIES.flatMap((d) => words.BANK[c]?.[d] || []));
  const out = new Set();
  for (let tries = 0; pool.length && out.size < n && tries < 50; tries++) {
    const w = words.normalize(pick(pool));
    if (w.split(/[\s-]+/).some((x) => parts.has(x))) continue; // 'hot dog' would leak 'dog'
    if (words.levenshtein(w, answer, 2) > 2) out.add(w);
  }
  return [...out];
}

/** Schedule every bot's guesses (and maybe a thumbs up) for the drawing phase that just started. */
function planTurn(room) {
  const ms = room.settings.drawTime * 1000;
  const turnId = room.turn.id;
  for (const bot of room.players.values()) {
    if (!bot.isBot) continue;
    // Timers die with clearTimers at turn end; this also covers a bot removed mid-turn.
    const live = () => room.phase === 'drawing' && room.turn.id === turnId && room.players.get(bot.id) === bot;
    const guess = (text) => () => { if (live() && !bot.guessed) room.handleChat(bot, text); };

    const at = rand(0.25, 0.9) * ms;
    room.later(at, () => {
      if (!live()) return;
      const chance = bot.skill + (SKILL_BY_DIFFICULTY[room.turn.difficulty] || 0) + HINT_BONUS * room.turn.hints;
      if (Math.random() < chance) guess(room.turn.word)();
    });
    for (const w of decoys(room, Math.floor(Math.random() * 4))) room.later(rand(0.1, 0.95) * at, guess(w));
    if (Math.random() < 0.4) room.later(rand(0.2, 0.8) * ms, () => { if (live()) room.handleReaction(bot, 'up'); });
  }
}

module.exports = { createBot, planTurn, decoys, NAMES };
