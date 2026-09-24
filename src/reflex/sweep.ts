import type { Vec3Like } from '../perception/types.js';

/**
 * A full-strength sword swing made on the ground also "sweeps": it hurts every other entity
 * within about a block of the target. That would let the bot hurt its owner, an ally or a
 * bystander standing next to whatever it is fighting. Critical hits (made while falling) and
 * sprinting hits do not sweep, so when someone is at risk the bot only swings as a critical hit.
 */

/** Horizontal distance from the target within which another player could be caught by a sweep. */
export const SWEEP_DANGER_BLOCKS = 2.0;
/** ...and vertical distance. */
export const SWEEP_DANGER_HEIGHT = 1.5;

/** Only swords sweep. */
export function weaponSweeps(itemName: string | null | undefined): boolean {
  return !!itemName && itemName.endsWith('_sword');
}

/** True when any of `others` stands close enough to `target` to be hit by a sweep. */
export function sweepEndangers(target: Vec3Like, others: Vec3Like[]): boolean {
  return others.some(
    (p) =>
      Math.hypot(p.x - target.x, p.z - target.z) <= SWEEP_DANGER_BLOCKS &&
      Math.abs(p.y - target.y) <= SWEEP_DANGER_HEIGHT,
  );
}
