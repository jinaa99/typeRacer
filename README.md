# Type Race

A browser-based English typing race game with solo mode and private multiplayer lobbies.

The app is a full-screen dark UI with a pixel-font look. Use the button in the top-right corner to switch to browser fullscreen. The race screen uses the falling-notes track described below. Game logic lives outside the React components, so the visual layer can be replaced.

## Stack

- **Client:** React + Vite + TypeScript (`src/`)
- **Server:** Node.js + Express + Socket.IO (`server/`). It serves the built client and the WebSocket endpoint from one process.
- **Shared:** typing engine, scoring, passages and protocol types (`shared/`). Used by both client and server.
- **Tests:** Vitest (`tests/`)

No database and no accounts. Lobby and race state live in server memory.

## Getting started

Requires Node.js 20+.

```bash
npm install
npm run dev        # server on :3001 + Vite on :5173 (Vite proxies /socket.io)
```

Open http://localhost:5173.

### Production build

```bash
npm run build      # client -> dist/client, server bundle -> dist/server/index.js
                   # (or separately: npm run build:client / npm run build:server)
npm start          # serves everything on $PORT (default 3001)
```

### Checks

```bash
npm run typecheck
npm run lint
npm test           # unit + Socket.IO integration tests
npm run check      # all of the above + build
```

## Trying it out

**Solo:** click *Solo race*, pick a difficulty, then *Start race*. The timer starts on your first keystroke.

**Multiplayer with two windows:**

1. Window 1: *Multiplayer*, enter a name, then *Create private room*. Note the room code or share link.
2. Window 2: open the share link (or *Multiplayer*, then enter the code), choose a different name, then *Join room*.
   Use a separate window or tab. Each tab is its own player because the session is kept in `sessionStorage`. To test from another device, open `http://<your-LAN-IP>:5173` in dev (start Vite with `--host`) or the deployed URL.
3. Both players click *Ready*. The host picks a difficulty and clicks *Start race*.
4. After the race, the results appear in the lobby. Ready up again and the host can start another race.

Refreshing a tab mid-race reconnects you to the same seat and restores your progress.

## Race screen (falling-notes track)

Both modes use the same track view (`src/track/`), styled after rhythm games:

- **Falling notes.** Every upcoming character is a note in one of four lanes. The lane follows the keyboard zone: `qwe asd zxc` → 1, `rt fg vb` → 2, `yu hj nm` → 3, `iop kl ;'` and `,./` → 4. Shifted keys use their base key's lane. A space is a dashed line across the whole track.
- **Notes flow in from the top.** They stack above the hit line in passage order.
- **Correct key.** The note drops into its hit circle and bursts with sparks, a ring and **PERFECT**. The stack moves faster the faster you type.
- **Wrong key.** The circle flashes red, **MISS** appears, the track shakes briefly, and the next note turns red until you backspace.
- **Combo.** The big number in the middle counts correct keys in a row.
- **Words under the line.** You see the current word, with typed letters in orange, mistakes in red and the caret underlined, and the next words fade out below it.
- **HUD.** Shows WPM, time, errors, accuracy and progress. In multiplayer, opponents appear as initials on the progress bar.

The renderer (`src/track/renderer.ts`) is a plain canvas class that only reads `TypingState`, so it cannot affect scoring. When the system asks for reduced motion, it uses fewer particles and turns off the shake.

### Keyboard shortcuts

| Where | Key | Action |
| --- | --- | --- |
| Home | `1` / `2` | Solo / Multiplayer |
| Solo setup | `1` `2` `3`, `Enter` | Pick difficulty, start |
| Solo race | `Esc` | New passage |
| Solo results | `Enter` | Race again |

Keystrokes typed while the hidden input isn't focused (for example, after clicking a button) still go to the race.

## Game rules

### Input

- Only single typed characters and Backspace count. Paste, drag-and-drop, cut, autocorrect replacements and multi-character inserts are ignored.
- A character is correct only if all earlier characters are correct and it matches the passage.
- After a mistake you can type at most 8 characters past the correct text (`MAX_UNCORRECTED_ERRORS`). After that, input is blocked until you backspace.
- You cannot type past the end of the passage.
- The race finishes when the whole passage has been typed correctly.

### Scoring (`shared/typing.ts`)

| Metric | Definition |
| --- | --- |
| WPM | correctly typed characters ÷ 5 ÷ elapsed minutes (0 when elapsed is 0) |
| Accuracy | correct character attempts ÷ total character attempts × 100 (0 when there are no attempts) |
| Errors | incorrect character attempts |

- A corrected mistake still counts as an incorrect attempt, so it lowers accuracy permanently.
- A corrected mistake does not reduce final WPM directly; it only costs time.
- Backspace is not an attempt.
- A finished race has every character correct, so final WPM = passage length ÷ 5 ÷ minutes.

**Solo:** the clock starts at the first keystroke.

**Multiplayer:** the clock starts at the server's synchronized start time, and the race ends when every racer has finished or left. Unfinished racers are marked DNF after `RACE_MAX_DURATION_MS`.

### Server authority (multiplayer)

- The client sends raw keystroke events in batches every 100 ms (`race:input`). It never sends WPM, accuracy, time or placement.
- The server replays the keystrokes through the same engine, using its own receive timestamps. Completion time, placement, WPM and accuracy all come from that replay.
- The server rejects input that arrives before the start or that implies more than 25 chars/sec (plus a burst allowance). It then sends the player its authoritative state (`race:resync`). An epoch counter discards batches that were in flight before the resync.
- Only the host can change the difficulty or start a race. To start:
  - the room must be in the lobby;
  - at least 2 players must be connected;
  - every connected player must be ready.
- Joining is refused when:
  - the room code is unknown;
  - the room is full (8 players);
  - a race is running;
  - the display name is already taken in the room (case-insensitive).
- Every incoming payload is validated (`server/validation.ts`). Each socket is also limited to 40 events/sec.
- Clients only receive public state. Reconnect tokens are sent only to their owner.

### Disconnects

- **Refresh or dropped connection:** the player keeps their seat for `RECONNECT_GRACE_MS` and rejoins automatically with their token. Mid-race, they resume from server state.
- **Host disconnects:** after `HOST_GRACE_MS`, the host role passes to the earliest-joined connected player.
- **Host leaves or is removed:** the host role transfers immediately.
- **Player times out or clicks *Leave room*:** the player is removed. In a race they are shown as "Left".
- **Opening the same seat in a second tab:** the older connection is disconnected.
- **Empty room:** deleted, with all its timers cleared.

## Passages

Passages are in `shared/passages/{easy,medium,hard}.ts`: 50 Easy, 40 Medium and 36 Hard, written as natural English sentences.

- **Race length:** each race joins several passages of the chosen difficulty into one text of about `TARGET_RACE_LENGTH` = 500 characters. That's about 2 minutes at 50 WPM:

  | Level | Passages per race | Length | Words |
  | --- | --- | --- | --- |
  | Easy | 6–7 | 460–540 chars | ~108 |
  | Medium | 3–4 | 420–570 chars | ~84 |
  | Hard | 2–3 | 390–610 chars | ~49 |

  To change it, edit `TARGET_RACE_SECONDS` or `REFERENCE_WPM` in `shared/passages/index.ts`.
- **Selection:** the server builds the race text (`buildRaceText`) and sends the same text to every player. A passage never appears twice in one race. The last 30 passages used are avoided per lobby; solo mode does the same per session.
- **Validation:** `validatePassage` checks that each passage:
  - is non-empty and printable ASCII;
  - has no stray whitespace;
  - starts with a capital and ends with punctuation;
  - fits the length and average word length bands for its difficulty.

  The test suite runs every passage through it.

To add passages, append strings to the relevant file. Ids are index-based, so add to the end. Then run `npm test` to confirm they fit the difficulty rules.

## Configuration

See `.env.example`. All variables are optional.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 3001 | HTTP + WebSocket port |
| `CORS_ORIGIN` | unset | Comma-separated allowed origins when the frontend is on another origin (e.g. Vercel). `*` matches part of a subdomain: `https://typeracer-*.vercel.app` |
| `VITE_SERVER_URL` | unset | Build-time: realtime server URL for a separately hosted frontend |
| `CLIENT_DIST_DIR` | `dist/client` | Directory of the built client to serve |
| `COUNTDOWN_MS` | 3000 | Pre-race countdown |
| `RECONNECT_GRACE_MS` | 30000 | Seat reservation for disconnected players |
| `HOST_GRACE_MS` | 5000 | Delay before host transfer on disconnect |
| `RACE_MAX_DURATION_MS` | 600000 | Race time limit (10 min) |
| `PROGRESS_INTERVAL_MS` | 250 | Progress broadcast interval |
| `MAX_ROOMS` | 1000 | Cap on concurrent rooms |

## Deployment

The **frontend runs on Vercel**. The **realtime server runs on Render**.

Vercel's WebSocket support (public beta since June 2026) can't host this server as written:
- Each connection is pinned to its own function instance. Lobbies are kept in server memory, so players on different instances could not see each other's rooms.
- Connections are closed when the function reaches its maximum duration.

Render runs the Socket.IO server as one long-running Node process, which is what it needs.

```
Browser ──HTTPS──▶ Vercel (static site: dist/client)
   │
   └──WebSocket──▶ Render (Socket.IO server: dist/server/index.js)
```

### 1. Realtime server on Render

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. `render.yaml` creates the `typeracer-realtime` web service:
   - build: `npm ci --include=dev && npm run build:server`
   - start: `npm start`
   - health check: `/health`
3. When asked for `CORS_ORIGIN`, enter your Vercel URL and a wildcard for preview deployments:
   ```
   https://typeracer.vercel.app,https://typeracer-*.vercel.app
   ```
   You can fill this in after step 2 of the Vercel setup and redeploy.
4. Note the service URL, e.g. `https://typeracer-realtime.onrender.com`. Opening it shows "Type Race realtime server is running."

### 2. Frontend on Vercel

1. In Vercel, choose **Add New → Project** and import the same repository. `vercel.json` sets:
   - build command: `npm run build:client`
   - output directory: `dist/client`
2. Under **Settings → Environment Variables**, add `VITE_SERVER_URL` = your Render URL (e.g. `https://typeracer-realtime.onrender.com`). Enable it for Production and Preview.
3. Deploy. `VITE_SERVER_URL` is baked in at build time, so redeploy after changing it.
4. If the Vercel URL differs from what you entered in `CORS_ORIGIN`, update it on Render.

### Things to know

- **Free Render instances sleep after about 15 minutes without traffic.** The first visitor afterwards waits up to about a minute while the server wakes. The multiplayer screen shows a "connecting / waking up" message during that time; solo mode doesn't need the server at all. A paid instance avoids sleeping.
- **Run exactly one server instance.** Lobbies live in memory. A restart or redeploy ends all active lobbies, and scaling to several instances would need a shared store (e.g. the Socket.IO Redis adapter), which is not implemented.
- **`CORS_ORIGIN` must include every site origin** that should be able to play multiplayer. A `*` matches part of one subdomain, e.g. `https://typeracer-*.vercel.app`.

### Single-service alternative

Any host that runs a long-lived Node process (Render, Railway, Fly.io, a VPS) can also serve both parts from one process. Run `npm run build && npm start`. Leave `VITE_SERVER_URL` and `CORS_ORIGIN` unset.

## Project layout

```
shared/
  typing.ts            typing engine, scoring, result validation
  passages/            datasets, difficulty rules, selection
  protocol.ts          socket event + payload types, limits
server/
  index.ts             entry point (env config, static files, listen)
  app.ts               Express + Socket.IO wiring, rate limit, event dispatch
  RoomManager.ts       lobbies, players, host, reconnects, race lifecycle
  race.ts              authoritative per-race typing replay and rankings
  validation.ts        untrusted payload parsing
  config.ts            environment configuration
src/
  net/                 socket client, session storage, useRoom hook
  track/               falling-notes race view: lanes, word window, canvas renderer, RhythmTrack
  components/          TypingInput (keystroke capture)
  pages/               SoloMode, MultiplayerMode (join, lobby, race, results)
tests/                 engine, passages, validation, RoomManager, Socket.IO integration
```

## Known limitations

- Mobile keyboards that use IME composition (for example, some Android keyboards) may not send cancellable `beforeinput` events, so typing on those devices may not work reliably. Desktop browsers are supported.
- Server completion times include network latency for the final keystroke batch (roughly the player's one-way latency plus up to 100 ms of client batching).
- No persistence: lobbies are lost on server restart, and solo results are not saved.
- The speed limit (25 chars/sec, about 300 WPM) is a basic anti-cheat check. It does not detect scripted typing below that speed.
# typeRacer
