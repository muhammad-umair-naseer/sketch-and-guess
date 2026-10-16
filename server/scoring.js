'use strict';
/**
 * Scoring rules. Server-only: clients never compute or submit points.
 */
const { MULTIPLIER } = require('./words');

const ORDER_BONUS = [50, 30, 15];
const LATE_BONUS = 5;
const HINT_PENALTY = 0.15;

/**
 * Points for a correct guess.
 * @param {number} remainingFrac fraction of draw time left (0..1)
 * @param {number} order 0 for the first correct guesser, 1 for the second, ...
 * @param {number} hints letters revealed so far (each cuts the max by 15%)
 * @param {'easy'|'medium'|'hard'} difficulty
 */
function guesserPoints({ remainingFrac, order, hints, difficulty }) {
  const max = 100 * Math.max(0, 1 - HINT_PENALTY * hints);
  const timePoints = max * Math.min(1, Math.max(0, remainingFrac));
  const bonus = order < ORDER_BONUS.length ? ORDER_BONUS[order] : LATE_BONUS;
  return Math.round((timePoints + bonus) * (MULTIPLIER[difficulty] || 1));
}

/** Drawer: +25 per correct guesser, +50 if everyone guessed, 0 if nobody did. */
function drawerPoints({ correct, guessers, difficulty }) {
  if (correct <= 0) return 0;
  const base = 25 * correct + (correct >= guessers ? 50 : 0);
  return Math.round(base * (MULTIPLIER[difficulty] || 1));
}

module.exports = { guesserPoints, drawerPoints };
