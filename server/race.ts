import type { Passage } from '../shared/passages';
import type { ProgressEntry, RaceResultEntry, RaceResults, ResyncPayload } from '../shared/protocol';
import {
  applyEvents,
  createTypingState,
  getResult,
  isFinished,
  validateState,
  type TypingEvent,
  type TypingState,
} from '../shared/typing';

export interface RaceLimits {
  maxCharsPerSecond: number;
  inputBurstAllowance: number;
}

interface Participant {
  playerId: string;
  name: string;
  state: TypingState;
  /** Incremented on every resync; batches tagged with an older epoch are dropped. */
  epoch: number;
  place: number | null;
  left: boolean;
}

export type InputOutcome =
  | { kind: 'applied'; finishedNow: boolean }
  | { kind: 'ignored'; reason: string }
  | { kind: 'rejected'; resync: ResyncPayload };

/**
 * Authoritative state of one race. Each player's typing is replayed through
 * the shared engine using server receive times, so WPM, accuracy, completion
 * time and placement never come from the client.
 */
export class Race {
  readonly participants = new Map<string, Participant>();
  private finishCount = 0;

  constructor(
    readonly id: string,
    readonly passage: Passage,
    readonly startAt: number,
    readonly endsAt: number,
    players: { id: string; name: string }[],
    private readonly limits: RaceLimits,
  ) {
    for (const p of players) {
      this.participants.set(p.id, {
        playerId: p.id,
        name: p.name,
        state: createTypingState(passage.text, startAt),
        epoch: 0,
        place: null,
        left: false,
      });
    }
  }

  has(playerId: string): boolean {
    return this.participants.has(playerId);
  }

  applyInput(playerId: string, epoch: number, events: TypingEvent[], now: number): InputOutcome {
    const p = this.participants.get(playerId);
    if (!p || p.left) return { kind: 'ignored', reason: 'not a participant' };
    if (isFinished(p.state)) return { kind: 'ignored', reason: 'already finished' };
    if (epoch !== p.epoch) return { kind: 'ignored', reason: 'stale epoch' };
    if (now > this.endsAt) return { kind: 'ignored', reason: 'race is over' };
    if (now < this.startAt) return { kind: 'rejected', resync: this.resync(playerId, 'Race has not started yet') };

    const next = applyEvents(p.state, events, now);
    const allowed =
      ((now - this.startAt) / 1000) * this.limits.maxCharsPerSecond + this.limits.inputBurstAllowance;
    if (next.totalAttempts > allowed || !validateState(next)) {
      return { kind: 'rejected', resync: this.resync(playerId, 'Input rejected: typing speed is not plausible') };
    }

    p.state = next;
    const finishedNow = isFinished(next);
    if (finishedNow) p.place = ++this.finishCount;
    return { kind: 'applied', finishedNow };
  }

  /** Bumps the player's epoch and returns their authoritative state. */
  resync(playerId: string, reason: string): ResyncPayload {
    const p = this.participants.get(playerId);
    if (!p) throw new Error(`Unknown participant ${playerId}`);
    p.epoch += 1;
    const s = p.state;
    return {
      raceId: this.id,
      epoch: p.epoch,
      typed: s.typed,
      correctLength: s.correctLength,
      totalAttempts: s.totalAttempts,
      correctAttempts: s.correctAttempts,
      backspaces: s.backspaces,
      finishedAt: s.finishedAt,
      reason,
    };
  }

  markLeft(playerId: string): void {
    const p = this.participants.get(playerId);
    if (p) p.left = true;
  }

  /** True when every participant has finished or left. */
  isComplete(): boolean {
    for (const p of this.participants.values()) {
      if (!p.left && !isFinished(p.state)) return false;
    }
    return true;
  }

  progress(now: number): ProgressEntry[] {
    const at = Math.min(now, this.endsAt);
    return [...this.participants.values()].map((p) => {
      const r = getResult(p.state, Math.max(at, this.startAt));
      return {
        playerId: p.playerId,
        progress: r.progress,
        correctChars: r.correctChars,
        wpm: r.wpm,
        finished: r.finished,
        place: p.place,
        completionMs: r.finished ? r.elapsedMs : null,
      };
    });
  }

  results(now: number): RaceResults {
    const at = Math.max(this.startAt, Math.min(now, this.endsAt));
    const entries: RaceResultEntry[] = [...this.participants.values()].map((p) => {
      const r = getResult(p.state, at);
      return {
        playerId: p.playerId,
        name: p.name,
        place: r.finished ? p.place : null,
        finished: r.finished,
        completionMs: r.finished ? r.elapsedMs : null,
        wpm: r.wpm,
        accuracy: r.accuracy,
        errors: r.errors,
        progress: r.progress,
        left: p.left,
      };
    });
    entries.sort((a, b) => {
      if (a.place !== null && b.place !== null) return a.place - b.place;
      if (a.place !== null) return -1;
      if (b.place !== null) return 1;
      return b.progress - a.progress || a.name.localeCompare(b.name);
    });
    return {
      raceId: this.id,
      difficulty: this.passage.difficulty,
      passageLength: this.passage.text.length,
      entries,
    };
  }
}
