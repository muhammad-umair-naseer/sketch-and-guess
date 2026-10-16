'use strict';
/**
 * Room + turn loop. The server is authoritative for timers, turn order,
 * guess validation and scoring. The secret word only ever goes to the
 * current drawer (and to players who already guessed it, then everyone at reveal).
 */
const crypto = require('crypto');
const words = require('./words');
const { guesserPoints, drawerPoints } = require('./scoring');
const { censor } = require('./profanity');
const { sanitizeOp, sanitizeSettings, cleanChat } = require('./validate');

const CHOOSE_MS = 10_000;
const REVEAL_MS = 5_000;
const VOTE_MS = 25_000;
const GRACE_MS = 30_000;
const MAX_OPS = 3000;      // per-turn caps keep a hostile drawer from ballooning memory
const MAX_POINTS = 60_000;

const DEFAULT_SETTINGS = {
  rounds: 3,
  drawTime: 80,
  maxPlayers: 8,
  categories: ['everyday', 'food', 'animals'],
  customWords: [],
  customOnly: false,
  hints: true
};

class Room {
  constructor({ code, isPublic, io, store, ranking, onEmpty }) {
    Object.assign(this, { code, isPublic, io, store, ranking, onEmpty });
    this.channel = `room:${code}`;
    this.players = new Map(); // id -> player, insertion order = join order
    this.hostId = null;
    this.settings = { ...DEFAULT_SETTINGS, categories: [...DEFAULT_SETTINGS.categories] };
    this.phase = 'lobby';
    this.banned = new Set(); // tokens removed by vote-kick
    this.kickVotes = new Map(); // targetId -> Set(voterId)
    this.timers = [];
    this.turnSeq = 0;
    this.resetGame();
  }

  resetGame() {
    this.round = 0;
    this.queue = [];
    this.drawerId = null;
    this.turn = null;
    this.endsAt = null;
    this.drawings = [];
    this.usedWords = new Set();
    this.turnsPlayed = 0;
    this.results = null;
    this.voting = null;
    for (const p of this.players.values()) { p.score = 0; p.guessed = false; }
  }

  // ---------- helpers ----------
  get inTurn() { return this.phase === 'choosing' || this.phase === 'drawing' || this.phase === 'reveal'; }
  connected() { return [...this.players.values()].filter((p) => p.connected); }
  guessers() { return this.connected().filter((p) => p.id !== this.drawerId); }
  emit(ev, data) { this.io.to(this.channel).emit(ev, data); }
  system(text) { this.emit('chat', { type: 'system', text }); }
  later(ms, fn) { const t = setTimeout(fn, ms); this.timers.push(t); return t; }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; }

  // ---------- membership ----------
  join(info, socket) {
    if (this.banned.has(info.token)) return { error: 'You were vote-kicked from this room.' };
    let p = this.players.get(info.id);
    if (!p) {
      if (this.players.size >= this.settings.maxPlayers) return { error: 'That room is full.' };
      p = { id: info.id, token: info.token, name: info.name, avatar: info.avatar, score: 0, guessed: false, badges: 0 };
      this.players.set(p.id, p);
      if (this.hostId == null) this.hostId = p.id;
      // Joining mid-round: you get a turn this round too.
      if (this.inTurn) this.queue.push(p.id);
      this.system(`${p.name} joined the room`);
    } else if (p.socket && p.socket !== socket) {
      p.socket.emit('session:replaced');
      p.socket.leave(this.channel);
      delete p.socket.data.roomCode; // the replaced tab must not keep acting for this seat
    }
    clearTimeout(p.graceTimer);
    p.socket = socket;
    p.connected = true;
    socket.join(this.channel);
    socket.data.roomCode = this.code;
    this.broadcastState();
    if (this.phase === 'drawing' || this.phase === 'reveal') socket.emit('canvas:sync', { turnId: this.turn.id, ops: this.turn.ops });
    return { ok: true, code: this.code };
  }

  /** Socket dropped: keep the seat for GRACE_MS so a reload/reconnect resumes. */
  disconnect(playerId, socket) {
    const p = this.players.get(playerId);
    if (!p || p.socket !== socket) return;
    p.socket = null;
    p.connected = false;
    p.graceTimer = setTimeout(() => this.remove(p.id, 'left'), GRACE_MS);
    if (this.hostId === p.id) this.migrateHost();
    this.broadcastState();
    if (this.phase === 'drawing') this.checkAllGuessed();
  }

  migrateHost() {
    const next = this.connected()[0] || [...this.players.values()][0];
    this.hostId = next ? next.id : null;
  }

  remove(playerId, reason) {
    const p = this.players.get(playerId);
    if (!p) return;
    clearTimeout(p.graceTimer);
    this.players.delete(playerId);
    if (p.socket) { p.socket.leave(this.channel); delete p.socket.data.roomCode; }
    this.queue = this.queue.filter((id) => id !== playerId);
    this.kickVotes.delete(playerId);
    for (const set of this.kickVotes.values()) set.delete(playerId);
    this.system(reason === 'kicked' ? `${p.name} was vote-kicked` : `${p.name} left the room`);

    if (this.players.size === 0) return this.destroy();
    if (this.hostId === playerId) this.migrateHost();

    if (this.inTurn && this.connected().length < 2) return this.endGameEarly();
    if (playerId === this.drawerId && (this.phase === 'choosing' || this.phase === 'drawing')) return this.endTurn('drawer_left');
    this.broadcastState();
    if (this.phase === 'drawing') this.checkAllGuessed();
  }

  destroy() {
    this.clearTimers();
    for (const p of this.players.values()) clearTimeout(p.graceTimer);
    this.onEmpty(this);
  }

  // ---------- lobby ----------
  updateSettings(byId, input) {
    if (byId !== this.hostId || this.phase !== 'lobby') return;
    this.settings = sanitizeSettings(input, this.settings, this.players.size);
    this.broadcastState();
  }

  start(byId) {
    if (byId !== this.hostId || (this.phase !== 'lobby' && this.phase !== 'gameover')) return { error: 'Only the host can start.' };
    if (this.connected().length < 2) return { error: 'You need at least 2 players.' };
    if (this.settings.customOnly && this.settings.customWords.length < 3) return { error: 'Add at least 3 custom words or turn off "custom words only".' };
    this.clearTimers();
    this.resetGame();
    this.gameId = crypto.randomUUID();
    this.system('🎨 The game has started!');
    this.nextTurn();
    return { ok: true };
  }

  playAgain(byId) {
    if (byId !== this.hostId || this.phase !== 'gameover') return;
    if (this.voting && !this.voting.done) this.finalizeVote();
    this.clearTimers();
    this.resetGame();
    this.phase = 'lobby';
    this.broadcastState();
  }

  endGameEarly() {
    this.system('Not enough players to continue.');
    if (this.turnsPlayed > 0) return this.finishGame();
    this.clearTimers();
    this.resetGame();
    this.phase = 'lobby';
    this.broadcastState();
  }

  // ---------- turn loop ----------
  nextTurn() {
    this.clearTimers();
    for (const p of this.players.values()) p.guessed = false;
    if (this.connected().length < 2) return this.endGameEarly();

    let drawerId = null;
    while (drawerId == null) {
      while (this.queue.length && drawerId == null) {
        const p = this.players.get(this.queue.shift());
        if (p && p.connected) drawerId = p.id; // disconnected players miss their turn
      }
      if (drawerId != null) break;
      this.round += 1;
      if (this.round > this.settings.rounds) return this.finishGame();
      this.queue = [...this.players.keys()];
    }

    const drawer = this.players.get(drawerId);
    this.drawerId = drawerId;
    this.turn = {
      id: ++this.turnSeq,
      choices: words.pickChoices(this.settings, this.usedWords),
      word: null,
      difficulty: null,
      revealed: new Set(),
      hints: 0,
      ops: [],
      opIndex: new Map(),
      points: 0,
      guessOrder: [],
      deltas: new Map(),
      reactions: new Map(),
      drawerName: drawer.name,
      drawerAvatar: drawer.avatar
    };
    this.phase = 'choosing';
    this.endsAt = Date.now() + CHOOSE_MS;
    this.later(CHOOSE_MS, () => this.chooseWord(drawerId, Math.floor(Math.random() * this.turn.choices.length)));
    this.broadcastState();
  }

  chooseWord(byId, index) {
    const t = this.turn;
    if (this.phase !== 'choosing' || byId !== this.drawerId || !Number.isInteger(index) || !t.choices[index]) return;
    this.clearTimers();
    t.word = t.choices[index].word;
    t.difficulty = t.choices[index].difficulty;
    this.usedWords.add(t.word);

    const ms = this.settings.drawTime * 1000;
    this.phase = 'drawing';
    this.endsAt = Date.now() + ms;
    this.later(ms, () => this.endTurn('time'));
    if (this.settings.hints) {
      this.later(ms * 0.5, () => this.revealHint());
      this.later(ms * 0.75, () => this.revealHint());
    }
    this.broadcastState();
  }

  revealHint() {
    const t = this.turn;
    const hidden = words.hiddenLetterIndices(t.word, t.revealed);
    if (this.phase !== 'drawing' || hidden.length <= 1) return; // never give the whole word away
    t.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
    t.hints += 1;
    this.emit('fx', { type: 'hint' });
    this.broadcastState();
  }

  checkAllGuessed() {
    if (this.phase !== 'drawing') return;
    const g = this.guessers();
    if (g.length && g.every((p) => p.guessed)) this.endTurn('all_guessed');
  }

  endTurn(reason) {
    const t = this.turn;
    if (this.phase === 'choosing') {
      // Drawer left before choosing: skip straight to the next turn.
      this.system(`${t.drawerName} left before picking a word.`);
      return this.nextTurn();
    }
    if (this.phase !== 'drawing') return;
    this.clearTimers();

    const drawer = this.players.get(this.drawerId);
    const guesserCount = [...this.players.values()].filter((p) => p.id !== this.drawerId && (p.connected || p.guessed)).length;
    if (drawer) {
      const pts = drawerPoints({ correct: t.guessOrder.length, guessers: guesserCount, difficulty: t.difficulty });
      drawer.score += pts;
      t.deltas.set(drawer.id, pts);
    }

    const likes = [...t.reactions.values()].filter((r) => r === 'up').length;
    if (t.ops.length) {
      this.drawings.push({
        turnId: t.id, word: t.word, drawerId: this.drawerId, drawerName: t.drawerName,
        drawerAvatar: t.drawerAvatar, ops: t.ops, likes
      });
    }
    // Crowd Favorite badge: at least 2 likes from 60%+ of guessers.
    if (drawer && likes >= Math.max(2, Math.ceil(guesserCount * 0.6))) {
      drawer.badges += 1;
      this.ranking.awardBadge(drawer.id, 'crowd_favorite', drawer.name, drawer.avatar);
      this.emit('fx', { type: 'badge', playerId: drawer.id, name: drawer.name });
    }

    this.turnsPlayed += 1;
    this.phase = 'reveal';
    this.endsAt = Date.now() + REVEAL_MS;
    this.broadcastState();
    this.emit('turn:reveal', {
      turnId: t.id,
      word: t.word,
      reason,
      drawerId: this.drawerId,
      drawerName: t.drawerName,
      deltas: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, delta: t.deltas.get(p.id) || 0 }))
    });
    this.later(REVEAL_MS, () => this.nextTurn());
  }

  finishGame() {
    this.clearTimers();
    const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
    let placement = 0;
    this.results = ranked.map((p, i) => {
      if (i === 0 || p.score < ranked[i - 1].score) placement = i + 1; // ties share a place
      return { id: p.id, name: p.name, avatar: p.avatar, score: p.score, placement };
    });
    if (this.results.length >= 2) {
      this.ranking.recordGame({
        gameId: this.gameId,
        players: this.results.map((r) => ({ playerId: r.id, name: r.name, avatar: r.avatar, score: r.score, placement: r.placement }))
      });
    }
    this.phase = 'gameover';
    this.drawerId = null;
    this.endsAt = null;
    this.voting = { endsAt: Date.now() + VOTE_MS, votes: new Map(), winnerTurnId: null, done: false };
    if (this.drawings.length) this.later(VOTE_MS, () => this.finalizeVote());
    else this.voting.done = true;
    this.broadcastState();
  }

  // ---------- in-turn actions ----------
  handleChat(p, raw) {
    const text = cleanChat(raw);
    if (!text) return;
    const isDrawer = p.id === this.drawerId;
    if (isDrawer && (this.phase === 'choosing' || this.phase === 'drawing')) {
      return p.socket?.emit('chat', { type: 'error', text: "You can't chat while it's your turn to draw." });
    }
    const msg = { type: 'msg', playerId: p.id, name: p.name, text: censor(text) };
    if (this.phase !== 'drawing') return this.emit('chat', msg);

    if (p.guessed) {
      // Secret channel: only correct guessers and the drawer see it.
      const secret = { ...msg, type: 'secret' };
      for (const q of this.players.values()) if ((q.guessed || q.id === this.drawerId) && q.socket) q.socket.emit('chat', secret);
      return;
    }
    const guess = words.normalize(text);
    const word = words.normalize(this.turn.word);
    if (guess === word) return this.correctGuess(p);
    this.emit('chat', msg);
    if (words.levenshtein(guess, word, 1) === 1) p.socket?.emit('chat', { type: 'close', text: `"${text}" is so close!` });
  }

  correctGuess(p) {
    const t = this.turn;
    const order = t.guessOrder.length;
    t.guessOrder.push(p.id);
    const pts = guesserPoints({
      remainingFrac: (this.endsAt - Date.now()) / (this.settings.drawTime * 1000),
      order,
      hints: t.hints,
      difficulty: t.difficulty
    });
    p.guessed = true;
    p.score += pts;
    t.deltas.set(p.id, pts);
    this.emit('fx', { type: 'guessed', playerId: p.id, name: p.name });
    this.broadcastState();
    this.checkAllGuessed();
  }

  handleDraw(p, raw) {
    if (this.phase !== 'drawing' || p.id !== this.drawerId) return;
    const op = sanitizeOp(raw);
    if (!op) return;
    const t = this.turn;
    if (op.type === 'stroke') {
      const n = op.points.length / 2;
      if (t.points + n > MAX_POINTS) return p.socket?.emit('chat', { type: 'error', text: 'The canvas is full. Undo or clear to keep drawing.' });
      const existing = t.opIndex.get(op.id);
      if (existing) {
        if (existing.type !== 'stroke') return;
        existing.points.push(...op.points); // continuation chunk of a stroke
      } else {
        if (t.ops.length >= MAX_OPS) return;
        const copy = { ...op, points: [...op.points] };
        t.ops.push(copy);
        t.opIndex.set(op.id, copy);
      }
      t.points += n;
    } else if (op.type === 'fill') {
      if (t.opIndex.has(op.id) || t.ops.length >= MAX_OPS) return;
      t.ops.push(op);
      t.opIndex.set(op.id, op);
    } else if (op.type === 'undo') {
      const i = t.ops.findIndex((o) => o.id === op.strokeId);
      if (i < 0) return;
      const [gone] = t.ops.splice(i, 1);
      t.opIndex.delete(gone.id);
      if (gone.type === 'stroke') t.points -= gone.points.length / 2;
    } else {
      t.ops = [];
      t.opIndex.clear();
      t.points = 0;
    }
    p.socket.to(this.channel).emit('draw', op);
  }

  handleReaction(p, kind) {
    if (this.phase !== 'drawing' || p.id === this.drawerId || (kind !== 'up' && kind !== 'down')) return;
    if (this.turn.reactions.get(p.id) === kind) return;
    this.turn.reactions.set(p.id, kind);
    this.emit('reaction', { kind, playerId: p.id });
  }

  handleKickVote(voter, targetId) {
    const target = this.players.get(targetId);
    if (!target || targetId === voter.id) return;
    if (this.players.size < 3) return voter.socket?.emit('chat', { type: 'error', text: 'Vote-kick needs at least 3 players.' });
    const votes = this.kickVotes.get(targetId) || new Set();
    if (votes.has(voter.id)) return;
    votes.add(voter.id);
    this.kickVotes.set(targetId, votes);
    const eligible = this.connected().filter((p) => p.id !== targetId).length;
    const needed = Math.floor(eligible / 2) + 1;
    this.system(`${voter.name} voted to kick ${target.name} (${votes.size}/${needed})`);
    if (votes.size >= needed) {
      this.banned.add(target.token);
      target.socket?.emit('kicked');
      this.remove(targetId, 'kicked');
    } else {
      this.broadcastState();
    }
  }

  handleVote(voter, turnId) {
    const v = this.voting;
    if (this.phase !== 'gameover' || !v || v.done) return;
    const d = this.drawings.find((x) => x.turnId === turnId);
    if (!d || d.drawerId === voter.id) return;
    v.votes.set(voter.id, turnId);
    this.broadcastState();
  }

  finalizeVote() {
    const v = this.voting;
    if (!v || v.done) return;
    v.done = true;
    const tally = (turnId) => [...v.votes.values()].filter((x) => x === turnId).length;
    const best = this.drawings
      .map((d) => ({ d, votes: tally(d.turnId) }))
      .sort((a, b) => b.votes - a.votes || b.d.likes - a.d.likes)[0];
    if (best && (best.votes > 0 || best.d.likes > 0)) {
      v.winnerTurnId = best.d.turnId;
      this.store.addGalleryEntry({
        word: best.d.word, artistId: best.d.drawerId, artistName: best.d.drawerName,
        artistAvatar: best.d.drawerAvatar, ops: best.d.ops, votes: best.votes, likes: best.d.likes
      });
      this.emit('fx', { type: 'bestDrawing', turnId: best.d.turnId, name: best.d.drawerName });
    }
    this.broadcastState();
  }

  drawingOps(turnId) {
    return this.drawings.find((d) => d.turnId === turnId)?.ops || null;
  }

  // ---------- state ----------
  /** Per-player snapshot. The word is only included for those allowed to see it. */
  snapshot(forId) {
    const me = this.players.get(forId);
    const t = this.turn;
    const isDrawer = forId === this.drawerId;
    const turnActive = this.inTurn && t;
    const canSeeWord = turnActive && t.word && (this.phase === 'reveal' || isDrawer || me?.guessed);
    const isHost = forId === this.hostId;
    const v = this.voting;
    return {
      code: this.code,
      isPublic: this.isPublic,
      you: forId,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      settings: {
        ...this.settings,
        customWords: isHost ? this.settings.customWords : [],
        customWordCount: this.settings.customWords.length
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, avatar: p.avatar, score: p.score, guessed: p.guessed,
        connected: p.connected, badges: p.badges, kickVotes: this.kickVotes.get(p.id)?.size || 0
      })),
      drawerId: turnActive ? this.drawerId : null,
      turnId: turnActive ? t.id : null,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      choices: this.phase === 'choosing' && isDrawer ? t.choices : null,
      word: canSeeWord ? t.word : null,
      mask: turnActive && t.word ? words.mask(t.word, t.revealed) : null,
      difficulty: turnActive ? t.difficulty : null,
      hints: turnActive ? t.hints : 0,
      myReaction: this.phase === 'drawing' ? t.reactions.get(forId) || null : null,
      gameover: this.phase === 'gameover' ? {
        gameId: this.gameId,
        results: this.results,
        drawings: this.drawings.map((d) => ({
          turnId: d.turnId, word: d.word, drawerId: d.drawerId, drawerName: d.drawerName, drawerAvatar: d.drawerAvatar,
          likes: d.likes, votes: [...v.votes.values()].filter((x) => x === d.turnId).length
        })),
        myVote: v.votes.get(forId) || null,
        voteEndsAt: v.done ? null : v.endsAt,
        winnerTurnId: v.winnerTurnId
      } : null
    };
  }

  broadcastState() {
    for (const p of this.players.values()) if (p.socket) p.socket.emit('state', this.snapshot(p.id));
  }
}

module.exports = { Room, GRACE_MS, CHOOSE_MS, REVEAL_MS, VOTE_MS };
