import type { Vec3Like } from './perception/types.js';

/**
 * What a bot is currently trying to do. Set by the modes and rules, or by Jev; the reflex layer
 * turns it into movement and attacks.
 *
 * - `engage` / `retreat`: fight or flee from the entity `targetId`.
 * - `follow`: stay close to the entity `targetId` (the owner).
 * - `goto`: walk to `position`.
 */
export type Tactic = 'idle' | 'engage' | 'retreat' | 'follow' | 'goto';

export interface Intent {
  tactic: Tactic;
  /** Entity id to fight, flee from or follow. */
  targetId?: number;
  /** Where to walk, for `goto`. */
  position?: Vec3Like;
  /** Short explanation, used in logs. */
  reason: string;
}

export const IDLE: Intent = { tactic: 'idle', reason: 'no threats' };

const samePosition = (a?: Vec3Like, b?: Vec3Like) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);

/** True when applying `b` would change what the bot does compared to `a`. */
export function intentChanged(a: Intent, b: Intent): boolean {
  return (
    a.tactic !== b.tactic || a.targetId !== b.targetId || !samePosition(a.position, b.position)
  );
}
