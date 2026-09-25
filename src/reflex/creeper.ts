/**
 * Melee against a creeper: hit and back off. A creeper starts its fuse once its target is within
 * 3 blocks, and the fuse only winds back down while the target is more than 7 blocks away. A bot
 * that stands and trades blows next to it is still there when it explodes, and a bot that sprints
 * in from afar arrives right beside it. So: close in, swing once, back away past 7 blocks while
 * the weapon recharges, and close in again.
 */

/** Beyond this distance a creeper's fuse winds down (vanilla: 7 blocks), with a margin. */
export const CREEPER_SAFE_BLOCKS = 7.5;

export type CreeperMove = 'close' | 'back' | 'hold';

export interface CreeperInput {
  dist: number;
  /** The weapon has recharged. */
  ready: boolean;
  /** Distance within which a swing connects. */
  reach: number;
  /** Still getting clear after the last swing. */
  backingOff: boolean;
}

export interface CreeperStep {
  move: CreeperMove;
  attack: boolean;
  /** Whether the bot is still getting clear, for the next step. */
  backingOff: boolean;
}

export function creeperStep({ dist, ready, reach, backingOff }: CreeperInput): CreeperStep {
  if (backingOff) {
    if (dist < CREEPER_SAFE_BLOCKS) return { move: 'back', attack: false, backingOff: true };
    backingOff = false; // clear: the fuse is winding down
  }
  if (dist <= reach && ready) return { move: 'back', attack: true, backingOff: true };
  // Never wait for the weapon within the blast; wait out of it.
  if (!ready)
    return { move: dist < CREEPER_SAFE_BLOCKS ? 'back' : 'hold', attack: false, backingOff };
  return { move: 'close', attack: false, backingOff };
}
