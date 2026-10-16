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
const ROOTS = ['fuck', 'bhenchod', 'behenchod', 'madarchod', 'chutiya', 'nigger', 'faggot', 'motherf'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

function fold(token) {
  return token.toLowerCase().replace(/[013457@$!]/g, (c) => LEET[c]).replace(/[^\p{L}]/gu, '');
}

function isBadToken(raw) {
  const t = fold(raw);
  if (!t) return false;
  if (TOKENS.has(t) || TOKENS.has(t.replace(/(.)\1+/g, '$1'))) return true;
  return ROOTS.some((r) => t.includes(r));
}

/** True if any whitespace-separated token is profane. */
function isProfane(text) {
  return String(text).split(/\s+/).some(isBadToken);
}

/** Replace profane tokens with asterisks, keeping spacing intact. */
function censor(text) {
  return String(text).split(/(\s+)/).map((p) => (isBadToken(p) ? '*'.repeat(p.length) : p)).join('');
}

module.exports = { isProfane, censor };
