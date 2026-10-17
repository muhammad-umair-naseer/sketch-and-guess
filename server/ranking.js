'use strict';
/**
 * Ranking module: leaderboards, win streaks, daily streaks and badges.
 *
 * Self-contained so it can later be merged into a site-wide ranking system:
 * it owns its tables (prefixed `rank_`), knows nothing about rooms or sockets,
 * and identifies players by an opaque `playerId` plus display name/avatar.
 *
 * Interface:
 *   const ranking = createRanking(db)              // db = better-sqlite3 instance
 *   ranking.recordGame({ gameId, players })        // players: [{ playerId, name, avatar, score, placement }]
 *   ranking.awardBadge(playerId, badge)            // e.g. 'crowd_favorite'
 *   ranking.getLeaderboard({ scope, playerId, sort, limit })
 *        scope: 'global' | 'local' (players who shared a game with playerId)
 *        sort:  'points' | 'wins' | 'best' | 'streak' | 'daily'
 *   ranking.getPlayerStats(playerId)               // stats row or null
 *
 * Days are UTC calendar days (YYYY-MM-DD).
 */

const SORTS = {
  points: 'total_points',
  wins: 'wins',
  best: 'best_game_score',
  streak: 'best_win_streak',
  daily: 'daily_streak'
};

const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const prevUtcDay = (day) => utcDay(Date.parse(`${day}T00:00:00Z`) - 86400000);

function createRanking(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rank_stats (
      player_id         TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      avatar            INTEGER NOT NULL DEFAULT 0,
      total_points      INTEGER NOT NULL DEFAULT 0,
      games_played      INTEGER NOT NULL DEFAULT 0,
      wins              INTEGER NOT NULL DEFAULT 0,
      best_game_score   INTEGER NOT NULL DEFAULT 0,
      win_streak        INTEGER NOT NULL DEFAULT 0,
      best_win_streak   INTEGER NOT NULL DEFAULT 0,
      daily_streak      INTEGER NOT NULL DEFAULT 0,
      best_daily_streak INTEGER NOT NULL DEFAULT 0,
      last_play_day     TEXT,
      badges            TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS rank_games (
      game_id   TEXT NOT NULL,
      player_id TEXT NOT NULL,
      score     INTEGER NOT NULL,
      placement INTEGER NOT NULL,
      played_at INTEGER NOT NULL,
      PRIMARY KEY (game_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS rank_games_player ON rank_games(player_id);
  `);

  const q = {
    get: db.prepare('SELECT * FROM rank_stats WHERE player_id = ?'),
    ensure: db.prepare(`INSERT INTO rank_stats (player_id, name, avatar) VALUES (?, ?, ?)
                        ON CONFLICT(player_id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`),
    save: db.prepare(`UPDATE rank_stats SET total_points = @total_points, games_played = @games_played, wins = @wins,
                      best_game_score = @best_game_score, win_streak = @win_streak, best_win_streak = @best_win_streak,
                      daily_streak = @daily_streak, best_daily_streak = @best_daily_streak,
                      last_play_day = @last_play_day WHERE player_id = @player_id`),
    game: db.prepare('INSERT OR IGNORE INTO rank_games (game_id, player_id, score, placement, played_at) VALUES (?, ?, ?, ?, ?)'),
    badges: db.prepare('UPDATE rank_stats SET badges = ? WHERE player_id = ?')
  };

  const publicRow = (r) => r && {
    playerId: r.player_id, name: r.name, avatar: r.avatar,
    totalPoints: r.total_points, gamesPlayed: r.games_played, wins: r.wins,
    bestGameScore: r.best_game_score, winStreak: r.win_streak, bestWinStreak: r.best_win_streak,
    dailyStreak: r.daily_streak, bestDailyStreak: r.best_daily_streak, lastPlayDay: r.last_play_day,
    badges: JSON.parse(r.badges)
  };

  const recordGame = db.transaction(({ gameId, players }) => {
    const today = utcDay();
    for (const p of players) {
      const id = String(p.playerId);
      q.ensure.run(id, p.name, p.avatar | 0);
      const s = q.get.get(id);
      const won = p.placement === 1;
      s.total_points += p.score;
      s.games_played += 1;
      s.wins += won ? 1 : 0;
      s.best_game_score = Math.max(s.best_game_score, p.score);
      s.win_streak = won ? s.win_streak + 1 : 0;
      s.best_win_streak = Math.max(s.best_win_streak, s.win_streak);
      if (s.last_play_day !== today) {
        s.daily_streak = s.last_play_day === prevUtcDay(today) ? s.daily_streak + 1 : 1;
        s.last_play_day = today;
      }
      s.best_daily_streak = Math.max(s.best_daily_streak, s.daily_streak);
      q.save.run(s);
      q.game.run(String(gameId), id, p.score, p.placement, Date.now());
    }
  });

  function awardBadge(playerId, badge, name = 'Player', avatar = 0) {
    const id = String(playerId);
    q.ensure.run(id, name, avatar);
    const badges = JSON.parse(q.get.get(id).badges);
    badges[badge] = (badges[badge] || 0) + 1;
    q.badges.run(JSON.stringify(badges), id);
  }

  function getLeaderboard({ scope = 'global', playerId, sort = 'points', limit = 50 } = {}) {
    const col = Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.points;
    // Expired daily streaks sort as 0, matching what freshDaily() displays.
    const order = sort === 'daily' ? 'CASE WHEN last_play_day >= @yday THEN daily_streak ELSE 0 END' : col;
    const yday = prevUtcDay(utcDay());
    const n = Math.min(Math.max(limit | 0, 1), 100);
    // A stale daily streak (last played before yesterday) is shown as 0.
    const rows = scope === 'local' && playerId != null
      ? db.prepare(`SELECT * FROM rank_stats WHERE player_id IN (
            SELECT DISTINCT g2.player_id FROM rank_games g1 JOIN rank_games g2 ON g1.game_id = g2.game_id
            WHERE g1.player_id = @id) OR player_id = @id ORDER BY ${order} DESC, total_points DESC LIMIT @n`)
        .all({ id: String(playerId), n, ...(sort === 'daily' && { yday }) })
      : db.prepare(`SELECT * FROM rank_stats ORDER BY ${order} DESC, total_points DESC LIMIT @n`).all({ n, ...(sort === 'daily' && { yday }) });
    return rows.map(publicRow).map(freshDaily);
  }

  function freshDaily(s) {
    if (s && s.lastPlayDay && s.lastPlayDay < prevUtcDay(utcDay())) s.dailyStreak = 0;
    return s;
  }

  const getPlayerStats = (playerId) => freshDaily(publicRow(q.get.get(String(playerId)))) || null;

  return { recordGame, awardBadge, getLeaderboard, getPlayerStats };
}

module.exports = { createRanking, utcDay };
