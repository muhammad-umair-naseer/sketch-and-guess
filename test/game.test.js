'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { start } = require('../server');
const { QUICK } = require('../server/game');

let srv;
let url;
const clients = [];

before(async () => {
  srv = await start({ port: 0, dbPath: ':memory:' });
  url = `http://localhost:${srv.port}`;
});
after(async () => {
  for (const c of clients) c.socket.disconnect();
  await srv.close();
});

/** Connect a client (optionally resuming `token`); resolves once the session is known. Records every event. */
function connect(token) {
  const socket = io(url, { auth: token ? { token } : {}, transports: ['websocket'], forceNew: true, reconnection: false });
  const c = { socket, log: [], waiters: [] };
  socket.onAny((ev, data) => {
    c.log.push([ev, data]);
    if (ev === 'state') c.state = data;
    c.waiters = c.waiters.filter((w) => !(w.ev === ev && w.pred(data) && (w.resolve(data), true)));
  });
  clients.push(c);
  return new Promise((resolve, reject) => {
    socket.once('session', ({ token: t, playerId }) => Object.assign(c, { token: t, playerId }) && resolve(c));
    socket.once('connect_error', reject);
  });
}

/** First event `ev` matching `pred` at or after log index `from` (already received, or the next one). */
function waitFor(c, ev, pred = () => true, from = 0) {
  const hit = c.log.slice(from).find(([e, d]) => e === ev && pred(d));
  if (hit) return Promise.resolve(hit[1]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), 2000);
    c.waiters.push({ ev, pred, resolve: (d) => { clearTimeout(timer); resolve(d); } });
  });
}

const ask = (c, ev, ...args) => c.socket.emitWithAck(ev, ...args);
/** Round trip barrier: once this resolves, everything the server sent this client earlier has arrived. */
const sync = (c) => ask(c, 'ping', null);
const eventsOf = (c, ev, from = 0) => c.log.slice(from).filter(([e]) => e === ev).map(([, d]) => d);

async function player(name) {
  return connect().then((c) => Object.assign(c, { name }));
}
async function roomWith(names) {
  const [host, ...rest] = await Promise.all(names.map(player));
  const { code } = await ask(host, 'room:create', { name: host.name, avatar: 1 });
  for (const c of rest) assert.equal((await ask(c, 'room:join', { code, name: c.name, avatar: 2 })).ok, true);
  return { code, host, rest, room: srv.rooms.get(code) };
}

test('create a private room and join it by code', async () => {
  const a = await player('Alice');
  const b = await player('Bob');
  const res = await ask(a, 'room:create', { name: 'Alice', avatar: 3 });
  assert.equal(res.ok, true);
  assert.match(res.code, /^[A-Z2-9]{6}$/);
  assert.deepEqual(await ask(b, 'room:join', { code: 'NOPE00', name: 'Bob', avatar: 0 }), { error: 'Room not found. Check the code?' });
  assert.equal((await ask(b, 'room:join', { code: res.code.toLowerCase(), name: 'Bob', avatar: 0 })).code, res.code);
  const s = await waitFor(a, 'state', (st) => st.players.length === 2);
  assert.equal(s.isPublic, false);
  assert.equal(s.hostId, a.playerId);
  assert.deepEqual(s.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.ok((await ask(b, 'room:create', { name: 'shit', avatar: 0 })).error, 'profane name rejected');
});

test('quick play puts players in the same public room', async () => {
  const a = await player('Q1');
  const b = await player('Q2');
  const r1 = await ask(a, 'room:quick', { name: 'Q1', avatar: 0 });
  const r2 = await ask(b, 'room:quick', { name: 'Q2', avatar: 0 });
  assert.equal(r1.code, r2.code);
  assert.equal(srv.rooms.get(r1.code).isPublic, true);
  for (const c of [a, b]) await ask(c, 'room:leave'); // close the room so later quick-play tests start clean
});

test('host settings are validated and host-only', async () => {
  const { host, rest: [b] } = await roomWith(['Host', 'Guest']);
  let mark = host.log.length;
  await ask(host, 'room:settings', { rounds: 99, drawTime: 61, maxPlayers: 1, categories: ['bogus'], hints: 'nope' });
  let s = await waitFor(host, 'state', () => true, mark);
  assert.deepEqual([s.settings.rounds, s.settings.drawTime, s.settings.maxPlayers, s.settings.categories, s.settings.hints],
    [3, 80, 8, ['everyday', 'food', 'animals'], true]);

  mark = b.log.length;
  await ask(host, 'room:settings', { rounds: 4, drawTime: 60, maxPlayers: 5, categories: ['tech'], customWords: 'apple, banana, shit, 12', customOnly: false, hints: false });
  s = await waitFor(b, 'state', (st) => st.settings.rounds === 4, mark);
  assert.deepEqual([s.settings.drawTime, s.settings.maxPlayers, s.settings.categories, s.settings.hints], [60, 5, ['tech'], false]);
  assert.deepEqual(s.settings.customWords, [], 'custom words are hidden from non-hosts');
  assert.equal(s.settings.customWordCount, 2);
  assert.deepEqual(host.state.settings.customWords, ['apple', 'banana']);

  await ask(b, 'room:settings', { rounds: 6 });
  await sync(host);
  assert.equal(host.state.settings.rounds, 4, 'non-host change ignored');
});

test('starting needs 2 players and the host', async () => {
  const a = await player('Solo');
  await ask(a, 'room:create', { name: 'Solo', avatar: 0 });
  assert.deepEqual(await ask(a, 'room:start'), { error: 'You need at least 2 players.' });
  const { rest: [b] } = await roomWith(['H', 'G']);
  assert.deepEqual(await ask(b, 'room:start'), { error: 'Only the host can start.' });
});

test('full turn: secrecy, drawing relay, guesses, secret chat, reveal', async () => {
  const { code, host: A, rest: [B, C], room } = await roomWith(['Artist', 'Bea', 'Cal']);
  await ask(A, 'room:settings', { customWords: 'zorblat,quizzle,flumphy', customOnly: true, hints: false });

  // C is the spy: every payload it receives before it guesses must not contain the word.
  const spyFrom = C.log.length;
  assert.deepEqual(await ask(A, 'room:start'), { ok: true });

  const choosing = await waitFor(A, 'state', (s) => s.phase === 'choosing');
  assert.equal(choosing.drawerId, A.playerId);
  assert.equal(choosing.choices.length, 3);
  const cState = await waitFor(C, 'state', (s) => s.phase === 'choosing');
  assert.equal(cState.choices, null);
  assert.equal(cState.word, null);

  // Drawer can't chat.
  let mark = A.log.length;
  await ask(A, 'chat', 'hi all');
  assert.equal((await waitFor(A, 'chat', () => true, mark)).type, 'error');

  await ask(A, 'turn:choose', 0);
  const word = choosing.choices[0].word;
  const drawing = await waitFor(A, 'state', (s) => s.phase === 'drawing');
  assert.equal(drawing.word, word);
  const cDrawing = await waitFor(C, 'state', (s) => s.phase === 'drawing');
  assert.equal(cDrawing.word, null);
  assert.equal(cDrawing.mask, '_'.repeat(word.length));

  // Drawer ops are relayed to everyone else; non-drawer ops are dropped.
  const op = { type: 'stroke', id: 's1', color: '#e53935', size: 10, points: [0.1, 0.1, 0.5, 0.5] };
  A.socket.emit('draw', op);
  B.socket.emit('draw', { ...op, id: 'evil' });
  await Promise.all([sync(A), sync(B)]);
  await Promise.all([sync(B), sync(C)]);
  for (const c of [B, C]) assert.deepEqual(eventsOf(c, 'draw'), [op]);
  assert.equal(eventsOf(A, 'draw').length, 0, 'drawer does not get its own ops back');
  assert.deepEqual(room.turn.ops.map((o) => o.id), ['s1']);

  // Late joiner receives the full canvas, then leaves again.
  const D = await player('Dee');
  await ask(D, 'room:join', { code, name: 'Dee', avatar: 4 });
  const syncMsg = await waitFor(D, 'canvas:sync');
  assert.equal(syncMsg.turnId, drawing.turnId);
  assert.deepEqual(syncMsg.ops, [op]);
  assert.equal(D.state.word, null);
  await ask(D, 'room:leave');

  // Close guess: private "so close!" only to B; the guess itself is public chat.
  const close = word.slice(0, -1) + (word.endsWith('x') ? 'y' : 'x');
  mark = C.log.length;
  await ask(B, 'chat', close);
  await sync(B);
  await sync(C);
  assert.ok(eventsOf(B, 'chat').some((m) => m.type === 'close'));
  assert.ok(!eventsOf(C, 'chat').some((m) => m.type === 'close'));
  assert.ok(eventsOf(C, 'chat', mark).some((m) => m.type === 'msg' && m.text === close));

  // Correct guess: fx for everyone, no chat echo, points for B.
  mark = C.log.length;
  await ask(B, 'chat', `  ${word.toUpperCase()} `);
  const fx = await waitFor(C, 'fx', (f) => f.type === 'guessed', mark);
  assert.equal(fx.playerId, B.playerId);
  const bState = await waitFor(B, 'state', (s) => s.players.find((p) => p.id === B.playerId).guessed);
  assert.equal(bState.word, word, 'guesser now sees the word');
  assert.ok(bState.players.find((p) => p.id === B.playerId).score > 0);

  // B's chat is now secret: A and B see it, C does not.
  mark = C.log.length;
  await ask(B, 'chat', 'psst');
  await Promise.all([sync(A), sync(B), sync(C)]);
  for (const c of [A, B]) assert.ok(eventsOf(c, 'chat').some((m) => m.type === 'secret' && m.text === 'psst'));
  assert.ok(!eventsOf(C, 'chat', mark).some((m) => m.text === 'psst'));

  // Secrecy check over everything C received so far.
  const leaked = C.log.slice(spyFrom).filter(([, d]) => JSON.stringify(d ?? null).toLowerCase().includes(word));
  assert.deepEqual(leaked, [], 'word leaked to a guesser before they guessed it');
  assert.ok(C.log.slice(spyFrom).every(([e, d]) => e !== 'state' || d.choices === null));

  // Last guesser gets it: the turn ends with deltas.
  await ask(C, 'chat', word);
  const reveal = await waitFor(C, 'turn:reveal');
  assert.equal(reveal.word, word);
  assert.equal(reveal.reason, 'all_guessed');
  const delta = (id) => reveal.deltas.find((d) => d.id === id).delta;
  assert.ok(delta(B.playerId) > delta(C.playerId), 'first guesser earns more');
  assert.equal(delta(A.playerId), drawing.difficulty === 'easy' ? 100 : drawing.difficulty === 'medium' ? 120 : 150);
});

test('reconnecting with the same token resumes the seat', async () => {
  const { host: A, rest: [B], code } = await roomWith(['Ann', 'Ben']);
  const token = B.token;
  B.socket.disconnect();
  await waitFor(A, 'state', (s) => s.players.find((p) => p.id === B.playerId)?.connected === false);
  const B2 = await connect(token);
  assert.equal(B2.playerId, B.playerId);
  const s = await waitFor(B2, 'state');
  assert.equal(s.code, code);
  assert.equal(s.you, B.playerId);
  assert.equal(s.players.length, 2);
  await waitFor(A, 'state', (st) => st.players.find((p) => p.id === B.playerId)?.connected === true);
});

test('a replaced session can no longer act for the seat', async () => {
  const { host: A, rest: [B] } = await roomWith(['Ari', 'Bo']);
  const B2 = await connect(B.token);
  await waitFor(B, 'session:replaced');
  const mark = A.log.length;
  await ask(B, 'chat', 'ghost message');
  await ask(B2, 'chat', 'real message');
  await sync(A);
  const texts = eventsOf(A, 'chat', mark).map((m) => m.text);
  assert.deepEqual(texts, ['real message']);
});

test('vote-kick needs a majority (3 players)', async () => {
  const { host: A, rest: [B, C], code } = await roomWith(['K1', 'K2', 'K3']);
  await ask(A, 'kick', C.playerId);
  await sync(C);
  assert.equal(eventsOf(C, 'kicked').length, 0, 'one vote of two needed is not enough');
  assert.equal(C.state.players.find((p) => p.id === C.playerId).kickVotes, 1);
  await ask(B, 'kick', C.playerId);
  await waitFor(C, 'kicked');
  const s = await waitFor(A, 'state', (st) => st.players.length === 2);
  assert.ok(!s.players.some((p) => p.id === C.playerId));
  assert.match((await ask(C, 'room:join', { code, name: 'K3', avatar: 0 })).error, /vote-kicked/);
});

test('vote-kick is refused with only 2 players', async () => {
  const { host: A, rest: [B] } = await roomWith(['V1', 'V2']);
  const mark = A.log.length;
  await ask(A, 'kick', B.playerId);
  assert.equal((await waitFor(A, 'chat', () => true, mark)).type, 'error');
  assert.equal(eventsOf(B, 'kicked').length, 0);
});

test('chat is rate limited', async () => {
  const { host: A } = await roomWith(['Spam', 'Mate']);
  const acks = await Promise.all(Array.from({ length: 10 }, (_, i) => ask(A, 'chat', `msg ${i}`)));
  assert.ok(acks.some((r) => r.error === 'Slow down a little!'));
  assert.ok(acks.filter((r) => r.ok).length >= 5);
});

test('vote-kick majority counts seats in their grace window', async () => {
  const { host: A, rest: [B, C] } = await roomWith(['G1', 'G2', 'G3']);
  C.socket.disconnect(); // C is reconnecting: still seated
  await waitFor(B, 'state', (s) => s.players.find((p) => p.id === C.playerId)?.connected === false);
  await ask(B, 'kick', A.playerId);
  await sync(A);
  assert.equal(eventsOf(A, 'kicked').length, 0, 'one vote of three seats is not a majority');
  assert.equal(A.state.hostId, A.playerId);
});

test('a host migrated mid-game does not receive the custom word list', async () => {
  const { host: A, rest: [B, C], room } = await roomWith(['W1', 'W2', 'W3']);
  await ask(A, 'room:settings', { customWords: 'aardvark,zeppelin,quokka', customOnly: true });
  await ask(A, 'room:start');
  A.socket.disconnect();
  const s = await waitFor(B, 'state', (st) => st.hostId === B.playerId);
  assert.equal(room.phase, 'choosing');
  assert.deepEqual(s.settings.customWords, []);
  assert.equal(s.settings.customWordCount, 3);
  await sync(C);
});

test('reconnecting does not refill the chat rate limit', async () => {
  const { rest: [B] } = await roomWith(['R1', 'R2']);
  await Promise.all(Array.from({ length: 5 }, (_, i) => ask(B, 'chat', `m${i}`)));
  B.socket.disconnect();
  const B2 = await connect(B.token);
  await waitFor(B2, 'state');
  assert.deepEqual(await ask(B2, 'chat', 'flood'), { error: 'Slow down a little!' });
});

test('drawer only gets the everyone-guessed bonus if every remaining guesser guessed', async () => {
  const { host: D, rest: [A, B], room } = await roomWith(['Dra', 'Gue', 'Ssr']);
  await ask(D, 'room:settings', { customWords: 'zorblat,quizzle,flumphy', customOnly: true, hints: false });
  await ask(D, 'room:start');
  await waitFor(D, 'state', (s) => s.phase === 'choosing');
  await ask(D, 'turn:choose', 0);
  await waitFor(D, 'state', (s) => s.phase === 'drawing');
  await ask(A, 'chat', room.turn.word);
  await ask(A, 'room:leave');
  room.endTurn('time');
  const reveal = await waitFor(B, 'turn:reveal');
  const pts = reveal.deltas.find((d) => d.id === D.playerId).delta;
  assert.equal(pts, Math.round(25 * { easy: 1, medium: 1.2, hard: 1.5 }[room.turn.difficulty]), 'no +50 bonus');
});

test('quick play skips a public room that vote-kicked you', async () => {
  const [a, b, c] = await Promise.all(['QK1', 'QK2', 'QK3'].map(player));
  const { code } = await ask(a, 'room:quick', { name: 'QK1', avatar: 0 });
  for (const x of [b, c]) assert.equal((await ask(x, 'room:quick', { name: x.name, avatar: 0 })).code, code);
  await ask(a, 'kick', c.playerId);
  await ask(b, 'kick', c.playerId);
  await waitFor(c, 'kicked');
  const res = await ask(c, 'room:quick', { name: 'QK3', avatar: 0 });
  assert.equal(res.ok, true);
  assert.notEqual(res.code, code);
});

test('leaving and rejoining mid-round does not give a second turn', async () => {
  const { code, host: H, rest: [A], room } = await roomWith(['Hos', 'Abe', 'Bob']);
  await ask(H, 'room:start');
  await waitFor(H, 'state', (s) => s.phase === 'choosing' && s.drawerId === H.playerId);
  await ask(H, 'room:leave');
  await waitFor(A, 'state', (s) => s.drawerId === A.playerId);
  await ask(H, 'room:join', { code, name: 'Hos', avatar: 1 });
  assert.ok(!room.queue.includes(H.playerId), 'already drew this round');
});

test('every offered word counts as used for the rest of the game', async () => {
  const { host: A, room } = await roomWith(['U1', 'U2']);
  await ask(A, 'room:start');
  await waitFor(A, 'state', (s) => s.phase === 'choosing');
  for (const c of room.turn.choices) assert.ok(room.usedWords.has(c.word), c.word);
});

// ---------- Quick Play ----------

/** Shorten quick-room timings and close leftover quick rooms (matchmaking would pick them). Returns a restore fn. */
function fastQuick() {
  const saved = { ...QUICK };
  Object.assign(QUICK, { fillMs: 60, startMs: 120, botStartMs: 60, nextGameMs: 60 });
  for (const r of [...srv.rooms.values()]) if (r.isPublic) r.destroy();
  return () => Object.assign(QUICK, saved);
}
/** One human in a fresh quick room, waited on until bots joined and the first turn began. */
async function soloQuick(name) {
  const a = await player(name);
  const { code } = await ask(a, 'room:quick', { name, avatar: 0 });
  await waitFor(a, 'state', (s) => s.phase === 'choosing');
  return { a, code, room: srv.rooms.get(code) };
}

test('quick play: a solo player gets bots after a wait, then the game starts itself', async (t) => {
  t.after(fastQuick());
  const a = await player('Solo');
  const { code } = await ask(a, 'room:quick', { name: 'Solo', avatar: 0 });
  const first = await waitFor(a, 'state');
  assert.equal(first.mode, 'quick');
  assert.equal(first.players.length, 1, 'bots wait for fillMs');
  assert.ok(first.autoStartAt > first.serverNow);
  const seated = await waitFor(a, 'state', (s) => s.players.length === QUICK.target);
  const botsIn = seated.players.filter((p) => p.isBot);
  assert.equal(botsIn.length, QUICK.target - 1);
  assert.ok(botsIn.every((p) => p.id < 0 && p.connected));
  assert.equal(seated.phase, 'lobby');
  assert.ok(seated.autoStartAt, 'kickoff is scheduled once bots are in');
  const s = await waitFor(a, 'state', (st) => st.phase === 'choosing');
  assert.equal(s.drawerId, a.playerId);
  assert.deepEqual(srv.rooms.get(code).queue, [], 'bots are never queued to draw');
});

test('quick play: bots never draw, no ranking with one human, and the room rolls into the next game', async (t) => {
  t.after(fastQuick());
  const { a, room } = await soloQuick('Loner');
  const drawers = [];
  while (room.phase === 'choosing') { drawers.push(room.drawerId); room.nextTurn(); }
  assert.deepEqual(drawers, [a.playerId, a.playerId, a.playerId], 'one turn per round: every human draws once');
  const over = await waitFor(a, 'state', (s) => s.phase === 'gameover');
  assert.ok(over.gameover.results.some((r) => r.isBot));
  assert.ok(over.nextGameAt, 'no drawings to vote on, so the next game is already scheduled');
  assert.equal(room.ranking.getPlayerStats(a.playerId), null, '1 human + bots is not ranked');
  const mark = a.log.length;
  const lobby = await waitFor(a, 'state', (s) => s.phase === 'lobby', mark);
  assert.equal(lobby.players.length, QUICK.target, 'bots stay seated');
  assert.equal(lobby.nextGameAt, null);
  await waitFor(a, 'state', (s) => s.phase === 'choosing', mark);
});

test('quick play: a bot guess scores through the normal path and can end the turn', async (t) => {
  t.after(fastQuick());
  const { a, room } = await soloQuick('Drawer');
  room.settings.drawTime = 0.5; // bots guess between 25% and 90% of the draw time
  for (const p of room.players.values()) if (p.isBot) p.skill = 2;
  const mark = a.log.length;
  await ask(a, 'turn:choose', 0);
  const word = room.turn.word;
  const reveal = await waitFor(a, 'turn:reveal', () => true, mark);
  assert.equal(reveal.reason, 'all_guessed');
  const botDeltas = reveal.deltas.filter((d) => d.isBot);
  assert.equal(botDeltas.length, QUICK.target - 1);
  assert.ok(botDeltas.every((d) => d.delta > 0));
  assert.ok(reveal.deltas.find((d) => d.id === a.playerId).delta >= 125, 'drawer gets the everyone-guessed bonus');
  const msgs = eventsOf(a, 'chat', mark).filter((m) => m.type === 'msg');
  assert.ok(msgs.every((m) => m.text !== word), 'correct bot guesses are not echoed');
  assert.ok(msgs.every((m) => m.text.length < 3 || !word.includes(m.text)), 'wrong guesses are unrelated words');
});

test('quick play: a human joining a full quick room takes a bot seat', async (t) => {
  t.after(fastQuick());
  const { a, code, room } = await soloQuick('First');
  room.settings.maxPlayers = QUICK.target; // full of 1 human + bots
  const b = await player('Second');
  const res = await ask(b, 'room:quick', { name: 'Second', avatar: 0 });
  assert.equal(res.code, code);
  const s = await waitFor(a, 'state', (st) => st.players.some((p) => p.id === b.playerId));
  assert.equal(s.players.length, QUICK.target);
  assert.equal(s.players.filter((p) => p.isBot).length, QUICK.target - 2);
  assert.ok(eventsOf(a, 'chat').some((m) => m.type === 'system' && /left to make room for Second/.test(m.text)));
});

test('quick play: start, settings and play again are server-controlled', async (t) => {
  t.after(fastQuick());
  const { a, room } = await soloQuick('Ctrl');
  assert.deepEqual(await ask(a, 'room:start'), { error: 'Quick Play games start automatically.' });
  room.toLobby();
  room.clearTimers(); // hold it in the lobby
  await ask(a, 'room:settings', { rounds: 5, drawTime: 120 });
  await ask(a, 'room:again');
  await sync(a);
  assert.deepEqual([a.state.settings.rounds, a.state.settings.drawTime, a.state.phase], [3, 80, 'lobby']);
});

test('private rooms never get bots and still need the host to start', async (t) => {
  t.after(fastQuick());
  const a = await player('Priv');
  const { code } = await ask(a, 'room:create', { name: 'Priv', avatar: 0 });
  await new Promise((r) => setTimeout(r, QUICK.fillMs + QUICK.botStartMs + 50));
  await sync(a);
  assert.equal(a.state.mode, 'private');
  assert.equal(a.state.autoStartAt, null);
  assert.equal(srv.rooms.get(code).players.size, 1);
  assert.equal(a.state.phase, 'lobby');
  assert.deepEqual(await ask(a, 'room:start'), { error: 'You need at least 2 players.' });
});

test('quick play: a human removes a bot with a single vote', async (t) => {
  t.after(fastQuick());
  const { a, room } = await soloQuick('Kicker');
  const bot = [...room.players.values()].find((p) => p.isBot);
  const mark = a.log.length;
  await ask(a, 'kick', bot.id);
  const s = await waitFor(a, 'state', (st) => !st.players.some((p) => p.id === bot.id), mark);
  assert.equal(s.players.length, QUICK.target - 1);
  assert.equal(room.banned.size, 0, 'bots are not banned');
});

test('quick play: the last human leaving destroys the room and its timers', async (t) => {
  t.after(fastQuick());
  const { a, code, room } = await soloQuick('Leaver');
  assert.ok(room.timers.length);
  await ask(a, 'room:leave');
  assert.ok(!srv.rooms.has(code));
  assert.deepEqual(room.timers, []);
  assert.ok(![...srv.rooms.values()].some((r) => r.isPublic), 'no quick room left behind');
});

test('bot decoys never share a word with the answer (no "hot dog" when the word is "dog")', () => {
  const { decoys } = require('../server/bots');
  const words = require('../server/words');
  const categories = ['everyday', 'food', 'animals'];
  const split = (w) => words.normalize(w).split(/[\s-]+/);
  for (const c of categories) for (const d of words.DIFFICULTIES) for (const word of words.BANK[c]?.[d] || []) {
    const parts = new Set(split(word));
    for (const w of decoys({ turn: { word }, settings: { categories } }, 10)) {
      assert.ok(!split(w).some((x) => parts.has(x)), `${w} leaks ${word}`);
    }
  }
});

test('quick play: bot likes alone never earn a Crowd Favorite badge', async (t) => {
  t.after(fastQuick());
  const { a, room } = await soloQuick('Liked');
  await ask(a, 'turn:choose', 0);
  room.clearTimers(); // no scheduled bot guesses
  for (const p of room.players.values()) if (p.isBot) room.handleReaction(p, 'up');
  const awarded = [];
  room.ranking = { ...room.ranking, awardBadge: (...args) => awarded.push(args) };
  room.endTurn('time');
  room.clearTimers();
  assert.deepEqual(awarded, []);
  assert.equal(room.players.get(a.playerId).badges, 0);
});

test('quick play: humans are re-ranked among themselves when a bot wins', async (t) => {
  t.after(fastQuick());
  const { a, code, room } = await soloQuick('Ann');
  const b = await player('Ben');
  assert.equal((await ask(b, 'room:quick', { name: 'Ben', avatar: 0 })).code, code);
  room.clearTimers();
  for (const p of room.players.values()) p.score = p.isBot ? 300 : p.id === a.playerId ? 200 : 100;
  let recorded;
  room.ranking = { ...room.ranking, recordGame: (g) => { recorded = g; } };
  room.finishGame();
  room.clearTimers();
  assert.deepEqual(recorded.players.map((p) => [p.playerId, p.placement]), [[a.playerId, 1], [b.playerId, 2]]);
  assert.equal(room.results.find((r) => r.id === a.playerId).placement, room.results.filter((r) => r.isBot).length + 1, 'display keeps overall places (tied bots share 1st)');
});
