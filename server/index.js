'use strict';
/**
 * HTTP + Socket.IO entry point. The server only relays and validates;
 * all rendering happens in the browser.
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { openDb, createStore } = require('./db');
const { createRanking } = require('./ranking');
const { Room } = require('./game');
const { makeLimits, cleanName, cleanAvatar, isToken } = require('./validate');

try { process.loadEnvFile(); } catch { /* .env is optional */ }

const PUBLIC = path.join(__dirname, '..', 'public');
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function start({ port = process.env.PORT || 3000, dbPath = process.env.DB_PATH || './data/sketch.db' } = {}) {
  const db = openDb(dbPath);
  const store = createStore(db);
  const ranking = createRanking(db);
  const rooms = new Map(); // code -> Room

  // ---------- HTTP ----------
  const app = express();
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data: blob:",
        "worker-src 'self' blob:",
        "connect-src 'self' ws: wss:"
      ].join('; ')
    });
    next();
  });
  app.use(express.static(PUBLIC));
  app.use('/vendor/gif', express.static(path.join(__dirname, '..', 'node_modules', 'gif.js', 'dist')));
  app.get('/room/:code', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  app.get(['/gallery', '/leaderboard'], (req, res) => res.sendFile(path.join(PUBLIC, 'gallery.html')));

  const playerFromHeader = (req) => {
    const token = req.get('x-session-token');
    return isToken(token) ? store.findPlayer(token) : null;
  };
  app.get('/api/gallery', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 48);
    res.json(store.listGallery({ before: parseInt(req.query.before, 10) || null, limit }));
  });
  app.get('/api/leaderboard', (req, res) => {
    const me = playerFromHeader(req);
    const scope = req.query.scope === 'local' ? 'local' : 'global';
    if (scope === 'local' && !me) return res.json([]);
    res.json(ranking.getLeaderboard({ scope, playerId: me?.id, sort: String(req.query.sort || 'points') }));
  });
  app.get('/api/me', (req, res) => {
    const me = playerFromHeader(req);
    res.json(me ? { playerId: me.id, name: me.name, stats: ranking.getPlayerStats(me.id) } : null);
  });
  app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

  // ---------- Rooms ----------
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });

  function newCode() {
    let code;
    do code = Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    while (rooms.has(code));
    return code;
  }
  function createRoom(isPublic) {
    const room = new Room({ code: newCode(), isPublic, io, store, ranking, onEmpty: (r) => rooms.delete(r.code) });
    rooms.set(room.code, room);
    return room;
  }
  // ponytail: linear scans over rooms; add a playerId -> room index if rooms reach the thousands.
  const roomOf = (playerId) => [...rooms.values()].find((r) => r.players.has(playerId));
  // A full quick room still has space if a bot can give up its seat.
  const openPublicRoom = (token) => [...rooms.values()].find((r) =>
    r.isPublic && r.phase !== 'gameover' && !r.banned.has(token) &&
    (r.players.size < r.settings.maxPlayers || [...r.players.values()].some((p) => p.isBot)));
  // Rate limits follow the player, not the socket, so reconnecting doesn't refill the buckets.
  // ponytail: entries are never evicted; bounded by the number of players seen since boot.
  const limitsByPlayer = new Map();

  // Every socket carries a session token (generated here if missing/invalid).
  io.use((socket, next) => {
    let token = socket.handshake.auth?.token;
    if (!isToken(token)) token = crypto.randomBytes(16).toString('hex');
    const player = store.getOrCreatePlayer(token);
    socket.data.token = token;
    socket.data.playerId = player.id;
    if (!limitsByPlayer.has(player.id)) limitsByPlayer.set(player.id, makeLimits());
    socket.data.limits = limitsByPlayer.get(player.id);
    next();
  });

  io.on('connection', (socket) => {
    const { token, playerId, limits } = socket.data;
    socket.emit('session', { token, playerId });

    // Reconnect within the grace period: resume the seat transparently.
    const existing = roomOf(playerId);
    if (existing) {
      const p = existing.players.get(playerId);
      existing.join({ id: playerId, token, name: p.name, avatar: p.avatar }, socket);
    }

    const room = () => rooms.get(socket.data.roomCode);
    const me = () => room()?.players.get(playerId);
    /** Register a handler with rate limiting and crash protection. */
    const on = (event, limit, fn) => socket.on(event, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      if (!limits[limit]()) return ack({ error: 'Slow down a little!' });
      try { fn(ack, ...args); } catch (err) { console.error(`[${event}]`, err); ack({ error: 'Something went wrong.' }); }
    });

    function enter(r, profile, ack) {
      const name = cleanName(profile?.name);
      if (!name) return ack({ error: 'Please choose a different name (1–16 characters, keep it friendly).' });
      const avatar = cleanAvatar(profile?.avatar);
      const prev = room();
      if (prev && prev !== r) prev.remove(playerId, 'left');
      store.updatePlayer(playerId, name, avatar);
      ack(r.join({ id: playerId, token, name, avatar }, socket));
    }

    on('ping', 'action', (ack) => ack(Date.now()));
    on('room:create', 'action', (ack, profile) => {
      if (!cleanName(profile?.name)) return ack({ error: 'Please choose a different name (1–16 characters, keep it friendly).' });
      enter(createRoom(false), profile, ack);
    });
    on('room:quick', 'action', (ack, profile) => {
      if (!cleanName(profile?.name)) return ack({ error: 'Please choose a different name (1–16 characters, keep it friendly).' });
      enter(openPublicRoom(token) || createRoom(true), profile, ack);
    });
    on('room:join', 'action', (ack, data) => {
      const r = rooms.get(String(data?.code || '').toUpperCase());
      if (!r) return ack({ error: 'Room not found. Check the code?' });
      enter(r, data, ack);
    });
    on('room:leave', 'action', (ack) => { room()?.remove(playerId, 'left'); ack({ ok: true }); });
    on('room:settings', 'action', (ack, s) => { room()?.updateSettings(playerId, s); ack({ ok: true }); });
    on('room:start', 'action', (ack) => ack(room()?.start(playerId) || { error: 'Not in a room.' }));
    on('room:again', 'action', (ack) => { room()?.playAgain(playerId); ack({ ok: true }); });
    on('turn:choose', 'action', (ack, i) => { room()?.chooseWord(playerId, i); ack({ ok: true }); });
    on('chat', 'chat', (ack, text) => { const p = me(); if (p) room().handleChat(p, text); ack({ ok: true }); });
    on('draw', 'draw', (ack, op) => { const p = me(); if (p) room().handleDraw(p, op); });
    on('react', 'react', (ack, kind) => { const p = me(); if (p) room().handleReaction(p, kind); });
    on('kick', 'action', (ack, id) => { const p = me(); if (p) room().handleKickVote(p, id); ack({ ok: true }); });
    on('vote', 'action', (ack, turnId) => { const p = me(); if (p) room().handleVote(p, turnId); ack({ ok: true }); });
    on('drawing:get', 'action', (ack, turnId) => ack(room()?.drawingOps(turnId) || null));

    socket.on('disconnect', () => room()?.disconnect(playerId, socket));
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const close = () => new Promise((r) => {
        // Stop room + grace timers first, or they fire later against a closed db and keep the process alive.
        for (const room of rooms.values()) room.destroy();
        io.close();
        server.close(() => { db.close(); r(); });
      });
      resolve({ server, io, port: server.address().port, close, rooms });
    });
  });
}

if (require.main === module) {
  start().then(({ port }) => console.log(`🎨 Sketch & Guess running at http://localhost:${port}`));
}

module.exports = { start };
