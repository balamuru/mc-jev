import { IDLE, intentChanged, type Intent } from '../intent.js';
import type { Snapshot } from '../perception/types.js';
import { decideByRules, type RuleSettings } from './rules.js';

/** Turns an intent into game actions. Implemented on top of Mineflayer in `agent/actuator.ts`. */
export interface Actuator {
  engage(targetId: number): void;
  retreatFrom(targetId: number): void;
  stop(): void;
  /** Per-step upkeep such as aiming and attack timing. `elapsedTicks` game ticks passed since the last call. */
  tick(elapsedTicks: number): void;
}

export interface ReflexOptions {
  everyTicks: number;
  rules: RuleSettings;
  read: () => Snapshot | null;
  actuator: Actuator;
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

  constructor(private readonly opts: ReflexOptions) {}

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
    const { actuator, rules, read, everyTicks } = this.opts;
    const snapshot = read();
    if (!snapshot) return;

    if (this.override && this.ticks >= this.override.expiresAtTick) this.override = null;
    const next = this.override?.intent ?? decideByRules(snapshot, rules, this.current);

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

  private apply(intent: Intent): void {
    const { actuator } = this.opts;
    if (intent.tactic === 'engage' && intent.targetId !== undefined) {
      actuator.engage(intent.targetId);
    } else if (intent.tactic === 'retreat' && intent.targetId !== undefined) {
      actuator.retreatFrom(intent.targetId);
    } else {
      actuator.stop();
    }
  }

  /** Stop all actions, e.g. on disconnect. */
  dispose(): void {
    this.override = null;
    this.current = IDLE;
    try {
      this.opts.actuator.stop();
    } catch (err) {
      this.opts.onError?.(err);
    }
  }
}
