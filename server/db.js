'use strict';
/**
 * SQLite storage for player identities and the Best Drawing gallery.
 * (Leaderboards and streaks live in ./ranking.js, which owns its own tables.)
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token      TEXT UNIQUE NOT NULL,
      name       TEXT NOT NULL DEFAULT 'Player',
      avatar     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gallery (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      word          TEXT NOT NULL,
      artist_id     INTEGER NOT NULL,
      artist_name   TEXT NOT NULL,
      artist_avatar INTEGER NOT NULL,
      ops           TEXT NOT NULL,
      votes         INTEGER NOT NULL DEFAULT 0,
      likes         INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );
  `);
  return db;
}

/** Thin query layer used by the game server and HTTP routes. */
function createStore(db) {
  const q = {
    byToken: db.prepare('SELECT * FROM players WHERE token = ?'),
    insert: db.prepare('INSERT INTO players (token, created_at) VALUES (?, ?)'),
    update: db.prepare('UPDATE players SET name = ?, avatar = ? WHERE id = ?'),
    addArt: db.prepare(`INSERT INTO gallery (word, artist_id, artist_name, artist_avatar, ops, votes, likes, created_at)
                        VALUES (@word, @artistId, @artistName, @artistAvatar, @ops, @votes, @likes, @createdAt)`),
    listArt: db.prepare(`SELECT id, word, artist_name AS artistName, artist_avatar AS artistAvatar, ops, votes, likes,
                         created_at AS createdAt FROM gallery WHERE id < ? ORDER BY id DESC LIMIT ?`)
  };
  return {
    findPlayer: (token) => q.byToken.get(token),
    getOrCreatePlayer(token) {
      return q.byToken.get(token) || { id: Number(q.insert.run(token, Date.now()).lastInsertRowid), token };
    },
    updatePlayer: (id, name, avatar) => q.update.run(name, avatar, id),
    addGalleryEntry: (e) => q.addArt.run({ ...e, ops: JSON.stringify(e.ops), createdAt: Date.now() }),
    listGallery({ before, limit }) {
      return q.listArt.all(before || Number.MAX_SAFE_INTEGER, limit).map((r) => ({ ...r, ops: JSON.parse(r.ops) }));
    }
  };
}

module.exports = { openDb, createStore };
