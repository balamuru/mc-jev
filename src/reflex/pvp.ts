/**
 * Fighting another player is different from fighting a mob: a player dodges, and a well-timed
 * jump makes a hit land as a critical (about 50% more damage). These pure helpers decide the
 * timing; the actuator carries them out.
 */

export interface PvpInput {
  /** Distance to the target, in blocks. */
  dist: number;
  onGround: boolean;
  /** Vertical velocity in blocks per tick; negative while falling. */
  velocityY: number;
  ticksSinceAttack: number;
  /** Ticks needed between full-strength swings for the current weapon. */
  cooldownTicks: number;
  /** Ticks since the bot last started a jump. */
  ticksSinceJump: number;
  /** Ticks the swing has been ready and waiting for a critical-hit chance. */
  ticksWaitingForCrit: number;
  /**
   * Only ever hit as a critical, never "anyway" after waiting: set when a ground swing would sweep
   * into someone who must not be hurt.
   */
  mustCrit?: boolean;
}

export interface PvpAction {
  jump: boolean;
  attack: boolean;
  /** Sprinting cancels critical hits, so it is off while in reach. */
  sprint: boolean;
}

export const PVP_REACH_BLOCKS = 3.0;
/** Do not wait longer than this for a critical-hit chance; just hit. */
export const MAX_CRIT_WAIT_TICKS = 10;
/** A jump lasts about this long, so do not start another sooner. */
export const JUMP_TICKS = 12;

/** Decide this tick's jump, swing and sprint against a player. */
export function pvpAction(input: PvpInput): PvpAction {
  const inReach = input.dist <= PVP_REACH_BLOCKS;
  if (!inReach) return { jump: false, attack: false, sprint: true };

  const ready = input.ticksSinceAttack >= input.cooldownTicks;
  if (!ready) return { jump: false, attack: false, sprint: false };

  const falling = !input.onGround && input.velocityY < -0.05;
  if (falling) return { jump: false, attack: true, sprint: false }; // a critical hit
  if (input.onGround && input.ticksSinceJump >= JUMP_TICKS) {
    return { jump: true, attack: false, sprint: false }; // go up, then hit on the way down
  }
  // Rising, or a jump just started: hold off, unless the wait has gone on too long.
  const giveUpWaiting = !input.mustCrit && input.ticksWaitingForCrit >= MAX_CRIT_WAIT_TICKS;
  return { jump: false, attack: giveUpWaiting, sprint: false };
}

export type StrafeDirection = 'left' | 'right';

/** Side-steps back and forth, at irregular intervals, so a player has a harder time hitting the bot. */
export class Strafer {
  private direction: StrafeDirection = 'left';
  private ticksLeft = 0;

  constructor(
    private readonly minTicks = 8,
    private readonly maxTicks = 20,
    private readonly rng: () => number = Math.random,
  ) {}

  /** Advance one step (`elapsedTicks` game ticks) and return the direction to strafe. */
  next(elapsedTicks = 1): StrafeDirection {
    this.ticksLeft -= elapsedTicks;
    if (this.ticksLeft <= 0) {
      this.direction = this.direction === 'left' ? 'right' : 'left';
      this.ticksLeft = this.minTicks + Math.floor(this.rng() * (this.maxTicks - this.minTicks + 1));
    }
    return this.direction;
  }

  reset(): void {
    this.ticksLeft = 0;
  }
}
