import type { TypingState } from '../../shared/typing';
import { LANE_COUNT, laneForChar, SPACE_LANE } from './lanes';

/**
 * Canvas renderer for the falling-notes track.
 *
 * Every upcoming passage character is a note in its keyboard lane. Notes are
 * stacked above the hit line in passage order and ease toward their slot, so
 * new notes flow in from the top. When a character is typed correctly its
 * note drops into the hit circle and bursts; the faster the player types,
 * the faster the stack moves. Purely visual: game state comes from TypingState.
 */

export const HIT_LINE_RATIO = 0.62;

const LANE_COLORS = ['#e9a23b', '#e8662a', '#5b7ff0', '#d9dbe2'];
const ACCENT = '#e9a23b';
const DANGER = '#ef4b4f';
const BG = '#111216';
const FONT = '"DotGothic16", ui-monospace, monospace';
const SPACE_WEIGHT = 0.6;
/** Larger jumps (resync after reconnect) are applied without per-note effects. */
const MAX_ANIMATED_JUMP = 6;
/** Lanes stay in a centred playfield on wide screens. */
const MAX_PLAYFIELD_WIDTH = 900;

interface Note {
  index: number;
  char: string;
  lane: number;
  y: number;
  vy: number;
  hitting: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

interface Ring {
  x: number;
  y: number;
  life: number;
  color: string;
}

interface Popup {
  lane: number;
  text: string;
  color: string;
  life: number;
}

interface Dust {
  x: number;
  y: number;
  vy: number;
  size: number;
  alpha: number;
}

export class TrackRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion: boolean;
  private frame = 0;
  private lastTime = 0;
  private w = 0;
  private h = 0;

  private state: TypingState | null = null;
  /** Cumulative vertical slot of each passage index (spaces take less room). */
  private slots: number[] = [];
  private notes = new Map<number, Note>();
  private highestSpawned = -1;

  private particles: Particle[] = [];
  private rings: Ring[] = [];
  private popups: Popup[] = [];
  private dust: Dust[] = [];
  private laneFlash = new Array<number>(LANE_COUNT).fill(0);
  private laneMiss = new Array<number>(LANE_COUNT).fill(0);
  private lineFlash = 0;
  private lineMiss = 0;
  private shake = 0;
  private combo = 0;
  private comboPulse = 0;
  private keyTimes: number[] = [];
  private countdown: number | null = null;
  private countdownPulse = 0;
  private finalePending = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    document.fonts?.load(`16px ${FONT}`).catch(() => {});
    this.frame = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
  }

  setCountdown(seconds: number | null): void {
    if (seconds !== this.countdown) this.countdownPulse = 1;
    this.countdown = seconds;
  }

  setState(next: TypingState): void {
    const prev = this.state;
    this.state = next;
    if (!prev || prev.passage !== next.passage) {
      this.reset(next);
      return;
    }

    const dCorrect = next.correctLength - prev.correctLength;
    const dAttempts = next.totalAttempts - prev.totalAttempts;
    const dCorrectAttempts = next.correctAttempts - prev.correctAttempts;

    if (Math.abs(dCorrect) > MAX_ANIMATED_JUMP || dAttempts < 0) {
      // Authoritative resync: rebuild the stack quietly.
      this.notes.clear();
      this.highestSpawned = next.correctLength - 1;
      return;
    }

    if (dCorrect > 0) {
      const now = performance.now();
      for (let i = prev.correctLength; i < next.correctLength; i++) {
        const note = this.notes.get(i) ?? this.spawn(i, this.layout().hitY - this.layout().restGap);
        note.hitting = true;
        note.vy = Math.max(note.vy, 900);
        this.keyTimes.push(now);
      }
      this.combo += dCorrect;
      this.comboPulse = 1;
    } else if (dCorrect < 0) {
      // Backspace over correct text: those notes rise back out of the line.
      const { hitY } = this.layout();
      for (let i = next.correctLength; i < prev.correctLength; i++) {
        const note = this.notes.get(i);
        if (note) note.hitting = false;
        else this.spawn(i, hitY);
      }
    }

    if (dAttempts > dCorrectAttempts) {
      this.combo = 0;
      this.miss(laneForChar(next.passage[next.correctLength] ?? ' '));
    }

    if (next.finishedAt !== null && prev.finishedAt === null) this.finalePending = true;
  }

  // --- simulation -----------------------------------------------------------

  private reset(state: TypingState): void {
    this.notes.clear();
    this.particles = [];
    this.rings = [];
    this.popups = [];
    this.combo = 0;
    this.keyTimes = [];
    this.finalePending = false;
    this.highestSpawned = state.correctLength - 1;
    this.slots = [0];
    for (const char of state.passage) {
      this.slots.push(this.slots[this.slots.length - 1] + (char === ' ' ? SPACE_WEIGHT : 1));
    }
  }

  private layout() {
    const w = this.w;
    const h = this.h;
    const fieldWidth = Math.min(w, MAX_PLAYFIELD_WIDTH);
    const fieldLeft = (w - fieldWidth) / 2;
    const radius = Math.max(18, Math.min(36, fieldWidth * 0.045));
    const spacing = Math.max(radius * 2.4, Math.min(h * 0.14, 110));
    const hitY = Math.round(h * HIT_LINE_RATIO);
    return { w, h, fieldLeft, fieldWidth, radius, spacing, hitY, restGap: spacing * 0.8 };
  }

  private laneX(lane: number): number {
    const { fieldLeft, fieldWidth } = this.layout();
    return fieldLeft + (fieldWidth * (lane + 0.5)) / LANE_COUNT;
  }

  /** X of the boundary to the left of `lane` (0..LANE_COUNT). */
  private laneEdge(lane: number): number {
    const { fieldLeft, fieldWidth } = this.layout();
    return fieldLeft + (fieldWidth * lane) / LANE_COUNT;
  }

  private targetY(index: number): number {
    const { hitY, restGap, spacing } = this.layout();
    const base = this.state?.correctLength ?? 0;
    return hitY - restGap - (this.slots[index] - this.slots[base]) * spacing;
  }

  private spawn(index: number, y: number): Note {
    const char = this.state!.passage[index];
    const note: Note = { index, char, lane: laneForChar(char), y, vy: 0, hitting: false };
    this.notes.set(index, note);
    this.highestSpawned = Math.max(this.highestSpawned, index);
    return note;
  }

  private ensureNotes(): void {
    const state = this.state;
    if (!state) return;
    const { radius, h, hitY } = this.layout();
    for (let i = state.correctLength; i < state.passage.length; i++) {
      const target = this.targetY(i);
      if (target < -radius * 3) break;
      if (this.notes.has(i)) continue;
      // New notes flow in from above the top edge; restored ones rise from the line.
      const y = i <= this.highestSpawned ? hitY : Math.min(target - h * 0.3, -radius * 2);
      this.spawn(i, y);
    }
  }

  private update(dt: number): void {
    const state = this.state;
    const { radius, hitY, w, h } = this.layout();
    this.ensureNotes();

    // The stack follows faster when the player types faster.
    const now = performance.now();
    this.keyTimes = this.keyTimes.filter((t) => now - t < 1500);
    const rate = 9 + Math.min(24, (this.keyTimes.length / 1.5) * 1.6);
    const ease = 1 - Math.exp(-dt * rate);

    for (const note of [...this.notes.values()]) {
      if (note.hitting) {
        note.vy += 14_000 * dt;
        note.y += note.vy * dt;
        if (note.y >= hitY) {
          this.notes.delete(note.index);
          this.hit(note);
        }
        continue;
      }
      const target = this.targetY(note.index);
      note.y += (target - note.y) * ease;
      if (state && note.index >= state.correctLength && target < -radius * 3 && note.y < -radius * 2) {
        this.notes.delete(note.index);
      }
    }

    if (this.finalePending && ![...this.notes.values()].some((n) => n.hitting)) {
      this.finalePending = false;
      this.finale();
    }

    for (const p of this.particles) {
      p.vy += 1100 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const r of this.rings) r.life -= dt / 0.4;
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const p of this.popups) p.life -= dt / 0.7;
    this.popups = this.popups.filter((p) => p.life > 0);

    const decay = Math.exp(-dt * 7);
    this.laneFlash = this.laneFlash.map((v) => v * decay);
    this.laneMiss = this.laneMiss.map((v) => v * decay);
    this.lineFlash *= decay;
    this.lineMiss *= decay;
    this.shake *= Math.exp(-dt * 14);
    this.comboPulse *= Math.exp(-dt * 9);
    this.countdownPulse *= Math.exp(-dt * 5);

    if (this.dust.length === 0 && w > 0) {
      for (let i = 0; i < 28; i++) {
        this.dust.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vy: 6 + Math.random() * 16,
          size: Math.random() < 0.3 ? 2 : 1.2,
          alpha: 0.15 + Math.random() * 0.35,
        });
      }
    }
    for (const d of this.dust) {
      d.y += d.vy * dt;
      if (d.y > h) {
        d.y = -4;
        d.x = Math.random() * w;
      }
    }
  }

  private hit(note: Note): void {
    const { hitY } = this.layout();
    if (note.lane === SPACE_LANE) {
      this.lineFlash = 1;
      for (let lane = 0; lane < LANE_COUNT; lane++) {
        this.burst(this.laneX(lane), hitY, ACCENT, this.reducedMotion ? 1 : 4, 160);
      }
      return;
    }
    const x = this.laneX(note.lane);
    const color = LANE_COLORS[note.lane];
    this.laneFlash[note.lane] = 1;
    this.burst(x, hitY, color, this.reducedMotion ? 4 : 16, 420);
    this.rings.push({ x, y: hitY, life: 1, color });
    this.popups = this.popups.filter((p) => p.lane !== note.lane);
    this.popups.push({ lane: note.lane, text: 'PERFECT', color: ACCENT, life: 1 });
  }

  private miss(lane: number): void {
    if (!this.reducedMotion) this.shake = 1;
    if (lane === SPACE_LANE) this.lineMiss = 1;
    else this.laneMiss[lane] = 1;
    this.popups = this.popups.filter((p) => p.lane !== lane);
    this.popups.push({ lane, text: 'MISS', color: DANGER, life: 1 });
  }

  private finale(): void {
    const { hitY } = this.layout();
    this.lineFlash = 1;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      this.laneFlash[lane] = 1;
      const x = this.laneX(lane);
      this.burst(x, hitY, LANE_COLORS[lane], this.reducedMotion ? 6 : 30, 620);
      this.rings.push({ x, y: hitY, life: 1, color: LANE_COLORS[lane] });
    }
  }

  private burst(x: number, y: number, color: string, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      // Mostly upward spray, like sparks thrown off the hit circle.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
      const v = speed * (0.35 + Math.random() * 0.65);
      const maxLife = 0.45 + Math.random() * 0.45;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v,
        life: maxLife,
        maxLife,
        size: 1.5 + Math.random() * 2.5,
        color: Math.random() < 0.25 ? '#ffffff' : color,
      });
    }
  }

  // --- drawing --------------------------------------------------------------

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dust = [];
  }

  private readonly tick = (time: number) => {
    const dt = this.lastTime ? Math.min(0.05, (time - this.lastTime) / 1000) : 0;
    this.lastTime = time;
    if (this.w > 0 && this.h > 0) {
      this.update(dt);
      this.draw();
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private draw(): void {
    const ctx = this.ctx;
    const { w, h, radius, hitY, spacing, fieldLeft, fieldWidth } = this.layout();
    ctx.save();
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);
    if (this.shake > 0.01) ctx.translate((Math.random() - 0.5) * 8 * this.shake, (Math.random() - 0.5) * 5 * this.shake);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let lane = fieldLeft > 0 ? 0 : 1; lane <= (fieldLeft > 0 ? LANE_COUNT : LANE_COUNT - 1); lane++) {
      const x = Math.round(this.laneEdge(lane)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    const gridY = Math.round(hitY - spacing * 3) + 0.5;
    ctx.moveTo(fieldLeft, gridY);
    ctx.lineTo(fieldLeft + fieldWidth, gridY);
    ctx.stroke();

    for (const d of this.dust) {
      ctx.fillStyle = `rgba(233,162,59,${d.alpha})`;
      ctx.fillRect(d.x, d.y, d.size, d.size);
    }

    this.drawCenterText(hitY);
    this.drawConnections();
    this.drawHitLine(hitY, radius);
    this.drawPopups(hitY, radius);
    this.drawNotes(radius);
    this.drawEffects(radius);
    ctx.restore();
  }

  private drawCenterText(hitY: number): void {
    const ctx = this.ctx;
    const { h, w } = this.layout();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (this.countdown !== null) {
      const size = h * 0.2 * (1 + this.countdownPulse * 0.25);
      ctx.font = `${size}px ${FONT}`;
      ctx.fillStyle = `rgba(233,162,59,${0.55 + this.countdownPulse * 0.45})`;
      ctx.fillText(String(this.countdown), w / 2, hitY * 0.5);
      return;
    }
    if (this.combo >= 3) {
      const size = h * 0.13 * (1 + this.comboPulse * 0.08);
      ctx.font = `${size}px ${FONT}`;
      ctx.fillStyle = `rgba(255,255,255,${0.1 + this.comboPulse * 0.08})`;
      ctx.fillText(String(this.combo), w / 2, hitY * 0.62);
    }
  }

  private drawConnections(): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const note of this.notes.values()) {
      const next = this.notes.get(note.index + 1);
      if (!next || note.hitting || next.hitting || note.lane === SPACE_LANE || next.lane === SPACE_LANE) continue;
      ctx.moveTo(this.laneX(note.lane), note.y);
      ctx.lineTo(this.laneX(next.lane), next.y);
    }
    ctx.stroke();
  }

  private drawHitLine(hitY: number, radius: number): void {
    const ctx = this.ctx;
    const { w } = this.layout();
    const nextChar = this.state?.passage[this.state.correctLength];
    const nextLane = nextChar === undefined ? null : laneForChar(nextChar);
    const errors = this.state ? this.state.typed.length - this.state.correctLength : 0;

    ctx.lineWidth = 2 + this.lineFlash * 2;
    ctx.strokeStyle =
      this.lineMiss > 0.05
        ? `rgba(239,75,79,${0.6 + this.lineMiss * 0.4})`
        : this.lineFlash > 0.05
          ? `rgba(255,214,140,${0.75 + this.lineFlash * 0.25})`
          : 'rgba(233,162,59,0.85)';
    ctx.beginPath();
    let x = 0;
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const cx = this.laneX(lane);
      ctx.moveTo(x, hitY);
      ctx.lineTo(cx - radius - 6, hitY);
      x = cx + radius + 6;
    }
    ctx.moveTo(x, hitY);
    ctx.lineTo(w, hitY);
    ctx.stroke();

    for (let lane = 0; lane < LANE_COUNT; lane++) {
      const cx = this.laneX(lane);
      const flash = this.laneFlash[lane];
      const miss = this.laneMiss[lane];
      const color = miss > 0.05 ? DANGER : LANE_COLORS[lane];
      if (flash > 0.02 || miss > 0.02) {
        ctx.save();
        ctx.globalAlpha = Math.max(flash, miss) * 0.35;
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 24;
        ctx.beginPath();
        ctx.arc(cx, hitY, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      const highlighted = lane === nextLane;
      ctx.globalAlpha = highlighted ? 0.95 : 0.45 + flash * 0.5;
      ctx.strokeStyle = highlighted && errors > 0 ? DANGER : color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, hitY, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawNotes(radius: number): void {
    const ctx = this.ctx;
    const { fieldLeft, fieldWidth } = this.layout();
    const state = this.state;
    const errors = state ? state.typed.length - state.correctLength : 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const note of this.notes.values()) {
      const isNext = state !== null && note.index === state.correctLength && !note.hitting;
      const wrong = isNext && errors > 0;
      const fadeIn = Math.max(0, Math.min(1, (note.y + radius * 2) / (radius * 4)));
      const jitter = wrong && !this.reducedMotion ? (Math.random() - 0.5) * 4 : 0;

      ctx.save();
      ctx.globalAlpha = fadeIn;
      if (note.lane === SPACE_LANE) {
        ctx.setLineDash([6, 8]);
        ctx.strokeStyle = wrong ? DANGER : isNext ? 'rgba(233,162,59,0.8)' : 'rgba(233,162,59,0.3)';
        ctx.lineWidth = isNext ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(fieldLeft, note.y);
        ctx.lineTo(fieldLeft + fieldWidth, note.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
        continue;
      }

      const x = this.laneX(note.lane) + jitter;
      const color = wrong ? DANGER : LANE_COLORS[note.lane];
      if (isNext || note.hitting) {
        ctx.shadowColor = color;
        ctx.shadowBlur = note.hitting ? 22 : 12;
      }
      ctx.fillStyle = '#18191e';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, note.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.font = `${Math.round(radius * 0.95)}px ${FONT}`;
      ctx.fillText(note.char, x, note.y + 1);
      ctx.restore();
    }
  }

  /** Judgement text, drawn under the notes so it never hides a letter. */
  private drawPopups(hitY: number, radius: number): void {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.round(radius * 0.55)}px ${FONT}`;
    for (const p of this.popups) {
      ctx.globalAlpha = Math.min(1, p.life * 1.6) * 0.85;
      ctx.fillStyle = p.color;
      const x = p.lane === SPACE_LANE ? this.w / 2 : this.laneX(p.lane);
      ctx.fillText(p.text, x, hitY - radius * 1.55 - (1 - p.life) * 22);
    }
    ctx.globalAlpha = 1;
  }

  private drawEffects(radius: number): void {
    const ctx = this.ctx;
    for (const r of this.rings) {
      ctx.save();
      ctx.globalAlpha = r.life * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius * (1 + (1 - r.life) * 0.9), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    for (const p of this.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
