'use strict';
/**
 * Small profanity filter for names, chat and custom words (English + Roman Urdu).
 * Matches whole tokens (after leetspeak folding) to avoid flagging words like
 * "class" or "cucumber"; a few unambiguous roots are also matched inside tokens.
 * ponytail: word list, not ML. Extend the lists below if trolls get creative.
 */
const TOKENS = new Set([
  // English
  'fuck', 'fucker', 'fucking', 'fucked', 'fck', 'fuk', 'shit', 'shitty', 'bullshit', 'bitch', 'bitches',
  'bastard', 'asshole', 'ass', 'arse', 'dick', 'dickhead', 'cock', 'pussy', 'cunt', 'whore', 'slut',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'twat', 'wanker', 'prick', 'douche', 'dildo', 'porn',
  'rape', 'rapist', 'penis', 'vagina', 'boobs', 'tits', 'cum', 'jizz', 'wtf', 'stfu',
  // Roman Urdu / Hindi
  'chutiya', 'chutiye', 'chutia', 'bhenchod', 'behenchod', 'bhencho', 'benchod', 'madarchod', 'maderchod',
  'gandu', 'gaandu', 'harami', 'haramzada', 'haramzadi', 'kanjar', 'kanjri', 'randi', 'gashti', 'kamina',
  'kaminay', 'kamine', 'lun', 'lund', 'phudi', 'phuddi', 'bhosri', 'bhosdi', 'bhosdike', 'choot', 'chod',
  'kutiya', 'lanati'
]);
const ROOTS = ['fuck', 'bhenchod', 'behenchod', 'madarchod', 'chutiya', 'nigger', 'nigga', 'faggot', 'motherf'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };
// Common Cyrillic/Greek/Armenian lookalikes of Latin letters. ponytail: a short list, not the full Unicode confusables table.
const HOMOGLYPHS = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', к: 'k', ս: 'u', օ: 'o', ո: 'n', α: 'a', ο: 'o', ι: 'i', κ: 'k', υ: 'u' };
const SUFFIX = /(es|s|z|ed|ing|head|face)$/;

function fold(token) {
  return token.normalize('NFKC').toLowerCase()
    .replace(/[013457@$!]/g, (c) => LEET[c])
    .replace(/./gu, (c) => HOMOGLYPHS[c] || c)
    .replace(/[^\p{L}]/gu, '');
}

function isBadToken(raw) {
  const t = fold(raw);
  if (!t) return false;
  const squeezed = t.replace(/(.)\1+/g, '$1');
  if ([t, squeezed, t.replace(SUFFIX, ''), squeezed.replace(SUFFIX, '')].some((x) => TOKENS.has(x))) return true;
  return ROOTS.some((r) => t.includes(r));
}

// Runs of single letters ("f u c k") are checked joined together.
const SPACED = /(?<!\S)(?:\S\s+){2,}\S(?!\S)/gu;
const spacedRuns = (text) => text.match(SPACED) || [];

/** True if any whitespace-separated token (or spaced-out letter run) is profane. */
function isProfane(text) {
  const s = String(text);
  return s.split(/\s+/).some(isBadToken) || spacedRuns(s).some((run) => isBadToken(run.replace(/\s+/g, '')));
}

/** Replace profane tokens (and spaced-out letter runs) with asterisks, keeping spacing intact. */
function censor(text) {
  const s = String(text).replace(SPACED, (run) => (isBadToken(run.replace(/\s+/g, '')) ? run.replace(/\S/g, '*') : run));
  return s.split(/(\s+)/).map((p) => (isBadToken(p) ? '*'.repeat(p.length) : p)).join('');
}

module.exports = { isProfane, censor };
