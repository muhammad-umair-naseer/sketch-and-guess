'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const { guesserPoints, drawerPoints } = require('../server/scoring');
const words = require('../server/words');
const { isProfane, censor } = require('../server/profanity');
const { sanitizeOp, sanitizeSettings, cleanName } = require('../server/validate');
const { createRanking, utcDay } = require('../server/ranking');
const Shared = require('../public/js/shared');

test('scoring: guesser points', async (t) => {
  await t.test('scales with remaining time', () => {
    assert.equal(guesserPoints({ remainingFrac: 1, order: 3, hints: 0, difficulty: 'easy' }), 105);
    assert.equal(guesserPoints({ remainingFrac: 0.5, order: 3, hints: 0, difficulty: 'easy' }), 55);
    assert.equal(guesserPoints({ remainingFrac: 0, order: 3, hints: 0, difficulty: 'easy' }), 5);
    // Out-of-range fractions are clamped.
    assert.equal(guesserPoints({ remainingFrac: 2, order: 3, hints: 0, difficulty: 'easy' }), 105);
    assert.equal(guesserPoints({ remainingFrac: -1, order: 3, hints: 0, difficulty: 'easy' }), 5);
  });
  await t.test('order bonus 50/30/15/5', () => {
    const at = (order) => guesserPoints({ remainingFrac: 0, order, hints: 0, difficulty: 'easy' });
    assert.deepEqual([0, 1, 2, 3, 7].map(at), [50, 30, 15, 5, 5]);
  });
  await t.test('each hint cuts the time max by 15%', () => {
    const at = (hints) => guesserPoints({ remainingFrac: 1, order: 3, hints, difficulty: 'easy' });
    assert.equal(at(1), 90);
    assert.equal(at(2), 75);
    assert.equal(at(10), 5); // never negative
  });
  await t.test('difficulty multipliers 1 / 1.2 / 1.5', () => {
    const at = (difficulty) => guesserPoints({ remainingFrac: 1, order: 0, hints: 0, difficulty });
    assert.equal(at('easy'), 150);
    assert.equal(at('medium'), 180);
    assert.equal(at('hard'), 225);
  });
});

test('scoring: drawer points', () => {
  assert.equal(drawerPoints({ correct: 0, guessers: 3, difficulty: 'hard' }), 0);
  assert.equal(drawerPoints({ correct: 2, guessers: 3, difficulty: 'easy' }), 50);
  assert.equal(drawerPoints({ correct: 3, guessers: 3, difficulty: 'easy' }), 125);
  assert.equal(drawerPoints({ correct: 3, guessers: 3, difficulty: 'medium' }), 150);
  assert.equal(drawerPoints({ correct: 1, guessers: 1, difficulty: 'hard' }), 113);
});

test('words: normalize + levenshtein', () => {
  assert.equal(words.normalize('  Ice   CREAM '), 'ice cream');
  assert.equal(words.levenshtein('kitten', 'sitting'), 3);
  assert.equal(words.levenshtein('cat', 'cat'), 0);
  assert.equal(words.levenshtein('cat', 'cats'), 1);
  assert.equal(words.levenshtein('cat', 'dog', 1), 2); // early bail-out returns max + 1
  assert.equal(words.levenshtein('a', 'abcdef', 1), 2);
});

test('words: mask keeps spaces and hyphens', () => {
  assert.equal(words.mask('ice cream', new Set()), '___ _____');
  assert.equal(words.mask('t-rex', new Set()), '_-___');
  assert.equal(words.mask('hot dog', new Set([0, 4])), 'h__ d__');
  assert.deepEqual(words.hiddenLetterIndices('a b', new Set()), [0, 2]);
});

test('words: pickChoices returns 3 distinct choices', () => {
  const settings = { categories: Object.keys(Shared.CATEGORIES), customWords: [], customOnly: false };
  for (let i = 0; i < 50; i++) {
    const c = words.pickChoices(settings, new Set());
    assert.equal(c.length, 3);
    assert.equal(new Set(c.map((x) => x.word)).size, 3);
    assert.deepEqual(c.map((x) => x.difficulty), ['easy', 'medium', 'hard']);
  }
});

test('words: pickChoices custom-only uses only custom words', () => {
  const customWords = ['zorblat', 'quizzle', 'flumphy', 'ab'];
  for (let i = 0; i < 30; i++) {
    const c = words.pickChoices({ categories: ['food'], customWords, customOnly: true }, new Set(['zorblat']));
    assert.equal(c.length, 3);
    assert.equal(new Set(c.map((x) => x.word)).size, 3);
    for (const x of c) assert.ok(customWords.includes(x.word), x.word);
  }
});

test('words: parseCustomWords filters invalid, duplicate and profane entries', () => {
  const out = words.parseCustomWords('Pizza, pizza, ice  cream, t-rex, a, 123, x<y>, shit, ' + 'a'.repeat(31) + ', café', (w) => !isProfane(w));
  assert.deepEqual(out, ['pizza', 'ice cream', 't-rex', 'café']);
});

test('profanity: flags bad tokens, not innocent words', () => {
  for (const bad of ['fuck', 'you are a b1tch', 'SHIIIT', 'chutiya', 'motherfucker', 'f u c k off ass', 'niggas', 'cunts', 'dicks', 'shithead', 'f u c k', 'fսck']) {
    assert.ok(isProfane(bad), bad);
  }
  for (const ok of ['class', 'cucumber', 'kutta', 'assistant', 'grass', 'Scunthorpe', 'hello there', 'Dickens', 'cocky', 'I am a b c d']) {
    assert.equal(isProfane(ok), false, ok);
  }
  assert.equal(censor('what the fuck  man'), 'what the ****  man');
  assert.equal(cleanName('shit'), null);
  assert.equal(cleanName('niggas'), null);
  assert.equal(censor('you f u c k off'), 'you * * * * off');
  assert.equal(cleanName('  Ali <b> '), 'Ali b');
});

test('validate.sanitizeOp', async (t) => {
  const stroke = (o) => sanitizeOp({ type: 'stroke', id: 'a1', color: '#000000', size: 10, points: [0.1, 0.2], ...o });
  await t.test('accepts a valid stroke and rounds points', () => {
    assert.deepEqual(stroke({ points: [0.123456, 1] }), { type: 'stroke', id: 'a1', color: '#000000', size: 10, points: [0.1235, 1] });
  });
  await t.test('rejects bad colors and sizes', () => {
    assert.equal(stroke({ color: '#123456' }), null);
    assert.equal(stroke({ color: 'red' }), null);
    assert.equal(stroke({ size: 11 }), null);
    assert.equal(stroke({ size: '10' }), null);
  });
  await t.test('rejects bad points', () => {
    assert.equal(stroke({ points: [1.01, 0.5] }), null);
    assert.equal(stroke({ points: [-0.1, 0.5] }), null);
    assert.equal(stroke({ points: [NaN, 0.5] }), null);
    assert.equal(stroke({ points: [0.5] }), null);
    assert.equal(stroke({ points: [0.1, 0.2, 0.3] }), null);
    assert.equal(stroke({ points: new Array(402).fill(0.5) }), null); // 201 points
    assert.ok(stroke({ points: new Array(400).fill(0.5) })); // exactly 200 is fine
  });
  await t.test('rejects bad ids and unknown types', () => {
    assert.equal(stroke({ id: 'bad id' }), null);
    assert.equal(stroke({ id: 'x'.repeat(17) }), null);
    assert.equal(sanitizeOp({ type: 'nope' }), null);
    assert.equal(sanitizeOp(null), null);
  });
  await t.test('fill / undo / clear', () => {
    assert.deepEqual(sanitizeOp({ type: 'fill', id: 'f1', x: 0.5, y: 0.5, color: '#ffffff', extra: 1 }), { type: 'fill', id: 'f1', x: 0.5, y: 0.5, color: '#ffffff' });
    assert.equal(sanitizeOp({ type: 'fill', id: 'f1', x: 2, y: 0.5, color: '#ffffff' }), null);
    assert.deepEqual(sanitizeOp({ type: 'undo', strokeId: 'a1' }), { type: 'undo', strokeId: 'a1' });
    assert.equal(sanitizeOp({ type: 'undo', strokeId: '' }), null);
    assert.deepEqual(sanitizeOp({ type: 'clear', junk: true }), { type: 'clear' });
  });
});

test('validate.sanitizeSettings', () => {
  const cur = { rounds: 3, drawTime: 80, maxPlayers: 8, categories: ['food'], customWords: [], customOnly: false, hints: true };
  assert.deepEqual(sanitizeSettings({ rounds: 99, drawTime: 61, maxPlayers: 1, categories: ['bogus'], hints: 'yes' }, cur, 2), cur);
  assert.deepEqual(sanitizeSettings({ maxPlayers: 4 }, cur, 5).maxPlayers, 8); // can't go below current headcount
  const s = sanitizeSettings({ rounds: '5', drawTime: 120, maxPlayers: 12, categories: ['tech', 'tech'], customWords: 'apple,banana', customOnly: true, hints: false }, cur, 2);
  assert.deepEqual(s, { rounds: 5, drawTime: 120, maxPlayers: 12, categories: ['tech'], customWords: ['apple', 'banana'], customOnly: true, hints: false });
});

test('ranking', async (t) => {
  const db = new Database(':memory:');
  const ranking = createRanking(db);
  const DAY = 86400000;
  const setLastDay = (id, day) => db.prepare('UPDATE rank_stats SET last_play_day = ? WHERE player_id = ?').run(day, id);
  const game = (id, players) => ranking.recordGame({ gameId: id, players: players.map(([playerId, score, placement]) => ({ playerId, name: `P${playerId}`, avatar: 1, score, placement })) });

  await t.test('wins and win streaks', () => {
    game('g1', [[1, 300, 1], [2, 100, 2]]);
    game('g2', [[1, 250, 1], [2, 200, 2]]);
    let s = ranking.getPlayerStats(1);
    assert.equal(s.wins, 2);
    assert.equal(s.winStreak, 2);
    assert.equal(s.bestWinStreak, 2);
    assert.equal(s.totalPoints, 550);
    assert.equal(s.bestGameScore, 300);
    assert.equal(s.gamesPlayed, 2);
    game('g3', [[1, 50, 2], [2, 400, 1]]);
    s = ranking.getPlayerStats(1);
    assert.equal(s.winStreak, 0);
    assert.equal(s.bestWinStreak, 2);
    assert.equal(ranking.getPlayerStats(2).winStreak, 1);
    // Recording the same game twice does not duplicate the game row.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rank_games WHERE game_id = 'g3'").get().n, 2);
  });

  await t.test('daily streak', () => {
    assert.equal(ranking.getPlayerStats(1).dailyStreak, 1); // several games today count once
    setLastDay('1', utcDay(Date.now() - DAY));
    game('g4', [[1, 10, 1], [2, 5, 2]]);
    assert.equal(ranking.getPlayerStats(1).dailyStreak, 2);
    assert.equal(ranking.getPlayerStats(1).bestDailyStreak, 2);
    setLastDay('1', utcDay(Date.now() - 3 * DAY));
    game('g5', [[1, 10, 1], [2, 5, 2]]);
    assert.equal(ranking.getPlayerStats(1).dailyStreak, 1);
    assert.equal(ranking.getPlayerStats(1).bestDailyStreak, 2);
    // A stale streak is reported as 0.
    setLastDay('2', utcDay(Date.now() - 3 * DAY));
    assert.equal(ranking.getPlayerStats(2).dailyStreak, 0);
  });

  await t.test('local leaderboard only lists players you shared a game with', () => {
    game('g6', [[3, 999, 1], [4, 1, 2]]);
    const global = ranking.getLeaderboard({ scope: 'global', sort: 'points' });
    assert.equal(global.length, 4);
    assert.equal(global[0].playerId, '3');
    assert.deepEqual(ranking.getLeaderboard({ sort: 'wins' })[0].playerId, '1');
    const local = ranking.getLeaderboard({ scope: 'local', playerId: 1, sort: 'wins' });
    assert.deepEqual(local.map((r) => r.playerId).sort(), ['1', '2']);
    assert.equal(ranking.getLeaderboard({ scope: 'local', playerId: 3 }).length, 2);
  });

  await t.test('unknown sort keys fall back to points', () => {
    for (const sort of ['constructor', 'toString', '__proto__', 'bogus']) {
      assert.equal(ranking.getLeaderboard({ sort })[0].playerId, '3', sort);
    }
  });

  await t.test('daily sort ranks expired streaks as 0', () => {
    game('g7', [[5, 1, 1], [6, 1, 2]]); // both have an active 1-day streak
    db.prepare("UPDATE rank_stats SET daily_streak = 30, last_play_day = ? WHERE player_id = '4'").run(utcDay(Date.now() - 10 * DAY));
    for (const scope of ['global', 'local']) {
      const top = ranking.getLeaderboard({ scope, playerId: 4, sort: 'daily' });
      assert.notEqual(top[0].playerId, '4', scope);
      assert.equal(top.find((r) => r.playerId === '4').dailyStreak, 0);
    }
  });

  await t.test('badges', () => {
    ranking.awardBadge(1, 'crowd_favorite', 'P1', 1);
    ranking.awardBadge(1, 'crowd_favorite', 'P1', 1);
    assert.deepEqual(ranking.getPlayerStats(1).badges, { crowd_favorite: 2 });
    assert.equal(ranking.getPlayerStats(99), null);
  });
  db.close();
});
