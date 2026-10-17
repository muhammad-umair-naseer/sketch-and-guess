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
const bots = require('./bots');

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

// Quick Play timings (mutable so tests can shorten them).
const QUICK = {
  fillMs: 8_000,      // a solo human waits this long before bots join
  startMs: 10_000,    // 2+ humans: kickoff delay
  botStartMs: 3_000,  // kickoff delay once bots are seated
  nextGameMs: 12_000, // gameover (after voting) -> next game
  target: 4           // bots fill a solo human's room up to this many players
};

class Room {
  constructor({ code, isPublic, io, store, ranking, onEmpty }) {
    Object.assign(this, { code, isPublic, io, store, ranking, onEmpty });
    // Quick rooms (public) are run by the server: fixed settings, auto start, bots. Private rooms are run by the host.
    this.mode = isPublic ? 'quick' : 'private';
    this.botSeq = 0;
    this.auto = null; // pending quick-room kickoff: { kind: 'fill'|'start', at, timer }
    this.nextGameAt = null;
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
    this.drawn = new Set(); // drew this round; a leave + rejoin must not earn a second turn
    this.turnsPlayed = 0;
    this.results = null;
    this.voting = null;
    for (const p of this.players.values()) { p.score = 0; p.guessed = false; }
  }

  // ---------- helpers ----------
  get inTurn() { return this.phase === 'choosing' || this.phase === 'drawing' || this.phase === 'reveal'; }
  connected() { return [...this.players.values()].filter((p) => p.connected); }
  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  guessers() { return this.connected().filter((p) => p.id !== this.drawerId); }
  /** A game needs 2 connected players, at least one of them human: bots never play on their own. */
  canPlay() { const c = this.connected(); return c.length >= 2 && c.some((p) => !p.isBot); }
  emit(ev, data) { this.io.to(this.channel).emit(ev, data); }
  system(text) { this.emit('chat', { type: 'system', text }); }
  later(ms, fn) { const t = setTimeout(fn, ms); this.timers.push(t); return t; }
  clearTimers() { this.timers.forEach(clearTimeout); this.timers = []; this.auto = null; this.nextGameAt = null; }

  // ---------- membership ----------
  join(info, socket) {
    if (this.banned.has(info.token)) return { error: 'You were vote-kicked from this room.' };
    let p = this.players.get(info.id);
    if (!p) {
      if (this.players.size >= this.settings.maxPlayers) {
        const bot = this.mode === 'quick' && [...this.players.values()].find((q) => q.isBot);
        if (!bot) return { error: 'That room is full.' };
        this.remove(bot.id, 'left', `${bot.name} left to make room for ${info.name}`);
      }
      p = { id: info.id, token: info.token, name: info.name, avatar: info.avatar, score: 0, guessed: false, badges: 0 };
      this.players.set(p.id, p);
      if (this.hostId == null) this.hostId = p.id;
      // Joining mid-round: you get a turn this round too.
      if (this.inTurn && !this.drawn.has(p.id)) this.queue.push(p.id);
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
    this.autoStart();
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
    this.autoStart();
    this.broadcastState();
    if (this.phase === 'drawing') this.checkAllGuessed();
  }

  migrateHost() {
    const humans = this.humans();
    const next = humans.find((p) => p.connected) || humans[0];
    this.hostId = next ? next.id : null;
  }

  /** `text` overrides the default system message. */
  remove(playerId, reason, text) {
    const p = this.players.get(playerId);
    if (!p) return;
    clearTimeout(p.graceTimer);
    this.players.delete(playerId);
    if (p.socket) { p.socket.leave(this.channel); delete p.socket.data.roomCode; }
    this.queue = this.queue.filter((id) => id !== playerId);
    this.kickVotes.delete(playerId);
    for (const set of this.kickVotes.values()) set.delete(playerId);
    this.system(text || (reason === 'kicked' ? `${p.name} was vote-kicked` : `${p.name} left the room`));

    if (!this.humans().length) return this.destroy(); // bots never keep a room alive
    if (this.hostId === playerId) this.migrateHost();

    if (this.inTurn && !this.canPlay()) return this.endGameEarly();
    if (playerId === this.drawerId && (this.phase === 'choosing' || this.phase === 'drawing')) return this.endTurn('drawer_left');
    this.autoStart();
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
    if (this.mode === 'quick' || byId !== this.hostId || this.phase !== 'lobby') return;
    this.settings = sanitizeSettings(input, this.settings, this.players.size);
    this.broadcastState();
  }

  start(byId) {
    if (this.mode === 'quick') return { error: 'Quick Play games start automatically.' };
    if (byId !== this.hostId || (this.phase !== 'lobby' && this.phase !== 'gameover')) return { error: 'Only the host can start.' };
    if (this.connected().length < 2) return { error: 'You need at least 2 players.' };
    if (this.settings.customOnly && this.settings.customWords.length < 3) return { error: 'Add at least 3 custom words or turn off "custom words only".' };
    this.begin();
    return { ok: true };
  }

  begin() {
    this.clearTimers();
    this.resetGame();
    this.gameId = crypto.randomUUID();
    this.system('🎨 The game has started!');
    this.nextTurn();
  }

  playAgain(byId) {
    if (this.mode === 'quick' || byId !== this.hostId || this.phase !== 'gameover') return;
    if (this.voting && !this.voting.done) this.finalizeVote();
    this.toLobby();
  }

  endGameEarly() {
    this.system('Not enough players to continue.');
    if (this.turnsPlayed > 0) return this.finishGame();
    this.toLobby();
  }

  toLobby() {
    this.clearTimers();
    this.resetGame();
    this.phase = 'lobby';
    this.autoStart();
    this.broadcastState();
  }

  // ---------- quick play ----------
  /**
   * Quick rooms start themselves: 2+ connected humans kick off after startMs (scheduled once,
   * never pushed back). A solo human gets bots after fillMs, then kickoff after botStartMs.
   */
  autoStart() {
    if (this.mode !== 'quick' || this.phase !== 'lobby') return;
    const humans = this.connected().filter((p) => !p.isBot).length;
    if (this.auto && (humans === 0 || (this.auto.kind === 'start' && !this.canPlay()))) this.cancelAuto();
    if (humans >= 2) {
      if (this.auto?.kind !== 'start') this.scheduleAuto('start', QUICK.startMs);
    } else if (humans === 1 && !this.auto) {
      if (this.players.size > 1 && [...this.players.values()].some((p) => p.isBot)) {
        this.addBots();
        this.scheduleAuto('start', QUICK.botStartMs);
      } else {
        this.scheduleAuto('fill', QUICK.fillMs);
      }
    }
  }

  scheduleAuto(kind, ms) {
    this.cancelAuto();
    const timer = this.later(ms, () => {
      this.auto = null;
      if (kind === 'start' && this.canPlay()) return this.begin();
      if (kind === 'fill') this.addBots();
      this.autoStart();
      this.broadcastState();
    });
    this.auto = { kind, at: Date.now() + ms, timer };
  }

  cancelAuto() {
    if (this.auto) clearTimeout(this.auto.timer);
    this.auto = null;
  }

  addBots() {
    const names = new Set([...this.players.values()].map((p) => p.name));
    while (this.players.size < Math.min(QUICK.target, this.settings.maxPlayers)) {
      const bot = bots.createBot(-(++this.botSeq), names);
      names.add(bot.name);
      this.players.set(bot.id, bot);
      this.system(`🤖 ${bot.name} joined the room`);
    }
  }

  /** After the Best Drawing vote, a quick room rolls into the next game with everyone still seated. */
  scheduleNextGame() {
    if (this.mode !== 'quick') return;
    this.later(QUICK.nextGameMs, () => this.toLobby());
    this.nextGameAt = Date.now() + QUICK.nextGameMs;
  }

  // ---------- turn loop ----------
  nextTurn() {
    this.clearTimers();
    for (const p of this.players.values()) p.guessed = false;
    if (!this.canPlay()) return this.endGameEarly();

    let drawerId = null;
    while (drawerId == null) {
      while (this.queue.length && drawerId == null) {
        const p = this.players.get(this.queue.shift());
        if (p && p.connected) drawerId = p.id; // disconnected players miss their turn
      }
      if (drawerId != null) break;
      this.round += 1;
      if (this.round > this.settings.rounds) return this.finishGame();
      this.queue = this.humans().map((p) => p.id); // bots never draw
      this.drawn.clear();
    }

    const drawer = this.players.get(drawerId);
    this.drawerId = drawerId;
    this.drawn.add(drawerId);
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
    this.turn.choices.forEach((c) => this.usedWords.add(c.word)); // offered once per game, picked or not
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

    const ms = this.settings.drawTime * 1000;
    this.phase = 'drawing';
    this.endsAt = Date.now() + ms;
    this.later(ms, () => this.endTurn('time'));
    if (this.settings.hints) {
      this.later(ms * 0.5, () => this.revealHint());
      this.later(ms * 0.75, () => this.revealHint());
    }
    bots.planTurn(this);
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
      // Correct guessers who left since still count, so "everyone guessed" compares the same people.
      const gone = t.guessOrder.filter((id) => !this.players.has(id)).length;
      const pts = drawerPoints({ correct: t.guessOrder.length, guessers: guesserCount + gone, difficulty: t.difficulty });
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
    // Crowd Favorite badge: at least 2 likes from 60%+ of guessers, humans only (bot likes can't farm badges).
    const humanLikes = [...t.reactions].filter(([id, r]) => r === 'up' && !this.players.get(id)?.isBot).length;
    const humanGuessers = [...this.players.values()].filter((p) => !p.isBot && p.id !== this.drawerId && (p.connected || p.guessed)).length;
    if (drawer && humanLikes >= Math.max(2, Math.ceil(humanGuessers * 0.6))) {
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
      deltas: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, isBot: !!p.isBot, delta: t.deltas.get(p.id) || 0 }))
    });
    this.later(REVEAL_MS, () => this.nextTurn());
  }

  finishGame() {
    this.clearTimers();
    const ranked = [...this.players.values()].sort((a, b) => b.score - a.score);
    let placement = 0;
    this.results = ranked.map((p, i) => {
      if (i === 0 || p.score < ranked[i - 1].score) placement = i + 1; // ties share a place
      return { id: p.id, name: p.name, avatar: p.avatar, isBot: !!p.isBot, score: p.score, placement };
    });
    // Only humans are ranked, and only games with 2+ humans count (no farming points off bots).
    const humans = this.results.filter((r) => !r.isBot);
    if (humans.length >= 2) {
      let pl = 0; // re-ranked among humans, so a bot on top doesn't cost the best human the win
      this.ranking.recordGame({
        gameId: this.gameId,
        players: humans.map((r, i) => {
          if (i === 0 || r.score < humans[i - 1].score) pl = i + 1;
          return { playerId: r.id, name: r.name, avatar: r.avatar, score: r.score, placement: pl };
        })
      });
    }
    this.phase = 'gameover';
    this.drawerId = null;
    this.endsAt = null;
    this.voting = { endsAt: Date.now() + VOTE_MS, votes: new Map(), winnerTurnId: null, done: false };
    if (this.drawings.length) this.later(VOTE_MS, () => this.finalizeVote());
    else { this.voting.done = true; this.scheduleNextGame(); }
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
    if (!target || targetId === voter.id || voter.isBot) return;
    if (target.isBot) return this.remove(targetId, 'kicked', `${voter.name} removed ${target.name}`); // no vote, no ban
    const humans = this.humans().length; // majorities count humans only
    if (humans < 3) return voter.socket?.emit('chat', { type: 'error', text: 'Vote-kick needs at least 3 players.' });
    const votes = this.kickVotes.get(targetId) || new Set();
    if (votes.has(voter.id)) return;
    votes.add(voter.id);
    this.kickVotes.set(targetId, votes);
    const eligible = humans - 1; // all human seats, so a reconnecting player can't shrink the majority
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
    this.scheduleNextGame();
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
      mode: this.mode,
      autoStartAt: this.phase === 'lobby' ? this.auto?.at ?? null : null,
      nextGameAt: this.phase === 'gameover' ? this.nextGameAt : null,
      you: forId,
      hostId: this.hostId,
      phase: this.phase,
      round: this.round,
      settings: {
        ...this.settings,
        customWords: isHost && this.phase === 'lobby' ? this.settings.customWords : [], // a migrated host mid-game is a guesser
        customWordCount: this.settings.customWords.length
      },
      players: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, avatar: p.avatar, isBot: !!p.isBot, score: p.score, guessed: p.guessed,
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

module.exports = { Room, QUICK, GRACE_MS, CHOOSE_MS, REVEAL_MS, VOTE_MS };
