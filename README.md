# Sketch & Guess

A multiplayer drawing-and-guessing game for the browser, in the style of Skribbl. Each turn one player picks a secret word and draws it. Everyone else races to type the word into the chat. Guess faster and you score more, and the drawer scores for every player who gets it.

The server is Node + Express 5 + Socket.IO 4 with SQLite (better-sqlite3). The client is plain HTML, CSS and JavaScript on a `<canvas>`, with no framework and no build step.

## Features

- **Two game modes:** Quick Play matches you with strangers and fills empty seats with bots; a private room is for friends with a code and your own rules. See [Game modes](#game-modes).
- **Lobby settings (private rooms, host only):** 2 to 6 rounds, 60/80/100/120 second draw time, 2 to 12 players, word categories (Tech, Everyday, Food, Animals, Roman Urdu), custom words with a "custom words only" option, and hints on or off.
- **Choosing a word:** the drawer gets 3 choices (easy, medium, hard) and has 10 seconds to pick, after which one is picked at random. A word is not offered twice in the same game while unused words remain.
- **Drawing tools:** 20-colour palette, 4 brush sizes, eraser, flood fill, undo (also Ctrl/Cmd+Z) and clear. Strokes are smoothed.
- **Guessing:** guesses are not case-sensitive. A guess one letter away gets a private "so close!" message. Players who have guessed chat in a secret channel that only other correct guessers and the drawer can see.
- **Hints:** letters are revealed at 50% and 75% of the draw time. The last hidden letter is never revealed.
- **Reactions and badges:** guessers can give the drawing a thumbs up or down. A well-liked drawing earns the drawer a Crowd Favorite badge.
- **Vote-kick:** in rooms with 3 or more human players, a player is kicked once a majority of the other humans in the room vote for it. A kicked player can't rejoin that room. A bot is removed with a single vote.
- **Game over:** podium, confetti, final scores, and a 25-second vote for the Best Drawing of the game. The winner is saved to the public gallery.
- **Gallery and leaderboard** (`/gallery`, `/leaderboard`): timelapse replays of past winners with GIF export, a global or "played with me" leaderboard with five ways to sort, and your own stats.
- **Polish:** sounds synthesised with WebAudio (no audio files, with a mute toggle), light and dark themes, and a layout that works on phones.
- **Reconnects:** reloading or briefly losing the connection puts you back in your seat.

## Requirements

- **Node.js 20.12 or newer.** The server uses `process.loadEnvFile()` to read `.env`.
- **better-sqlite3** is a native module. `npm install` normally downloads a prebuilt binary. If there is none for your platform or Node version, it compiles from source, which needs Python 3, `make` and a C++ compiler:
  - macOS: `xcode-select --install`
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Windows: Visual Studio Build Tools with the "Desktop development with C++" workload

## Setup and running

```bash
npm install
cp .env.example .env     # optional: every variable has a default
npm start                # http://localhost:3000
```

Open http://localhost:3000 in two browser windows (or on two devices) to play. A game needs at least 2 players.

| Command | What it does |
| --- | --- |
| `npm start` | Runs the server (`node server/index.js`). |
| `npm run dev` | Runs the server and restarts it when server files change (`node --watch`). Changes under `public/` only need a browser reload. |
| `npm test` | Runs the unit and integration tests with the built-in `node --test` runner. |

### Environment variables

`.env` is read from the directory you start the server in. Variables already set in the environment take precedence.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port. |
| `DB_PATH` | `./data/sketch.db` | SQLite database file. The file and its folder are created if missing. A relative path is resolved from the current working directory. |
| `TRUST_PROXY` | not set | When set, it is passed to Express's `trust proxy` setting (for example `1`, `loopback`, or a subnet). Use it only behind a reverse proxy. |

## Project structure

```
.
├── package.json            scripts (start, dev, test), Node engine, dependencies
├── .env.example            sample configuration
├── server/
│   ├── index.js            Express app, security headers, HTTP API, Socket.IO handlers, room registry
│   ├── game.js             Room class: lobby, Quick Play auto start, turn loop, timers, guessing, scoring, vote-kick, best-drawing vote, per-player state
│   ├── bots.js             Quick Play bots: names, skill, scheduled guesses and reactions
│   ├── scoring.js          points for guessers and drawers
│   ├── words.js            word picking, masks, guess normalisation, Levenshtein, custom word parsing
│   ├── words.json          word bank by category and difficulty
│   ├── validate.js         payload sanitising (drawing ops, names, chat, settings) and per-socket rate limiters
│   ├── profanity.js        word-list profanity filter (English and Roman Urdu) with leetspeak folding
│   ├── db.js               SQLite setup, player identities and the gallery table
│   └── ranking.js          self-contained ranking module: leaderboards, streaks, badges
├── public/
│   ├── index.html          game page: home, lobby, game and game-over screens
│   ├── gallery.html        gallery and leaderboard page
│   ├── favicon.svg         site icon
│   ├── css/style.css       styles for the game page
│   ├── css/gallery.css     styles for the gallery and leaderboard page
│   ├── js/shared.js        constants shared by server and client (palette, sizes, avatars, limits, categories)
│   ├── js/app.js           game client: socket protocol, screens, drawing input, chat, timers
│   ├── js/canvas.js        canvas engine: stroke and fill rendering, undo, timelapse replay, GIF export
│   ├── js/sound.js         WebAudio sound effects and the mute setting
│   ├── js/confetti.js      confetti animation
│   └── js/gallery.js       gallery grid, replay dialog, leaderboard tables
└── test/
    ├── unit.test.js        scoring, words, profanity, validation and ranking tests
    └── game.test.js        integration tests: a real server driven by socket.io-client players
```

`data/` (the database) and `node_modules/` are created at runtime and ignored by git.

## Game modes

| | Quick Play | Private room |
| --- | --- | --- |
| Who joins | anyone pressing **Quick Play**: you join the first open public room, or a new one is made | people with the code or invite link |
| Settings | fixed: 3 rounds, 80 s, up to 8 players, Everyday/Food/Animals, hints on | chosen by the host |
| Starting | automatic. With 2+ humans the game starts 10 s later. Alone, you wait 8 s, then bots fill the room to 4 players and the game starts 3 s after that | the host presses **Start** |
| After the game | 12 s after the Best Drawing vote closes, everyone (bots too) goes back to the lobby and the next game starts automatically | the host presses **Play Again** |
| Bots | yes, to fill empty seats | never |

Bots in Quick Play:

- They never draw, so a round is one turn per human. They only guess: each bot has a skill level, easy words and revealed hints make it more likely to get the word, and it may type a few unrelated wrong guesses first. Their guesses go through the same chat checks and scoring as everyone else's, and they can give a thumbs up.
- A human joining a full quick room takes a bot's seat. When the last human leaves, the bots go too and the room is closed.
- Bots are never saved to the database or the leaderboard. A quick game is ranked only if at least 2 humans finished it.
- The timings live in the exported `QUICK` object in `server/game.js` (the tests shorten them).

## How to play

1. Enter a name, pick an avatar, then choose **Quick Play**, **Create Room** or **Join** with a code.
2. In a private room, the host adjusts the settings and presses **Start** once at least 2 players are in. A Quick Play game starts by itself.
3. Every player draws once per round. When it's your turn, pick one of the three words within 10 seconds.
4. If you're drawing: draw the word. No letters or numbers! Chat is off for the drawer during the turn.
5. If you're guessing: type guesses into the chat. A correct guess is never shown to the others. They only see that you got it.
6. A turn ends when time runs out, when everyone has guessed, or when the drawer leaves. The word and everyone's points are then shown for 5 seconds.
7. After the last round, vote for the best drawing (you can't vote for your own). In a private room the host can then take everyone back to the lobby for another game. A quick room moves on to the next game by itself.

## Scoring

All points are calculated on the server. Clients never send scores.

| Who | Points |
| --- | --- |
| Guesser | `round((100 × max(0, 1 − 0.15 × hints) × timeLeftFraction + orderBonus) × multiplier)` |
| Order bonus | 1st correct guess +50, 2nd +30, 3rd +15, everyone after +5 |
| Hint penalty | each letter already revealed cuts the time-based maximum by 15% (it never drops below 0) |
| Drawer | `round((25 × correctGuessers + 50 if everyone guessed) × multiplier)`; 0 if nobody guessed |
| Difficulty multiplier | easy ×1, medium ×1.2, hard ×1.5 |
| Custom word difficulty | set by letter count: up to 5 easy, 6 to 8 medium, 9 or more hard |
| Final placement | highest score wins; tied scores share a place |
| Crowd Favorite badge | the drawer gets at least 2 thumbs up, and at least 60% of the guessers gave one |
| Best Drawing | most votes wins, likes break ties. It is saved to the gallery only if it got at least one vote or like. |

## Networking and anti-cheat design

- **Strokes, not pixels.** The drawer sends small operations: `stroke` (a colour, a size and a list of points), `fill`, `undo` and `clear`. Stroke points are batched and sent every 40 ms, with up to 200 points per chunk. Later chunks with the same stroke id add points to that stroke. Each client renders the operations itself.
- **Normalised coordinates.** Points are fractions from 0 to 1 and every client draws on a fixed 800×600 bitmap that CSS scales to fit. Drawings look the same at any screen size, and flood fill produces the same pixels on every client.
- **Everything is validated.** Every operation passes `sanitizeOp`: ids must match `/^[a-z0-9]{1,16}$/i`, colours must come from the palette, sizes from the size list, coordinates must be finite numbers from 0 to 1, and a chunk holds at most 200 points. Only the current drawer's operations are accepted, and only during the drawing phase. Each turn is capped at 3,000 operations and 60,000 points. The Socket.IO payload limit is 64 KB.
- **The server owns the timers.** The server decides turn order, when each phase ends, when hints appear and how many points a guess earns. Clients only display the countdown. They use the server's `endsAt` timestamp, adjusted by a clock offset measured with a `ping` round trip.
- **The word stays on the server.** Each player gets their own state snapshot. The word is included only for the drawer, for players who have already guessed it, and for everyone during the reveal. Guessers get a mask such as `___ _-__`. The three word choices go only to the drawer. Correct guesses are never broadcast, and after guessing, a player's chat goes only to other correct guessers and the drawer. The integration test checks that the word never reaches a guesser before they guess it.
- **Reconnect tokens.** On first connect the server issues a random 128-bit session token, which the browser keeps in `localStorage` (`sg_token`). A dropped socket keeps its seat for a 30-second grace period, and reconnecting with the same token resumes it, including the current canvas. Opening the game in a new tab moves the seat to that tab and cuts off the old one. A disconnected host passes host duties to the next connected player, and disconnected players skip their turn to draw.
- **Rate limits.** Each socket has token buckets per type of event: chat allows a burst of 5 and refills at 1.5 per second, drawing 80 and 40 per second, reactions 4 and 1 per second, and other actions 15 and 5 per second. Any event over its limit is dropped, and the sender gets "Slow down a little!" when the event expects a reply.
- **Profanity filter.** A word-list filter for English and Roman Urdu folds leetspeak and repeated letters and matches whole words, so harmless words like "class" or "Scunthorpe" pass. Unacceptable names are rejected, bad words in chat are replaced with asterisks, and offensive custom words are dropped.
- **Browser hardening.** The server sends a strict Content-Security-Policy (`script-src 'self'`, so there are no inline scripts or `on*` handlers), along with `nosniff` and `same-origin` referrer headers. All user text is inserted with `textContent`.

## HTTP API

| Route | Returns |
| --- | --- |
| `GET /api/gallery?before=<id>&limit=<1-48>` | Best Drawing winners, newest first, with their drawing operations |
| `GET /api/leaderboard?scope=global\|local&sort=points\|wins\|best\|streak\|daily` | Up to 50 rows. `local` needs the `x-session-token` header. |
| `GET /api/me` | `{ playerId, name, stats }` for the `x-session-token` header, or `null` |
| `GET /health` | `{ ok: true, rooms }` |

## Ranking module

`server/ranking.js` has no dependencies on the rest of the game. The interface below is copied from its header:

```js
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
```

How it behaves:

- `awardBadge` also takes optional `name` and `avatar` arguments: `awardBadge(playerId, badge, name, avatar)`. They are used to create the stats row if the player doesn't have one yet.
- `recordGame` runs in a single transaction and can safely be called twice for the same game. The per-game rows are keyed on `(game_id, player_id)` and repeats are ignored. The game only calls it when a game ends with at least 2 human players, and never includes bots.
- `limit` defaults to 50 and is clamped to 1 to 100. A daily streak whose last game was before yesterday (UTC) is reported as 0.
- Rows come back in camelCase: `playerId, name, avatar, totalPoints, gamesPlayed, wins, bestGameScore, winStreak, bestWinStreak, dailyStreak, bestDailyStreak, lastPlayDay, badges`.

### Merging it into another site

1. Copy `server/ranking.js` into the other project. Its only requirement is a better-sqlite3 `Database` instance.
2. Call `createRanking(db)` with that site's database, or with a separate one. It creates its tables (`rank_stats`, `rank_games` and an index) with `CREATE TABLE IF NOT EXISTS`, so it can share a database file with other tables without conflict.
3. Use the site's own user ids as `playerId`. They are stored as text, so numeric ids and UUIDs both work. In this game `playerId` is the `players.id` row tied to a browser's session token. If you want to bring existing stats over, map each old `players.id` to the site's user id and update `player_id` in both `rank_` tables.
4. When another game finishes, call `recordGame` with a unique `gameId` and each player's score and placement (1 = winner, ties allowed). The other site's games then add to the same leaderboards and streaks.
5. Show results with `getLeaderboard` and `getPlayerStats`. The existing `/api/leaderboard` and `/api/me` routes in `server/index.js` show how to wire them to HTTP.

## Deployment

- **One process.** Rooms and timers live in memory in a single Node process, so run one instance. Running several would need sticky sessions plus a shared Socket.IO adapter and room store, and this code has neither. Restarting the process ends all games in progress. Players, the gallery and rankings are kept in SQLite.
- **Reverse proxy with WebSockets.** Put nginx, Caddy or a similar server in front for TLS, and make sure it forwards WebSocket upgrades. For nginx:

  ```nginx
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
  ```

  Caddy forwards WebSockets automatically: `reverse_proxy 127.0.0.1:3000`.
- **`TRUST_PROXY`.** Set it to the number of proxy hops (usually `1`), or to the proxy's address, so Express takes the client IP and protocol from the `X-Forwarded-*` headers. Leave it unset when Node faces the internet directly, because otherwise clients could fake those headers.
- **Persistent `DB_PATH`.** Point `DB_PATH` at a persistent disk or volume, for example `DB_PATH=/data/sketch.db` with `/data` mounted as a volume in Docker, Fly.io or Railway. SQLite runs in WAL mode, so keep the `-wal` and `-shm` files next to the database. Back up with `sqlite3 sketch.db ".backup backup.db"` rather than copying the file while the server is running.
- **Health check:** `GET /health`.
- **Process manager:** run `npm start` under systemd, pm2 or your platform's equivalent with `NODE_ENV=production`, and restart it on failure.

## License

MIT (as declared in `package.json`).
