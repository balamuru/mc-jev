import { GAME_TICK_MS } from '../config.js';
import { IDLE, intentChanged, type Intent } from '../intent.js';
import type { Snapshot, Vec3Like } from '../perception/types.js';
import { shouldPauseEating } from './eating.js';
import { RetreatWatch } from './retreatWatch.js';
import { decideByRules, threatsIn, type RuleSettings } from './rules.js';

/** Turns an intent into game actions. Implemented on top of Mineflayer in `agent/actuator.ts`. */
export interface Actuator {
  engage(targetId: number): void;
  retreatFrom(targetId: number): void;
  /** Stay close to an entity, such as the owner. */
  follow(targetId: number): void;
  /** Walk to a point. */
  goTo(position: Vec3Like): void;
  stop(): void;
  /** Hold off (or allow again) eating, which slows the bot and cancels its sprint. */
  setEatingPaused(paused: boolean): void;
  /** Per-step upkeep such as aiming and attack timing. `elapsedTicks` game ticks passed since the last call. */
  tick(elapsedTicks: number): void;
}

export interface ReflexOptions {
  everyTicks: number;
  rules: RuleSettings;
  read: () => Snapshot | null;
  actuator: Actuator;
  /**
   * Picks the intent when nothing overrides it. Defaults to the plain combat rules; the agent
   * supplies a mode-aware one (following, guarding, hunting, stopped).
   */
  decide?: (snapshot: Snapshot, previous: Intent) => Intent;
  onIntent?: (intent: Intent, previous: Intent) => void;
  onError?: (err: unknown) => void;
}

/**
 * The fast layer. Call `onTick` from every game tick; every `everyTicks`-th call it reads the
 * world, picks an intent (from an override if one is set, otherwise from the rules) and drives
 * the actuator. It never waits on I/O.
 */
export class ReflexLoop {
  private ticks = 0;
  private current: Intent = IDLE;
  private override: { intent: Intent; expiresAtTick: number } | null = null;
  private cornered: { intent: Intent; untilTick: number } | null = null;
  private eatingPaused = false;
  private readonly watch: RetreatWatch;
  private readonly fightBackTicks: number;

  constructor(private readonly opts: ReflexOptions) {
    const { retreatCheckMs, retreatMinGainBlocks, fightBackMs } = opts.rules;
    this.watch = new RetreatWatch(Math.ceil(retreatCheckMs / GAME_TICK_MS), retreatMinGainBlocks);
    this.fightBackTicks = Math.ceil(fightBackMs / GAME_TICK_MS);
  }

  get intent(): Intent {
    return this.current;
  }

  /**
   * Hold `intent` for `ttlTicks` game ticks in place of the rules (used by the strategic layer).
   * After that the rules take over again.
   */
  setOverride(intent: Intent, ttlTicks: number): void {
    this.override = { intent, expiresAtTick: this.ticks + ttlTicks };
  }

  clearOverride(): void {
    this.override = null;
  }

  onTick(): void {
    this.ticks++;
    if (this.ticks % this.opts.everyTicks !== 0) return;
    try {
      this.step();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private step(): void {
    const { actuator, read, everyTicks } = this.opts;
    const snapshot = read();
    if (!snapshot) return;

    this.updateEating(snapshot);

    if (this.override && this.ticks >= this.override.expiresAtTick) this.override = null;
    const next = this.choose(snapshot);

    if (intentChanged(this.current, next)) {
      const previous = this.current;
      this.current = next;
      this.apply(next);
      this.opts.onIntent?.(next, previous);
    } else {
      this.current = next; // keep the latest reason text
    }
    actuator.tick(everyTicks);
  }

  /** Pick this step's intent: a fight-back after a failed retreat, else an override, else the rules. */
  private choose(snapshot: Snapshot): Intent {
    const { rules } = this.opts;
    if (this.cornered) {
      const { intent, untilTick } = this.cornered;
      const targetLives = snapshot.entities.some((e) => e.id === intent.targetId);
      if (this.ticks < untilTick && targetLives) return intent;
      this.cornered = null;
      this.watch.reset();
    }

    const decide = this.opts.decide ?? ((snap, prev) => decideByRules(snap, rules, prev));
    const next = this.override?.intent ?? decide(snapshot, this.current);
    if (next.tactic !== 'retreat' || next.targetId === undefined) {
      this.watch.reset();
      return next;
    }

    const threat = snapshot.entities.find((e) => e.id === next.targetId);
    if (!threat) {
      this.watch.reset(); // out of sight or range: the retreat has worked
      return next;
    }
    if (this.watch.update(this.ticks, threat.id, threat.dist) === 'ok') return next;

    // The retreat is not gaining ground. Turn and fight the nearest threat instead of running in place.
    const fightBack = threatsIn(snapshot, rules)[0];
    if (!fightBack || this.fightBackTicks === 0) return next;
    const intent: Intent = {
      tactic: 'engage',
      targetId: fightBack.id,
      reason: `retreat from ${threat.kind} failed, fighting back`,
    };
    this.cornered = { intent, untilTick: this.ticks + this.fightBackTicks };
    this.watch.reset();
    return intent;
  }

  private updateEating(snapshot: Snapshot): void {
    const pause = shouldPauseEating(snapshot, this.opts.rules.noEatRadiusBlocks);
    if (pause === this.eatingPaused) return;
    this.eatingPaused = pause;
    this.opts.actuator.setEatingPaused(pause);
  }

  private apply(intent: Intent): void {
    const { actuator } = this.opts;
    if (intent.tactic === 'engage' && intent.targetId !== undefined) {
      actuator.engage(intent.targetId);
    } else if (intent.tactic === 'retreat' && intent.targetId !== undefined) {
      actuator.retreatFrom(intent.targetId);
    } else if (intent.tactic === 'follow' && intent.targetId !== undefined) {
      actuator.follow(intent.targetId);
    } else if (intent.tactic === 'goto' && intent.position) {
      actuator.goTo(intent.position);
    } else {
      actuator.stop();
    }
  }

  /** Stop all actions, e.g. on disconnect. */
  dispose(): void {
    this.override = null;
    this.cornered = null;
    this.watch.reset();
    this.current = IDLE;
    try {
      if (this.eatingPaused) this.opts.actuator.setEatingPaused(false);
      this.eatingPaused = false;
      this.opts.actuator.stop();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
