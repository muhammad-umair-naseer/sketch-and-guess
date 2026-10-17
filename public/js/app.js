'use strict';
/**
 * Sketch & Guess game client: home, lobby, game and game-over screens.
 * The server is authoritative; this file renders whatever 'state' snapshot
 * arrives and sends user intents back. All user text goes through textContent.
 */
(function () {
  const { CANVAS_W, CANVAS_H, PALETTE, ERASER, SIZES, AVATARS, AVATAR_COLORS } = window.Shared;
  const $ = (id) => document.getElementById(id);

  const CHOOSE_SECS = 10;
  const REVEAL_SECS = 5;
  const CHAT_CAP = 150;
  const POINTS_PER_CHUNK = 200;
  const MULTIPLIER = { easy: '1', medium: '1.2', hard: '1.5' };
  const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
  const REASONS = {
    time: "⏰ Time's up!",
    all_guessed: '🎉 Everyone guessed it!',
    drawer_left: '🚪 The drawer left.'
  };

  // ---------- small helpers ----------
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: keep going */ } }
  };

  /**
   * Tiny element builder. Strings/numbers become text nodes, so user data is
   * never parsed as HTML. on* keys become event listeners (CSP-safe).
   */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  function avatar(i, cls = '') {
    const n = Number.isInteger(i) && AVATARS[i] ? i : 0;
    return h('span', { class: `avatar ${cls}`, style: `background:${AVATAR_COLORS[n % AVATAR_COLORS.length]}` }, AVATARS[n]);
  }

  const play = (name) => { try { window.Sound.play(name); } catch { /* audio unavailable */ } };
  const confetti = (opts) => { try { window.Confetti.burst(opts); } catch { /* optional effect */ } };

  /** Random stroke/fill id matching /^[a-z0-9]{1,16}$/. */
  const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => (b % 36).toString(36)).join('');
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'drawing';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function toast(text, kind = '') {
    const el = h('div', { class: `toast ${kind}`, role: 'status' }, text);
    $('toasts').append(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 3200);
  }
  const ackToast = (res) => { if (res && res.error) toast(res.error, 'error'); };

  // Custom confirm dialog (window.confirm is ugly and blocks the socket loop).
  let modalDone = null;
  function confirmModal(text, okText = 'Yes') {
    if (modalDone) modalDone(false);
    return new Promise((resolve) => {
      $('modalText').textContent = text;
      $('modalOk').textContent = okText;
      $('modal').hidden = false;
      $('modalOk').focus();
      modalDone = (v) => { $('modal').hidden = true; modalDone = null; resolve(v); };
    });
  }
  $('modalOk').addEventListener('click', () => modalDone && modalDone(true));
  $('modalCancel').addEventListener('click', () => modalDone && modalDone(false));
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal') && modalDone) modalDone(false); });

  // ---------- theme + sound toggles ----------
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    const dark = currentTheme() === 'dark';
    document.querySelectorAll('.js-theme').forEach((b) => { b.textContent = dark ? '☀️' : '🌙'; });
  }
  function currentTheme() {
    return document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function syncMute() {
    let muted = false;
    try { muted = window.Sound.muted; } catch { /* no sound module */ }
    document.querySelectorAll('.js-mute').forEach((b) => { b.textContent = muted ? '🔇' : '🔊'; });
  }
  applyTheme(storage.get('sg_theme'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(storage.get('sg_theme')));
  syncMute();
  document.querySelectorAll('.js-theme').forEach((b) => b.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    storage.set('sg_theme', next);
    applyTheme(next);
  }));
  document.querySelectorAll('.js-mute').forEach((b) => b.addEventListener('click', () => {
    try { window.Sound.toggle(); } catch { /* no sound module */ }
    syncMute();
  }));

  // Browsers only allow audio after a user gesture.
  function unlockAudio() {
    try { window.Sound.unlock(); } catch { /* no sound module */ }
    document.removeEventListener('pointerdown', unlockAudio);
    document.removeEventListener('keydown', unlockAudio);
  }
  document.addEventListener('pointerdown', unlockAudio);
  document.addEventListener('keydown', unlockAudio);

  // ---------- client state ----------
  let S = null;              // latest server snapshot
  let myId = null;
  let memToken = storage.get('sg_token');
  let offset = 0;            // serverTime - clientTime
  let synced = false;
  let leaving = false;       // ignore late 'state' packets after leaving a room
  let lastStateAt = 0;
  let lastTurnId = null;
  let boardTurn = null;      // turn whose drawing the board currently holds
  let tickKey = null;
  let chooseKey = null;
  let knownIds = null;       // player ids seen last state (join sound)
  let prevScores = new Map();
  const flashUntil = new Map();
  const cache = new Map();   // turnId -> ops snapshot (for reveal replay, thumbnails, GIFs)
  let goFor = null;          // gameId the game-over overlay was built for
  let goWinnerShown = null;
  const goCards = new Map(); // turnId -> { card, btn, votesEl }

  const now = () => Date.now() + offset;
  const secsLeft = (endsAt) => (endsAt ? Math.max(0, Math.ceil((endsAt - now()) / 1000)) : 0);

  const board = new window.Canvas.Board($('board'));

  // ---------- socket ----------
  const socket = window.io({ auth: (cb) => cb({ token: storage.get('sg_token') || memToken }) });

  function syncClock() {
    const t0 = Date.now();
    socket.emit('ping', null, (serverNow) => {
      if (typeof serverNow !== 'number') return;
      offset = serverNow - (t0 + Date.now()) / 2;
      synced = true;
    });
  }

  socket.on('connect', () => { $('netBanner').hidden = true; syncClock(); });
  socket.on('disconnect', (reason) => { $('netBanner').hidden = reason === 'io client disconnect'; });

  socket.on('session', ({ token, playerId }) => {
    memToken = token;
    storage.set('sg_token', token);
    myId = playerId;
    loadMe();
    // The server resumes our seat right after 'session'. If no state follows,
    // the seat expired while we were offline: go back home.
    const at = Date.now();
    if (S) setTimeout(() => { if (S && lastStateAt < at) { toast('You were disconnected from the room.', 'error'); goHome(); } }, 2500);
  });

  socket.on('state', (s) => { if (!leaving) render(s); });
  socket.on('canvas:sync', ({ turnId, ops }) => {
    // A reconnecting drawer keeps its own board: it already holds strokes the server hasn't processed yet.
    if (canDraw() && turnId === boardTurn) return;
    boardTurn = turnId;
    board.load(Array.isArray(ops) ? ops : []);
  });
  socket.on('draw', (op) => board.apply(op));

  socket.on('chat', (m) => {
    const cls = `msg msg-${m.type}`;
    if (m.type === 'msg' || m.type === 'secret') addChat(h('div', { class: cls }, h('b', null, `${m.name}: `), m.text));
    else addChat(h('div', { class: cls }, m.text));
    if (m.type === 'close') play('close');
  });

  socket.on('fx', (fx) => {
    if (fx.type === 'guessed') {
      addChat(h('div', { class: 'msg msg-correct' }, `🎉 ${fx.name} guessed the word!`));
      play('correct');
      flashUntil.set(String(fx.playerId), Date.now() + 1500);
      const row = document.querySelector(`#playerList [data-id="${CSS.escape(String(fx.playerId))}"]`);
      if (row) row.classList.add('flash');
      if (fx.playerId === myId) confetti();
    } else if (fx.type === 'hint') {
      play('hint');
      addChat(h('div', { class: 'msg msg-system' }, '💡 A letter was revealed!'));
    } else if (fx.type === 'badge') {
      play('pop');
      addChat(h('div', { class: 'msg msg-correct' }, `🏅 ${fx.name} earned Crowd Favorite!`));
      toast(`🏅 ${fx.name} earned Crowd Favorite!`);
    } else if (fx.type === 'bestDrawing') {
      toast(`🏆 Best drawing: ${fx.name}!`);
    }
  });

  socket.on('turn:reveal', (r) => {
    const ops = board.snapshot();
    cache.set(r.turnId, ops);
    showReveal(r, ops);
  });

  socket.on('reaction', ({ kind }) => {
    floatEmoji(kind === 'up' ? '👍' : '👎');
    play('pop');
  });

  socket.on('kicked', () => { toast('You were vote-kicked from the room.', 'error'); goHome(); });
  socket.on('session:replaced', () => {
    socket.disconnect(); // otherwise a later auto-reconnect silently takes the seat back from the other tab
    toast('You opened the game in another tab.', 'error');
    goHome();
  });

  // ---------- screens ----------
  function showScreen(name) {
    for (const id of ['home', 'lobby', 'game']) {
      const el = $(id);
      const on = id === name;
      if (on && el.hidden) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); }
      el.hidden = !on;
    }
    document.body.dataset.screen = name;
  }

  /** Reset per-room client state when entering a different room (or leaving). */
  function resetRoomState() {
    $('chatLog').replaceChildren();
    cache.clear();
    fetchQ.length = 0;
    board.reset();
    boardTurn = null;
    prevScores = new Map();
    knownIds = null;
    lastTurnId = null;
    chooseKey = null;
    goFor = null;
    goWinnerShown = null;
    $('gameover').hidden = true;
    $('revealOverlay').hidden = true;
    $('chooseOverlay').hidden = true;
  }

  function goHome() {
    leaving = true;
    endStroke();
    S = null;
    resetRoomState();
    history.replaceState(null, '', '/');
    inviteCode = null;
    $('inviteBanner').hidden = true;
    showScreen('home');
    loadMe();
  }

  function leaveRoom() {
    socket.emit('room:leave', () => {});
    goHome();
  }

  function render(s) {
    const prev = S && S.code === s.code ? S : null;
    if (!prev) resetRoomState();
    S = s;
    myId = s.you;
    lastStateAt = Date.now();
    if (!synced && s.serverNow) offset = s.serverNow - Date.now();

    const path = `/room/${s.code}`;
    if (location.pathname !== path) history.replaceState(null, '', path);

    // Join sound: a new player id appeared in the lobby.
    const ids = s.players.map((p) => p.id);
    if (knownIds && s.phase === 'lobby' && ids.some((id) => id !== myId && !knownIds.has(id))) play('join');
    knownIds = new Set(ids);

    if (s.phase === 'lobby') {
      showScreen('lobby');
      renderLobby(s);
    } else {
      showScreen('game');
      renderGame(s, prev);
    }
    renderGameover(s);
    prevScores = new Map(s.players.map((p) => [p.id, p.score]));
    tick();
  }

  // ---------- home ----------
  let myAvatar = parseInt(storage.get('sg_avatar'), 10);
  if (!(myAvatar >= 0 && myAvatar < AVATARS.length)) myAvatar = Math.floor(Math.random() * AVATARS.length);

  const avatarGrid = $('avatarGrid');
  AVATARS.forEach((emoji, i) => {
    avatarGrid.append(h('button', {
      class: 'avatar-pick', type: 'button', role: 'radio', 'aria-label': `Avatar ${i + 1}`, 'data-i': i,
      style: `--av:${AVATAR_COLORS[i % AVATAR_COLORS.length]}`,
      onclick: () => { myAvatar = i; storage.set('sg_avatar', String(i)); syncAvatarGrid(); play('pop'); }
    }, emoji));
  });
  function syncAvatarGrid() {
    for (const b of avatarGrid.children) {
      const on = Number(b.dataset.i) === myAvatar;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  syncAvatarGrid();

  const nameInput = $('nameInput');
  nameInput.value = storage.get('sg_name') || '';
  nameInput.addEventListener('input', () => storage.set('sg_name', nameInput.value.trim()));

  function profile() {
    const name = nameInput.value.trim();
    if (!name) {
      toast('Pick a name first!', 'error');
      nameInput.focus();
      nameInput.classList.remove('shake'); void nameInput.offsetWidth; nameInput.classList.add('shake');
      return null;
    }
    storage.set('sg_name', name);
    return { name, avatar: myAvatar };
  }

  const homeButtons = ['quickBtn', 'createBtn', 'joinBtn', 'inviteJoinBtn'].map($);
  function enterVia(event, extra) {
    const p = profile();
    if (!p) return;
    leaving = false;
    if (!socket.connected) socket.connect(); // after session:replaced; the emit below is buffered
    homeButtons.forEach((b) => { b.disabled = true; });
    socket.emit(event, { ...p, ...extra }, (res) => {
      homeButtons.forEach((b) => { b.disabled = false; });
      if (res && res.error) { leaving = true; toast(res.error, 'error'); }
    });
  }
  $('quickBtn').addEventListener('click', () => enterVia('room:quick'));
  $('createBtn').addEventListener('click', () => enterVia('room:create'));
  $('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('codeInput').value.trim();
    if (!code) { toast('Type a room code to join.', 'error'); $('codeInput').focus(); return; }
    enterVia('room:join', { code });
  });

  // Invite link: /room/CODE shows a banner with a big Join button.
  let inviteCode = (location.pathname.match(/^\/room\/([A-Za-z0-9]{4,8})\/?$/) || [])[1];
  inviteCode = inviteCode ? inviteCode.toUpperCase() : null;
  if (inviteCode) {
    $('inviteCode').textContent = inviteCode;
    $('codeInput').value = inviteCode;
    $('inviteBanner').hidden = false;
  }
  $('inviteJoinBtn').addEventListener('click', () => enterVia('room:join', { code: inviteCode }));

  function loadMe() {
    if (!memToken) return;
    fetch('/api/me', { headers: { 'x-session-token': memToken } })
      .then((r) => (r.ok ? r.json() : null))
      .then(renderMe)
      .catch(() => {});
  }
  function renderMe(me) {
    const el = $('meStats');
    const st = me && me.stats;
    const stat = (icon, text) => h('span', { class: 'stat' }, h('span', { class: 'stat-icon' }, icon), text);
    if (!st) el.replaceChildren(stat('✨', 'Play a game to start your daily streak!'));
    else el.replaceChildren(stat('🔥', `${st.dailyStreak}-day streak`), stat('🏆', plural(st.wins, 'win')), stat('⭐', `${st.totalPoints} pts`));
  }

  // ---------- lobby ----------
  function fillSelect(el, values, label) {
    el.replaceChildren(...values.map((v) => h('option', { value: v }, label(v))));
  }
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  fillSelect($('setRounds'), range(Shared.MIN_ROUNDS, Shared.MAX_ROUNDS), (v) => plural(v, 'round'));
  fillSelect($('setDrawTime'), Shared.DRAW_TIMES, (v) => `${v} seconds`);
  fillSelect($('setMaxPlayers'), range(Shared.MIN_PLAYERS, Shared.MAX_PLAYERS), (v) => `${v} players`);

  const emitSettings = (partial) => socket.emit('room:settings', partial, ackToast);
  const isHost = () => S && S.hostId === myId;

  $('setRounds').addEventListener('change', (e) => emitSettings({ rounds: Number(e.target.value) }));
  $('setDrawTime').addEventListener('change', (e) => emitSettings({ drawTime: Number(e.target.value) }));
  $('setMaxPlayers').addEventListener('change', (e) => emitSettings({ maxPlayers: Number(e.target.value) }));
  $('setCustomOnly').addEventListener('change', (e) => emitSettings({ customOnly: e.target.checked }));
  $('setHints').addEventListener('change', (e) => emitSettings({ hints: e.target.checked }));

  // Custom words: debounce typing, flush on blur.
  let wordsTimer = null;
  const flushWords = () => {
    if (!wordsTimer) return;
    clearTimeout(wordsTimer);
    wordsTimer = null;
    emitSettings({ customWords: $('setCustomWords').value });
  };
  $('setCustomWords').addEventListener('input', () => {
    clearTimeout(wordsTimer);
    wordsTimer = setTimeout(flushWords, 600);
  });
  $('setCustomWords').addEventListener('blur', flushWords);

  const catRow = $('setCategories');
  for (const [key, label] of Object.entries(Shared.CATEGORIES)) {
    catRow.append(h('button', {
      class: 'chip-toggle', type: 'button', 'data-cat': key,
      onclick: (e) => {
        if (!isHost()) return;
        const cats = new Set(S.settings.categories);
        if (cats.has(key)) cats.delete(key); else cats.add(key);
        if (!cats.size) { toast('Keep at least one category.', 'error'); return; }
        e.currentTarget.classList.toggle('on', cats.has(key));
        emitSettings({ categories: [...cats] });
      }
    }, label));
  }

  /** Set a form control from server state unless the host is editing it right now. */
  function setControl(id, prop, value, enabled) {
    const el = $(id);
    el.disabled = !enabled;
    if (document.activeElement !== el) el[prop] = value;
  }

  function renderLobby(s) {
    const host = s.hostId === myId;
    const st = s.settings;
    $('lobbyCode').textContent = s.code;
    $('lobbyBadge').textContent = s.isPublic ? '🌍 Public room' : '🔒 Private room';
    $('lobbyCount').textContent = `${s.players.length} / ${st.maxPlayers}`;

    $('lobbyPlayers').replaceChildren(...s.players.map((p) => h('li', { class: `lobby-player${p.connected ? '' : ' offline'}` },
      avatar(p.avatar, 'lg'),
      h('span', { class: 'lobby-name' }, p.name),
      p.id === s.hostId ? h('span', { class: 'crown', title: 'Host' }, '👑') : null,
      p.id === myId ? h('span', { class: 'you-tag' }, 'you') : null)));

    setControl('setRounds', 'value', String(st.rounds), host);
    setControl('setDrawTime', 'value', String(st.drawTime), host);
    setControl('setMaxPlayers', 'value', String(st.maxPlayers), host);
    // Same floor as the server's sanitizeSettings, so the host can't pick a value that gets ignored.
    for (const o of $('setMaxPlayers').options) o.disabled = Number(o.value) < Math.max(Shared.MIN_PLAYERS, s.players.length);
    setControl('setCustomOnly', 'checked', st.customOnly, host);
    setControl('setHints', 'checked', st.hints, host);
    if (host && !wordsTimer) setControl('setCustomWords', 'value', (st.customWords || []).join(', '), true);
    $('customWrap').hidden = !host;
    $('customCount').textContent = plural(st.customWordCount, 'custom word');
    for (const chip of catRow.children) {
      chip.classList.toggle('on', st.categories.includes(chip.dataset.cat));
      chip.disabled = !host;
    }
    $('settingsNote').hidden = host;

    const online = s.players.filter((p) => p.connected).length;
    $('startBtn').hidden = !host;
    $('startBtn').disabled = online < 2;
    $('lobbyHint').textContent = !host
      ? '⏳ Waiting for the host to start the game...'
      : online < 2 ? '👋 Invite a friend: you need at least 2 players.' : '✨ Ready when you are!';
  }

  $('startBtn').addEventListener('click', () => { flushWords(); socket.emit('room:start', ackToast); });
  $('lobbyLeaveBtn').addEventListener('click', leaveRoom);
  $('copyLinkBtn').addEventListener('click', () => {
    if (!S) return;
    const link = `${location.origin}/room/${S.code}`;
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(link))
      .then(() => toast('🔗 Invite link copied!'))
      .catch(() => toast(`Share this link: ${link}`));
  });

  // ---------- game ----------
  function renderGame(s, prev) {
    const isDrawer = s.drawerId === myId;

    if (s.turnId !== lastTurnId) {
      if (s.phase === 'choosing') { board.reset(); boardTurn = s.turnId; }
      lastTurnId = s.turnId;
    }
    if (s.phase === 'drawing' && (!prev || prev.phase !== 'drawing' || prev.turnId !== s.turnId)) play('turn');
    if (s.phase !== 'reveal') $('revealOverlay').hidden = true;
    if (!(s.phase === 'drawing' && isDrawer)) endStroke();

    $('roundLabel').textContent = s.round ? `Round ${Math.min(s.round, s.settings.rounds)} of ${s.settings.rounds}` : '';
    renderWord(s);
    renderChoose(s);

    const drawingNow = s.phase === 'drawing';
    $('toolbar').hidden = !(drawingNow && isDrawer);
    $('boardWrap').classList.toggle('can-draw', drawingNow && isDrawer);
    $('reactBar').hidden = !(drawingNow && !isDrawer);
    $('reactUp').classList.toggle('on', s.myReaction === 'up');
    $('reactDown').classList.toggle('on', s.myReaction === 'down');

    renderChatInput(s);
    renderPlayers(s);
  }

  function diffChip(d) {
    return d ? h('span', { class: `chip diff diff-${d}` }, `${d} ×${MULTIPLIER[d] || 1}`) : null;
  }

  function renderWord(s) {
    const el = $('wordArea');
    el.replaceChildren();
    const isDrawer = s.drawerId === myId;
    if (s.phase === 'choosing') {
      el.append(h('span', { class: 'word-wait' }, isDrawer ? '✏️ Pick a word!' : '🤔 Get ready...'));
      return;
    }
    if (s.phase !== 'drawing' && s.phase !== 'reveal') return;
    if (s.word && isDrawer) { el.append(h('span', { class: 'word-text' }, s.word), diffChip(s.difficulty)); return; }
    if (s.word) { el.append(h('span', { class: 'word-text guessed' }, s.word)); return; }
    if (!s.mask) return;
    const boxes = h('span', { class: 'mask' });
    for (const c of s.mask) {
      if (c === ' ') boxes.append(h('span', { class: 'gap' }));
      else if (c === '-') boxes.append(h('span', { class: 'hyphen' }, '-'));
      else if (c === '_') boxes.append(h('span', { class: 'box' }));
      else boxes.append(h('span', { class: 'box shown' }, c));
    }
    const counts = s.mask.split(' ').map((w) => [...w.replace(/-/g, '')].length).join(', ');
    el.append(boxes, h('span', { class: 'counts' }, `(${counts})`));
  }

  function renderChoose(s) {
    const ov = $('chooseOverlay');
    if (s.phase !== 'choosing') { ov.hidden = true; chooseKey = null; return; }
    ov.hidden = false;
    const key = `${s.turnId}:${Boolean(s.choices)}`;
    if (key === chooseKey) return;
    chooseKey = key;
    const body = $('chooseBody');
    if (s.choices) {
      $('chooseTitle').textContent = '🎨 Choose a word to draw!';
      const buttons = s.choices.map((c, i) => h('button', {
        class: 'btn choice', type: 'button',
        onclick: () => {
          buttons.forEach((b) => { b.disabled = true; });
          socket.emit('turn:choose', i, ackToast);
        }
      }, h('span', { class: 'choice-word' }, c.word), diffChip(c.difficulty)));
      body.replaceChildren(...buttons);
    } else {
      const drawer = s.players.find((p) => p.id === s.drawerId);
      $('chooseTitle').replaceChildren(
        drawer ? avatar(drawer.avatar, 'lg bob') : '',
        h('div', null, `${drawer ? drawer.name : 'Someone'} is choosing a word...`));
      body.replaceChildren();
    }
  }

  function renderChatInput(s) {
    const inp = $('chatInput');
    const isDrawer = s.drawerId === myId;
    const me = s.players.find((p) => p.id === myId);
    const locked = isDrawer && (s.phase === 'choosing' || s.phase === 'drawing');
    inp.disabled = locked;
    $('chatSend').disabled = locked;
    inp.placeholder = locked ? "You're drawing!"
      : s.phase === 'drawing' && me && me.guessed ? 'Chat with players who guessed...'
        : s.phase === 'drawing' ? 'Type your guess here...' : 'Say something...';
  }

  function renderPlayers(s) {
    const sorted = [...s.players].sort((a, b) => b.score - a.score);
    const canKick = s.players.length >= 3;
    let rank = 0;
    const rows = sorted.map((p, i) => {
      if (i === 0 || p.score < sorted[i - 1].score) rank = i + 1;
      const flashing = (flashUntil.get(String(p.id)) || 0) > Date.now();
      const cls = ['player-row', p.connected ? '' : 'offline', p.id === myId ? 'me' : '',
        p.guessed ? 'guessed' : '', p.id === s.drawerId ? 'drawing' : '', flashing ? 'flash' : ''].join(' ');
      const row = h('li', { class: cls, 'data-id': p.id },
        h('span', { class: 'rank' }, `#${rank}`),
        avatar(p.avatar),
        h('div', { class: 'pinfo' },
          h('div', { class: 'pname' }, h('span', { class: 'pname-text' }, p.name), p.id === myId ? h('span', { class: 'you-tag' }, 'you') : null),
          // Status icons share the score line so long names keep the full row width.
          h('div', { class: 'pmeta' },
            h('span', { class: 'pscore' }, `${p.score} pts`),
            p.id === s.drawerId ? h('span', { title: 'Drawing' }, '✏️') : null,
            p.guessed ? h('span', { title: 'Guessed it' }, '✅') : null,
            p.id === s.hostId ? h('span', { title: 'Host' }, '👑') : null,
            p.badges ? h('span', { class: 'badge', title: 'Crowd Favorite badges' }, `🏅×${p.badges}`) : null)),
        canKick && p.id !== myId ? h('button', {
          class: 'kick-btn', type: 'button', title: `Vote to kick ${p.name}`, 'aria-label': `Vote to kick ${p.name}`,
          onclick: () => confirmModal(`Vote to kick ${p.name}?`, 'Vote kick').then((ok) => { if (ok) socket.emit('kick', p.id, ackToast); })
        }, p.kickVotes ? `🥾 ${p.kickVotes}` : '🥾') : null);
      const old = prevScores.get(p.id);
      if (old != null && p.score > old) scorePop(row, p.score - old);
      return row;
    });
    $('playerList').replaceChildren(...rows);
  }

  function scorePop(row, n) {
    const el = h('span', { class: 'score-pop' }, `+${n}`);
    row.append(el);
    setTimeout(() => el.remove(), 1600);
  }

  function floatEmoji(ch) {
    const el = h('span', { class: 'float-emoji', style: `left:${10 + Math.random() * 80}%` }, ch);
    $('fxLayer').append(el);
    setTimeout(() => el.remove(), 2200);
  }

  // ---------- chat ----------
  const chatLog = $('chatLog');
  function addChat(node) {
    const atBottom = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 60;
    chatLog.append(node);
    while (chatLog.children.length > CHAT_CAP) chatLog.firstChild.remove();
    if (atBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('chatInput');
    const text = inp.value.trim();
    if (!text || inp.disabled) return;
    socket.emit('chat', text, ackToast);
    inp.value = '';
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  // Mobile tabs: switch the panel under the canvas.
  for (const t of document.querySelectorAll('.tab')) {
    t.addEventListener('click', () => {
      $('game').dataset.tab = t.dataset.tab;
      syncTabs();
    });
  }
  function syncTabs() {
    for (const t of document.querySelectorAll('.tab')) {
      const on = t.dataset.tab === $('game').dataset.tab;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    }
  }
  syncTabs();

  // ---------- reactions ----------
  $('reactUp').addEventListener('click', () => socket.emit('react', 'up'));
  $('reactDown').addEventListener('click', () => socket.emit('react', 'down'));

  // ---------- leave ----------
  $('gameLeaveBtn').addEventListener('click', () =>
    confirmModal('Leave this game? Your score will be lost.', 'Leave').then((ok) => { if (ok) leaveRoom(); }));

  // ---------- drawing ----------
  const tool = { color: PALETTE[0], size: SIZES[1], mode: 'brush' };
  const paletteEl = $('palette');
  const sizesEl = $('sizes');
  for (const c of PALETTE) {
    paletteEl.append(h('button', {
      class: 'swatch', type: 'button', role: 'radio', title: c, 'aria-label': `Color ${c}`, 'data-color': c,
      style: `background:${c}`,
      onclick: () => { tool.color = c; if (tool.mode === 'eraser') tool.mode = 'brush'; syncTools(); }
    }));
  }
  for (const sz of SIZES) {
    const dot = Math.round(4 + sz * 0.5);
    sizesEl.append(h('button', {
      class: 'size-btn', type: 'button', role: 'radio', title: `Size ${sz}`, 'aria-label': `Brush size ${sz}`, 'data-size': sz,
      onclick: () => { tool.size = sz; if (tool.mode === 'fill') tool.mode = 'brush'; syncTools(); }
    }, h('span', { class: 'size-dot', style: `width:${dot}px;height:${dot}px` })));
  }
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.addEventListener('click', () => { tool.mode = b.dataset.tool; syncTools(); });
  }
  function syncTools() {
    for (const b of paletteEl.children) {
      const on = b.dataset.color === tool.color;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of sizesEl.children) {
      const on = Number(b.dataset.size) === tool.size;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
      b.firstChild.style.background = tool.mode === 'eraser' ? '#ffffff' : tool.color;
    }
    for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool.mode);
    $('boardWrap').dataset.tool = tool.mode;
  }
  syncTools();

  const canvas = $('board');
  const canDraw = () => Boolean(S && S.phase === 'drawing' && S.drawerId === myId);
  let stroke = null; // { id, color, size, pending:[x,y,...], pointerId, lx, ly }

  /** Pointer position normalized to 0..1 of the canvas box. */
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [round4(clamp01((e.clientX - r.left) / r.width)), round4(clamp01((e.clientY - r.top) / r.height))];
  }

  function sendOp(op) {
    board.apply(op);
    socket.emit('draw', op);
  }

  function addPoint(x, y) {
    // Apply locally right away (board appends to an existing stroke id).
    board.apply({ type: 'stroke', id: stroke.id, color: stroke.color, size: stroke.size, points: [x, y] });
    stroke.pending.push(x, y);
    stroke.lx = x;
    stroke.ly = y;
  }

  /** Send buffered points; the server appends chunks that share a stroke id. */
  function flush() {
    if (!stroke || !stroke.pending.length) return;
    const pts = stroke.pending;
    stroke.pending = [];
    for (let i = 0; i < pts.length; i += POINTS_PER_CHUNK * 2) {
      socket.emit('draw', { type: 'stroke', id: stroke.id, color: stroke.color, size: stroke.size, points: pts.slice(i, i + POINTS_PER_CHUNK * 2) });
    }
  }
  setInterval(flush, 40);

  function endStroke() {
    if (!stroke) return;
    flush();
    stroke = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw() || e.button > 0) return;
    e.preventDefault();
    endStroke();
    const [x, y] = pos(e);
    if (tool.mode === 'fill') {
      sendOp({ type: 'fill', id: rid(), x, y, color: tool.color });
      return;
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    stroke = { id: rid(), color: tool.mode === 'eraser' ? ERASER : tool.color, size: tool.size, pending: [], pointerId: e.pointerId, lx: x, ly: y };
    addPoint(x, y);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!stroke || e.pointerId !== stroke.pointerId) return;
    if (!canDraw()) { endStroke(); return; }
    const events = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = pos(ev);
      // Skip near-duplicate points (< ~1.5px on the 800x600 bitmap).
      if (Math.hypot((x - stroke.lx) * CANVAS_W, (y - stroke.ly) * CANVAS_H) < 1.5) continue;
      addPoint(x, y);
    }
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, (e) => { if (stroke && e.pointerId === stroke.pointerId) endStroke(); });
  }

  function undo() {
    if (!canDraw()) return;
    endStroke();
    const id = board.lastOpId();
    if (id) sendOp({ type: 'undo', strokeId: id });
  }
  $('undoBtn').addEventListener('click', undo);
  $('clearBtn').addEventListener('click', () => {
    if (!canDraw()) return;
    endStroke();
    sendOp({ type: 'clear' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalDone) { modalDone(false); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && canDraw() && !typing) {
      e.preventDefault();
      undo();
    }
  });

  // ---------- reveal ----------
  let revealData = null; // { word, ops }
  function showReveal(r, ops) {
    revealData = { word: r.word, ops };
    $('revealWord').textContent = r.word;
    $('revealReason').textContent = REASONS[r.reason] || '';
    const deltas = [...r.deltas].sort((a, b) => b.delta - a.delta);
    $('revealDeltas').replaceChildren(...deltas.map((d, i) => {
      const num = h('span', { class: `delta${d.delta > 0 ? ' plus' : ''}` }, d.delta > 0 ? '+0' : '0');
      if (d.delta > 0) setTimeout(() => countUp(num, d.delta), 150 + i * 90);
      return h('li', { class: 'delta-row', style: `animation-delay:${i * 90}ms` },
        avatar(d.avatar, 'sm'),
        h('span', { class: 'delta-name' }, d.name, d.id === r.drawerId ? ' ✏️' : ''),
        num);
    }));
    $('revealGifBtn').disabled = !ops.length;
    $('revealOverlay').hidden = false;
    try { window.Canvas.replay($('revealCanvas'), ops, 3500).catch(() => {}); } catch { /* replay optional */ }
  }

  function countUp(el, target) {
    const start = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - start) / 700);
      el.textContent = `+${Math.round(target * (1 - (1 - k) ** 3))}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function saveGif(btn, ops, word) {
    if (!ops || !ops.length) return;
    const label = btn.textContent;
    btn.disabled = true;
    window.Canvas.exportGif(ops, `sketch-${slug(word)}.gif`, (p) => {
      btn.textContent = `${Math.round(p <= 1 ? p * 100 : p)}%`;
    }).catch(() => toast('Could not make the GIF, sorry!', 'error'))
      .finally(() => { btn.disabled = false; btn.textContent = label; });
  }
  $('revealGifBtn').addEventListener('click', (e) => { if (revealData) saveGif(e.currentTarget, revealData.ops, revealData.word); });

  // ---------- game over ----------
  // drawing:get goes through the server's action rate limit, so fetch one at a time.
  const fetchQ = [];
  let fetching = false;
  function withOps(turnId, cb) {
    if (cache.has(turnId)) return cb(cache.get(turnId));
    fetchQ.push([turnId, cb]);
    pump();
  }
  function pump() {
    if (fetching || !fetchQ.length) return;
    fetching = true;
    const [turnId, cb] = fetchQ.shift();
    socket.emit('drawing:get', turnId, (ops) => {
      if (Array.isArray(ops)) { cache.set(turnId, ops); cb(ops); }
      else if (ops && ops.error) fetchQ.unshift([turnId, cb]); // rate limited: retry
      setTimeout(() => { fetching = false; pump(); }, 250);
    });
  }

  function buildGameover(g) {
    goCards.clear();
    const top = g.results.slice(0, 3);
    // Visual order 2nd, 1st, 3rd; 3rd rises first and 1st last.
    const delays = [900, 500, 100];
    $('podium').replaceChildren(...[1, 0, 2].filter((i) => top[i]).map((i) => {
      const r = top[i];
      return h('div', { class: `podium-spot spot-${i + 1}`, style: `--d:${delays[i]}ms` },
        avatar(r.avatar, 'xl'),
        h('div', { class: 'podium-name' }, r.name),
        h('div', { class: 'podium-score' }, `${r.score} pts`),
        h('div', { class: 'podium-block' }, MEDALS[r.placement] || `#${r.placement}`));
    }));

    $('scoreboard').replaceChildren(...g.results.map((r) => h('li', { class: `score-row${r.id === myId ? ' me' : ''}` },
      h('span', { class: 'rank' }, `#${r.placement}`),
      avatar(r.avatar, 'sm'),
      h('span', { class: 'score-name' }, r.name),
      h('span', { class: 'score-pts' }, `${r.score} pts`))));

    $('voteSection').hidden = !g.drawings.length;
    $('voteGrid').replaceChildren(...g.drawings.map((d) => {
      const thumb = h('canvas', { class: 'thumb', width: CANVAS_W, height: CANVAS_H });
      withOps(d.turnId, (ops) => { try { window.Canvas.renderOps(thumb, ops); } catch { /* engine missing */ } });
      const votesEl = h('span', { class: 'votes' });
      const btn = h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => socket.emit('vote', d.turnId, ackToast) }, 'Vote');
      const gifBtn = h('button', {
        class: 'btn btn-small btn-ghost', type: 'button', title: 'Save as GIF',
        onclick: (e) => { const b = e.currentTarget; withOps(d.turnId, (ops) => saveGif(b, ops, d.word)); }
      }, '💾 GIF');
      const card = h('div', { class: 'draw-card' },
        h('div', { class: 'winner-ribbon' }, '🏆 Best drawing'),
        thumb,
        h('div', { class: 'draw-word' }, d.word),
        h('div', { class: 'draw-artist' }, avatar(d.drawerAvatar, 'sm'), h('span', null, d.drawerName)),
        h('div', { class: 'draw-meta' }, h('span', null, `👍 ${d.likes}`), votesEl),
        h('div', { class: 'draw-actions' }, btn, gifBtn));
      goCards.set(d.turnId, { card, btn, votesEl });
      return card;
    }));
  }

  function renderGameover(s) {
    const ov = $('gameover');
    if (s.phase !== 'gameover' || !s.gameover) { ov.hidden = true; return; }
    const g = s.gameover;
    $('revealOverlay').hidden = true;
    if (goFor !== g.gameId) {
      goFor = g.gameId;
      goWinnerShown = null;
      buildGameover(g);
      ov.scrollTop = 0;
      play('podium');
      confetti();
    }
    ov.hidden = false;

    for (const d of g.drawings) {
      const c = goCards.get(d.turnId);
      if (!c) continue;
      const mine = d.drawerId === myId;
      const voted = g.myVote === d.turnId;
      c.votesEl.textContent = `🗳️ ${plural(d.votes, 'vote')}`;
      c.btn.disabled = mine || !g.voteEndsAt;
      c.btn.textContent = mine ? 'Yours' : voted ? '✓ Voted' : 'Vote';
      c.card.classList.toggle('voted', voted);
      c.card.classList.toggle('winner', g.winnerTurnId === d.turnId);
    }
    if (g.winnerTurnId && goWinnerShown !== g.winnerTurnId) {
      goWinnerShown = g.winnerTurnId;
      confetti();
    }
    $('againBtn').hidden = s.hostId !== myId;
    $('waitHost').hidden = s.hostId === myId;
  }

  $('againBtn').addEventListener('click', () => socket.emit('room:again', ackToast));
  $('goHomeBtn').addEventListener('click', leaveRoom);

  // ---------- clock-driven UI (timer ring, ticks, vote countdown) ----------
  const ring = $('timerRing');
  const RING_C = 2 * Math.PI * 19;
  ring.style.strokeDasharray = String(RING_C);

  function tick() {
    if (!S) return;
    const p = S.phase;
    if (p === 'choosing' || p === 'drawing' || p === 'reveal') {
      const total = p === 'drawing' ? S.settings.drawTime : p === 'choosing' ? CHOOSE_SECS : REVEAL_SECS;
      const left = Math.max(0, (S.endsAt - now()) / 1000);
      const secs = Math.ceil(left);
      $('timerText').textContent = String(secs);
      ring.style.strokeDashoffset = String(RING_C * (1 - Math.min(1, left / total)));
      $('timer').classList.toggle('urgent', p === 'drawing' && secs <= 10);
      if (p === 'choosing') $('chooseTimer').textContent = String(secs);
      const key = `${S.turnId}:${secs}`;
      if (p === 'drawing' && secs > 0 && secs <= 10 && key !== tickKey) { tickKey = key; play('tick'); }
    } else {
      $('timerText').textContent = '';
      ring.style.strokeDashoffset = '0';
      $('timer').classList.remove('urgent');
    }
    if (p === 'gameover' && S.gameover) {
      const g = S.gameover;
      $('voteTimer').textContent = g.voteEndsAt ? `⏳ ${secsLeft(g.voteEndsAt)}s` : 'Voting closed';
    }
  }
  setInterval(tick, 200);

  // Initial screen: home (a resumed seat will switch screens when 'state' arrives).
  showScreen('home');
  renderMe(null);
})();
