import type { Snapshot } from '../perception/types.js';

/**
 * Whether eating should be held off. Eating slows the bot and cancels its sprint, so it must not
 * happen with a hostile close, even one behind a wall.
 */
export function shouldPauseEating(snapshot: Snapshot, noEatRadiusBlocks: number): boolean {
  return snapshot.entities.some((e) => e.category === 'hostile' && e.dist <= noEatRadiusBlocks);
}
