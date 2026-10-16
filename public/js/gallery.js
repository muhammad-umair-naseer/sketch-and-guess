'use strict';
/**
 * Gallery + leaderboard page (/gallery and /leaderboard serve the same file).
 * All user-supplied text goes through textContent, never innerHTML.
 */
(function () {
  const S = window.Shared;
  const $ = (id) => document.getElementById(id);
  const PAGE = 12;

  // ---------- small helpers ----------
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, value);
    } catch { /* storage blocked: behave as if empty */ }
    return null;
  }

  /** Create an element with optional class and text. */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function avatar(i) {
    const idx = Number.isInteger(i) && S.AVATARS[i] ? i : 0;
    const a = el('span', 'avatar', S.AVATARS[idx]);
    a.style.background = S.AVATAR_COLORS[idx % S.AVATAR_COLORS.length];
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtNum = (n) => Number(n || 0).toLocaleString();

  async function getJSON(url) {
    const token = store('sg_token');
    const res = await fetch(url, { headers: token ? { 'x-session-token': token } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------- theme ----------
  const saved = store('sg_theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  $('themeToggle').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    store('sg_theme', next);
  });

  // ---------- tabs ----------
  const TABS = {
    gallery: { path: '/gallery', title: 'Gallery · Sketch & Guess', loaded: false, load: () => loadGallery() },
    leaderboard: { path: '/leaderboard', title: 'Leaderboard · Sketch & Guess', loaded: false, load: () => { loadMe(); loadBoard(); } }
  };

  function showTab(name, push) {
    for (const key of Object.keys(TABS)) {
      const on = key === name;
      $(`tab-${key}`).setAttribute('aria-selected', String(on));
      $(`tab-${key}`).tabIndex = on ? 0 : -1;
      $(`panel-${key}`).hidden = !on;
    }
    const tab = TABS[name];
    document.title = tab.title;
    if (push) history.replaceState(null, '', tab.path);
    if (!tab.loaded) { tab.loaded = true; tab.load(); }
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab, true));
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const other = btn.dataset.tab === 'gallery' ? 'leaderboard' : 'gallery';
      showTab(other, true);
      $(`tab-${other}`).focus();
    });
  });

  // ---------- gallery ----------
  let lastId = null;
  let galleryBusy = false;
  const grid = $('galleryGrid');
  const moreBtn = $('loadMore');

  async function loadGallery() {
    if (galleryBusy) return;
    galleryBusy = true;
    moreBtn.disabled = true;
    moreBtn.textContent = 'Loading…';
    $('galleryError').hidden = true;
    try {
      const qs = `limit=${PAGE}` + (lastId != null ? `&before=${lastId}` : '');
      const items = await getJSON(`/api/gallery?${qs}`);
      items.forEach((item) => grid.appendChild(galleryCard(item)));
      if (items.length) lastId = items[items.length - 1].id;
      $('galleryEmpty').hidden = grid.children.length > 0;
      moreBtn.hidden = items.length < PAGE;
    } catch {
      const err = $('galleryError');
      err.textContent = 'Could not load the gallery. Check your connection and try again.';
      err.hidden = false;
      moreBtn.hidden = false;
    } finally {
      galleryBusy = false;
      moreBtn.disabled = false;
      moreBtn.textContent = 'Load more';
    }
  }
  moreBtn.addEventListener('click', loadGallery);

  function galleryCard(item) {
    const card = el('button', 'card art-card');
    card.type = 'button';
    card.setAttribute('aria-label', `Open drawing of ${item.word} by ${item.artistName}`);

    const thumb = el('span', 'thumb');
    const c = document.createElement('canvas');
    try { window.Canvas.renderOps(c, item.ops); } catch { /* broken ops: leave blank */ }
    thumb.appendChild(c);
    card.appendChild(thumb);

    const body = el('span', 'art-body');
    body.appendChild(el('span', 'art-word', item.word));
    const artist = el('span', 'artist');
    artist.append(avatar(item.artistAvatar), el('span', 'artist-name', item.artistName));
    body.appendChild(artist);
    const meta = el('span', 'art-meta');
    meta.append(
      el('span', 'pill', `🗳️ ${fmtNum(item.votes)}`),
      el('span', 'pill', `👍 ${fmtNum(item.likes)}`),
      el('span', 'art-date', fmtDate(item.createdAt))
    );
    body.appendChild(meta);
    card.appendChild(body);

    card.addEventListener('click', () => openViewer(item));
    return card;
  }

  // ---------- drawing viewer (modal) ----------
  const viewer = $('viewer');
  const viewerCanvas = $('viewerCanvas');
  const gifBtn = $('viewerGif');
  let current = null;

  function openViewer(item) {
    current = item;
    $('viewerWord').textContent = item.word;
    const meta = $('viewerMeta');
    meta.replaceChildren();
    const artist = el('span', 'artist');
    artist.append(avatar(item.artistAvatar), el('span', 'artist-name', `by ${item.artistName}`));
    meta.append(artist, el('span', 'pill', `🗳️ ${fmtNum(item.votes)}`), el('span', 'pill', `👍 ${fmtNum(item.likes)}`),
      el('span', 'art-date', fmtDate(item.createdAt)));
    gifBtn.disabled = false;
    gifBtn.textContent = '⬇ Save GIF';
    viewer.showModal();
    replay();
  }

  function replay() {
    if (current) window.Canvas.replay(viewerCanvas, current.ops).catch(() => {});
  }

  $('viewerReplay').addEventListener('click', replay);
  $('viewerClose').addEventListener('click', () => viewer.close());
  // Click on the backdrop (the dialog element itself, outside its content box) closes it.
  viewer.addEventListener('click', (e) => {
    if (e.target !== viewer) return;
    const r = viewer.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) viewer.close();
  });

  gifBtn.addEventListener('click', async () => {
    if (!current) return;
    const item = current;
    const slug = String(item.word).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drawing';
    gifBtn.disabled = true;
    gifBtn.textContent = 'Rendering…';
    try {
      await window.Canvas.exportGif(item.ops, `sketch-${slug}.gif`, (p) => {
        if (current === item) gifBtn.textContent = `Rendering ${Math.round(Math.min(Math.max(p, 0), 1) * 100)}%`;
      });
      if (current === item) gifBtn.textContent = '✓ Saved!';
    } catch {
      if (current === item) gifBtn.textContent = 'GIF failed, retry';
    } finally {
      if (current === item) gifBtn.disabled = false;
    }
  });

  // ---------- leaderboard ----------
  const BADGES = { crowd_favorite: ['🌟', 'Crowd Favorite'] };
  const MEDALS = ['🥇', '🥈', '🥉'];
  const SORT_COL = { points: 'points', wins: 'wins', best: 'best', streak: 'streak', daily: 'daily' };
  const board = { scope: 'global', sort: 'points', seq: 0 };
  let meId = null;
  let meReady = null; // promise resolving once /api/me has answered

  function badgeChips(badges) {
    const wrap = el('span', 'badges');
    for (const [key, count] of Object.entries(badges || {})) {
      const [icon, label] = BADGES[key] || ['🏅', key.replace(/_/g, ' ')];
      const b = el('span', 'badge', `${icon} ${label}${count > 1 ? ` ×${count}` : ''}`);
      b.title = label;
      wrap.appendChild(b);
    }
    return wrap;
  }

  function loadMe() {
    meReady = getJSON('/api/me').then((me) => {
      meId = me ? String(me.playerId) : null;
      renderMe(me);
    }).catch(() => renderMe(null));
    return meReady;
  }

  function stat(value, label) {
    const s = el('div', 'stat');
    s.append(el('div', 'stat-value', value), el('div', 'stat-label', label));
    return s;
  }

  function renderMe(me) {
    const box = $('myStats');
    box.replaceChildren();
    const s = me && me.stats;
    if (!s || !s.gamesPlayed) {
      box.classList.add('stats-empty');
      box.append(
        el('div', 'stats-hello', me ? `Hey ${me.name}! 👋` : 'Your stats live here 👋'),
        el('p', 'muted', 'Finish a game to start your streak and climb the board.')
      );
      const a = el('a', 'btn btn-play', 'Play now');
      a.href = '/';
      box.appendChild(a);
      return;
    }
    box.classList.remove('stats-empty');
    const head = el('div', 'stats-head');
    head.append(avatar(s.avatar), el('div', 'stats-name', s.name));
    const fire = el('div', 'streak');
    fire.append(el('span', 'streak-fire', '🔥'), el('span', 'streak-num', fmtNum(s.dailyStreak)),
      el('span', 'streak-label', 'day streak'));
    fire.title = `Best daily streak: ${s.bestDailyStreak}`;
    head.appendChild(fire);

    const grid = el('div', 'stats-grid');
    grid.append(
      stat(fmtNum(s.totalPoints), 'points'),
      stat(fmtNum(s.wins), s.wins === 1 ? 'win' : 'wins'),
      stat(fmtNum(s.gamesPlayed), 'games'),
      stat(fmtNum(s.bestGameScore), 'best game'),
      stat(fmtNum(s.bestWinStreak), 'best win streak'),
      stat(fmtNum(s.bestDailyStreak), 'best daily')
    );
    box.append(head, grid);
    if (Object.keys(s.badges || {}).length) box.appendChild(badgeChips(s.badges));
  }

  async function loadBoard() {
    const seq = ++board.seq; // ignore responses from superseded requests
    const body = $('boardBody');
    const empty = $('boardEmpty');
    body.classList.add('loading');
    try {
      const rows = await getJSON(`/api/leaderboard?scope=${board.scope}&sort=${board.sort}`);
      if (meReady) await meReady; // need meId to highlight our own row
      if (seq !== board.seq) return;
      renderBoard(rows);
      empty.hidden = rows.length > 0;
      empty.textContent = board.scope === 'local'
        ? 'Nobody here yet. Play a game with friends and they will show up!'
        : 'No finished games yet. Be the first on the board!';
    } catch {
      if (seq !== board.seq) return;
      body.replaceChildren();
      empty.textContent = 'Could not load the leaderboard. Try again in a moment.';
      empty.hidden = false;
    } finally {
      if (seq === board.seq) body.classList.remove('loading');
    }
  }

  function renderBoard(rows) {
    const body = $('boardBody');
    const sortCol = SORT_COL[board.sort];
    document.querySelectorAll('.board th[data-col]').forEach((th) => {
      th.classList.toggle('sorted', th.dataset.col === sortCol);
    });
    body.replaceChildren(...rows.map((r, i) => {
      const tr = el('tr');
      if (i < 3) tr.classList.add(`top${i + 1}`);
      if (meId != null && String(r.playerId) === meId) tr.classList.add('me');

      const rank = el('td', 'c-rank', i < 3 ? MEDALS[i] : i + 1);
      if (i < 3) rank.setAttribute('aria-label', `Rank ${i + 1}`);

      const name = el('td', 'c-name');
      const who = el('span', 'who');
      who.append(avatar(r.avatar), el('span', 'who-name', r.name));
      if (tr.classList.contains('me')) who.appendChild(el('span', 'you-tag', 'you'));
      if (r.badges && r.badges.crowd_favorite) {
        const star = el('span', 'mini-badge', '🌟');
        star.title = `Crowd Favorite ×${r.badges.crowd_favorite}`;
        who.appendChild(star);
      }
      name.appendChild(who);

      const cells = [
        ['points', fmtNum(r.totalPoints)],
        ['games', fmtNum(r.gamesPlayed)],
        ['wins', fmtNum(r.wins)],
        ['best', fmtNum(r.bestGameScore)],
        ['streak', fmtNum(r.bestWinStreak)],
        ['daily', r.dailyStreak ? `🔥 ${fmtNum(r.dailyStreak)}` : '0']
      ].map(([col, v]) => el('td', `num${col === 'games' ? ' c-games' : ''}${col === sortCol ? ' sorted' : ''}`, v));
      tr.append(rank, name, ...cells);
      return tr;
    }));
  }

  /** Toggle aria-pressed within a button group and report the chosen value. */
  function group(selector, attr, onPick) {
    const buttons = document.querySelectorAll(selector);
    buttons.forEach((btn) => btn.addEventListener('click', () => {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      onPick(btn.dataset[attr]);
    }));
  }
  group('.seg', 'scope', (v) => { board.scope = v; loadBoard(); });
  group('.chip', 'sort', (v) => { board.sort = v; loadBoard(); });

  // ---------- boot ----------
  showTab(location.pathname.startsWith('/leaderboard') ? 'leaderboard' : 'gallery', false);
})();
