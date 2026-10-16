'use strict';
/**
 * Word bank helpers: picking choices, masking, guess matching.
 */
const BANK = require('./words.json');

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const MULTIPLIER = { easy: 1, medium: 1.2, hard: 1.5 };
// Letters (any script), single spaces or hyphens between parts.
const WORD_RE = /^\p{L}+(?:[ -]\p{L}+)*$/u;

/** Lowercase, trim and collapse internal whitespace. */
function normalize(s) {
  return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Classic Levenshtein distance; bails out early once it exceeds `max`. */
function levenshtein(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const isSeparator = (c) => c === ' ' || c === '-';

/** Blank pattern for guessers: letters become '_' unless revealed; spaces/hyphens stay. */
function mask(word, revealed) {
  return [...word].map((c, i) => (isSeparator(c) || revealed.has(i) ? c : '_')).join('');
}

/** Indices of letters that are still hidden. */
function hiddenLetterIndices(word, revealed) {
  const out = [];
  [...word].forEach((c, i) => { if (!isSeparator(c) && !revealed.has(i)) out.push(i); });
  return out;
}

/** Custom words have no difficulty tag, so derive one from letter count. */
function difficultyOf(word) {
  const letters = word.replace(/[ -]/g, '').length;
  return letters <= 5 ? 'easy' : letters <= 8 ? 'medium' : 'hard';
}

/** Parse a comma-separated custom word list. `isClean` filters profanity. */
function parseCustomWords(input, isClean) {
  const seen = new Set();
  return String(input || '')
    .split(',')
    .map(normalize)
    .filter((w) => w.length >= 2 && w.length <= 30 && WORD_RE.test(w) && isClean(w))
    .filter((w) => (seen.has(w) ? false : seen.add(w)))
    .slice(0, 300);
}

/**
 * Pick 3 choices (easy/medium/hard when possible) that were not used yet this game.
 * Returns [{ word, difficulty }].
 */
function pickChoices(settings, used) {
  const pools = { easy: [], medium: [], hard: [] };
  const custom = settings.customWords || [];
  const customOnly = settings.customOnly && custom.length >= 3;
  if (!customOnly) {
    for (const cat of settings.categories) {
      for (const d of DIFFICULTIES) pools[d].push(...(BANK[cat]?.[d] || []));
    }
  }
  for (const w of custom) pools[difficultyOf(w)].push(w);

  const all = DIFFICULTIES.flatMap((d) => pools[d].map((word) => ({ word, difficulty: d })));
  const taken = new Set();
  const randomFrom = (list) => {
    const fresh = list.filter((c) => !taken.has(c.word) && !used.has(c.word));
    // Everything used already? Allow repeats rather than failing.
    const src = fresh.length ? fresh : list.filter((c) => !taken.has(c.word));
    return src.length ? src[Math.floor(Math.random() * src.length)] : null;
  };

  const choices = [];
  for (const d of DIFFICULTIES) {
    const pick = randomFrom(pools[d].map((word) => ({ word, difficulty: d }))) || randomFrom(all);
    if (pick) { taken.add(pick.word); choices.push(pick); }
  }
  return choices;
}

module.exports = {
  BANK, DIFFICULTIES, MULTIPLIER, WORD_RE,
  normalize, levenshtein, mask, hiddenLetterIndices, difficultyOf, parseCustomWords, pickChoices
};
