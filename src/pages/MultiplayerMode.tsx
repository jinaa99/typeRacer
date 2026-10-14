import { useEffect, useRef, useState } from 'react';
import {
  INPUT_FLUSH_MS,
  MAX_EVENTS_PER_BATCH,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROOM_CODE_LENGTH,
  type PublicRace,
  type PublicRoomState,
  type RaceResults,
  type ResyncPayload,
} from '../../shared/protocol';
import {
  applyEvent,
  createTypingState,
  encodeEvent,
  formatDuration,
  getResult,
  isFinished,
  type TypingEvent,
  type TypingState,
} from '../../shared/typing';
import { DIFFICULTY_INFO, DifficultyPicker } from '../components/DifficultyPicker';
import { TopbarActions } from '../components/TopbarSlot';
import { useNow } from '../hooks/useNow';
import { useRoom, type RoomHook } from '../net/useRoom';
import { RhythmTrack } from '../track/RhythmTrack';

/** Lane colour used to tell players apart, by join order. */
const laneOf = (room: PublicRoomState, playerId: string) => Math.max(0, room.players.findIndex((p) => p.id === playerId)) % 4;

export function MultiplayerMode({ onExit, initialCode }: { onExit: () => void; initialCode: string }) {
  const hook = useRoom();
  const { room, session } = hook;
  const inRace = room?.race != null && room.status !== 'lobby';

  const exit = () => {
    if (session) hook.leaveRoom();
    onExit();
  };

  return (
    <div className={`page ${inRace ? 'page-race' : 'page-center'}`}>
      <TopbarActions>
        <span className={`conn ${hook.connected ? 'conn-on' : 'conn-off'}`} data-testid="connection">
          {hook.connected ? 'Online' : 'Offline'}
        </span>
        <button className="btn btn-ghost" onClick={exit}>
          {session ? 'Leave room' : '← Menu'}
        </button>
      </TopbarActions>

      {(hook.error || hook.notice) && (
        <div className="toast-stack">
          {hook.error && (
            <div role="alert" className="toast toast-danger">
              <span>{hook.error}</span>
              <button className="btn btn-ghost btn-sm" onClick={hook.clearError}>
                Dismiss
              </button>
            </div>
          )}
          {hook.notice && (
            <div role="status" className="toast">
              {hook.notice}
            </div>
          )}
        </div>
      )}

      {room && session ? (
        inRace ? (
          <RaceView key={room.race!.id} hook={hook} room={room} race={room.race!} playerId={session.playerId} />
        ) : (
          <Lobby hook={hook} room={room} playerId={session.playerId} />
        )
      ) : session ? (
        <div className="panel panel-narrow loading">Reconnecting to room {session.code}…</div>
      ) : (
        <JoinForm hook={hook} initialCode={initialCode} />
      )}
    </div>
  );
}

function JoinForm({ hook, initialCode }: { hook: RoomHook; initialCode: string }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(initialCode);
  const disabled = hook.busy || !hook.connected;
  const nameValid = name.trim().length > 0;
  const codeValid = code.trim().length === ROOM_CODE_LENGTH;

  return (
    <div className="panel join">
      <p className="eyebrow">Multiplayer</p>
      <h2 className="page-title">Race your friends</h2>

      <label className="field">
        <span className="field-label">Display name</span>
        <input
          className="input input-lg"
          value={name}
          maxLength={MAX_NAME_LENGTH}
          placeholder="Your name"
          autoFocus
          onChange={(e) => setName(e.target.value)}
          data-testid="name-input"
        />
      </label>

      <div className="join-grid">
        <div className="join-box">
          <h3>New room</h3>
          <p className="muted">Get a code and invite up to {MAX_PLAYERS - 1} friends.</p>
          <button className="btn btn-primary btn-block" disabled={disabled || !nameValid} onClick={() => hook.createRoom(name)}>
            Create private room
          </button>
        </div>
        <div className="join-or">or</div>
        <form
          className="join-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (codeValid && nameValid) hook.joinRoom(code.trim().toUpperCase(), name);
          }}
        >
          <h3>Join a room</h3>
          <input
            className="input input-code"
            value={code}
            maxLength={ROOM_CODE_LENGTH}
            placeholder="ABC123"
            aria-label="Room code"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
            data-testid="code-input"
          />
          <button type="submit" className="btn btn-block" disabled={disabled || !nameValid || !codeValid}>
            Join room
          </button>
        </form>
      </div>
      {hook.busy && <p className="muted center">Connecting…</p>}
      {!hook.connected && (
        <p className="muted center" data-testid="server-waking">
          Connecting to the game server… If nobody has played for a while, it can take up to a minute to wake up.
        </p>
      )}
    </div>
  );
}

function Lobby({ hook, room, playerId }: { hook: RoomHook; room: PublicRoomState; playerId: string }) {
  const me = room.players.find((p) => p.id === playerId);
  const isHost = room.hostId === playerId;
  const connected = room.players.filter((p) => p.connected);
  const readyCount = connected.filter((p) => p.ready).length;
  const startProblem =
    connected.length < MIN_PLAYERS
      ? `Waiting for at least ${MIN_PLAYERS} players`
      : readyCount < connected.length
        ? `Waiting for everyone to be ready (${readyCount}/${connected.length})`
        : null;
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${room.code}`;
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(shareUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  const emptySlots = Math.max(0, MAX_PLAYERS - room.players.length);

  return (
    <div className="lobby">
      {room.lastResults && <ResultsPanel results={room.lastResults} playerId={playerId} room={room} />}

      <div className="lobby-grid">
        <section className="panel">
          <div className="room-head">
            <div>
              <p className="eyebrow">Room code</p>
              <div className="room-code" data-testid="room-code">
                {room.code}
              </div>
            </div>
            <button className="btn" onClick={copy} title={shareUrl}>
              {copied ? 'Link copied!' : 'Copy invite link'}
            </button>
          </div>

          <h3 className="section-title">
            Players <span className="muted">{room.players.length}/{MAX_PLAYERS}</span>
          </h3>
          <ul className="players" data-testid="player-list">
            {room.players.map((p) => (
              <li key={p.id} className={`player lane-${laneOf(room, p.id)}${p.connected ? '' : ' offline'}`}>
                <span className="player-note">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="player-name">
                  {p.name}
                  {p.id === playerId && <span className="tag">you</span>}
                  {p.isHost && <span className="tag tag-host">host</span>}
                </span>
                <span className={`pill ${!p.connected ? 'pill-off' : p.ready ? 'pill-ready' : ''}`}>
                  {!p.connected ? 'offline' : p.ready ? 'ready' : 'not ready'}
                </span>
              </li>
            ))}
            {Array.from({ length: emptySlots }, (_, i) => (
              <li key={`empty-${i}`} className="player player-empty">
                <span className="player-note" />
                <span className="player-name muted">Open slot</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel lobby-side">
          <h3 className="section-title">Difficulty</h3>
          <DifficultyPicker value={room.difficulty} onChange={hook.setDifficulty} disabled={!isHost} variant="segmented" />
          <p className="muted small">
            {isHost ? DIFFICULTY_INFO[room.difficulty].blurb : 'Only the host can change the difficulty.'}
          </p>

          <button
            className={`btn btn-lg btn-block ${me?.ready ? 'btn-ready' : ''}`}
            onClick={() => hook.setReady(!me?.ready)}
            data-testid="ready-button"
            aria-pressed={me?.ready ?? false}
          >
            {me?.ready ? '✓ Ready' : 'Ready up'}
          </button>

          {isHost ? (
            <>
              <button
                className="btn btn-primary btn-lg btn-block"
                disabled={startProblem !== null}
                onClick={hook.startRace}
                data-testid="start-button"
              >
                {room.lastResults ? 'Start next race' : 'Start race'}
              </button>
              <p className="muted small center">{startProblem ?? 'Everyone is ready. Go!'}</p>
            </>
          ) : (
            <p className="muted small center">Waiting for the host to start the race.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function RaceView({ hook, room, race, playerId }: { hook: RoomHook; room: PublicRoomState; race: PublicRace; playerId: string }) {
  const participating = room.players.find((p) => p.id === playerId)?.inRace ?? false;
  // Server timestamps converted to this browser's clock.
  const localStart = race.startAt - hook.clockOffset;
  const localEnd = race.endsAt - hook.clockOffset;

  // Authoritative state from the server (after a reconnect or rejected input)
  // replaces the local state. It may arrive before or after this view mounts.
  const pendingResync = hook.resync?.raceId === race.id ? hook.resync : null;
  const [appliedResync, setAppliedResync] = useState(pendingResync);
  const [typing, setTyping] = useState(() => typingFromResync(race.passage, localStart, pendingResync, hook.clockOffset));
  if (pendingResync !== appliedResync) {
    setAppliedResync(pendingResync);
    setTyping(typingFromResync(race.passage, localStart, pendingResync, hook.clockOffset));
  }

  const latest = useRef(typing);
  const queue = useRef<string[]>([]);
  // `hook` is a new object every render; keep the sender in a ref so the
  // flush interval below is created once and fires steadily.
  const sendInputRef = useRef(hook.sendInput);
  useEffect(() => {
    latest.current = typing;
    sendInputRef.current = hook.sendInput;
  });
  // Keystrokes queued against the previous state are obsolete after a resync.
  useEffect(() => {
    queue.current = [];
  }, [typing.epoch]);

  // Send queued keystrokes in small batches.
  useEffect(() => {
    const id = setInterval(() => {
      if (queue.current.length === 0) return;
      const batch = queue.current.splice(0, MAX_EVENTS_PER_BATCH);
      sendInputRef.current(race.id, latest.current.epoch, batch);
    }, INPUT_FLUSH_MS);
    return () => clearInterval(id);
  }, [race.id]);

  const finished = isFinished(typing.state);
  // Keep ticking while the race view is open: countdown, time left, live WPM.
  const now = useNow(true);
  const started = now >= localStart;

  const handleEvent = (event: TypingEvent) => {
    const at = Date.now();
    const current = latest.current;
    if (!participating || at < localStart || at > localEnd || isFinished(current.state)) return;
    const next = { ...current, state: applyEvent(current.state, event, at) };
    latest.current = next;
    queue.current.push(encodeEvent(event));
    setTyping(next);
  };

  const result = getResult(typing.state, finished ? typing.state.finishedAt! : Math.max(now, localStart));
  const myServerEntry = hook.progress.get(playerId);
  const racers = room.players.filter((p) => p.inRace);

  const status = !started
    ? `Starts in ${Math.ceil((localStart - now) / 1000)}`
    : finished
      ? myServerEntry?.place
        ? `Finished · Place ${myServerEntry.place} · waiting for others`
        : 'Finished · confirming…'
      : `Go! ${formatDuration(localEnd - now)} left`;

  return (
    <RhythmTrack
      state={typing.state}
      now={Math.max(now, localStart)}
      title={`Room ${room.code}`}
      subtitle={DIFFICULTY_INFO[race.difficulty].label}
      countdownMs={started ? null : localStart - now}
      disabled={!participating || !started}
      onEvent={handleEvent}
      banner={!participating ? 'Spectating — you can race in the next one' : finished ? status : null}
      hudCenter={
        <div className="racers">
          <div className="race-status" data-testid="race-status">
            {status}
          </div>
          <ul className="racer-list" data-testid="race-progress">
            {racers.map((p) => {
              const entry = hook.progress.get(p.id);
              const isMe = p.id === playerId;
              const pct = isMe ? result.progress : (entry?.progress ?? 0);
              const wpm = isMe ? result.wpm : (entry?.wpm ?? 0);
              return (
                <li key={p.id} className={`racer lane-${laneOf(room, p.id)}${isMe ? ' me' : ''}`}>
                  <span className="racer-name">
                    {entry?.finished ? `#${entry.place} ` : ''}
                    {p.name}
                    {!p.connected && ' (offline)'}
                  </span>
                  <span className="racer-bar">
                    <span style={{ width: `${pct * 100}%` }} />
                  </span>
                  <span className="racer-wpm">{Math.round(wpm)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      }
    />
  );
}

const MEDALS = ['gold', 'silver', 'bronze'];

function ResultsPanel({ results, playerId, room }: { results: RaceResults; playerId: string; room: PublicRoomState }) {
  return (
    <section className="panel results" data-testid="results">
      <h3 className="section-title">
        Last race <span className="muted">{DIFFICULTY_INFO[results.difficulty].label}</span>
      </h3>
      <table className="results-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Player</th>
            <th>Time</th>
            <th>WPM</th>
            <th>Accuracy</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          {results.entries.map((e) => (
            <tr key={e.playerId} className={e.playerId === playerId ? 'me' : undefined}>
              <td>
                <span className={`place ${e.place ? (MEDALS[e.place - 1] ?? '') : 'dnf'}`}>
                  {e.place ?? (e.left ? 'Left' : 'DNF')}
                </span>
              </td>
              <td className={`lane-${laneOf(room, e.playerId)}`}>
                {e.name}
                {e.playerId === playerId && ' (you)'}
              </td>
              <td>{e.completionMs !== null ? formatDuration(e.completionMs) : `${Math.floor(e.progress * 100)}%`}</td>
              <td className="num">{Math.round(e.wpm)}</td>
              <td>{e.accuracy.toFixed(1)}%</td>
              <td>{e.errors}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function typingFromResync(
  passage: string,
  localStart: number,
  r: ResyncPayload | null,
  clockOffset: number,
): { state: TypingState; epoch: number } {
  const fresh = createTypingState(passage, localStart);
  if (!r) return { state: fresh, epoch: 0 };
  return {
    state: {
      ...fresh,
      typed: r.typed,
      correctLength: r.correctLength,
      totalAttempts: r.totalAttempts,
      correctAttempts: r.correctAttempts,
      backspaces: r.backspaces,
      finishedAt: r.finishedAt === null ? null : r.finishedAt - clockOffset,
    },
    epoch: r.epoch,
  };
}
