import { describe, expect, it } from 'vitest';
import { shouldPauseEating } from '../src/reflex/eating.js';
import { mob, snap } from './fixtures.js';

describe('shouldPauseEating', () => {
  it('is false with nothing around', () => {
    expect(shouldPauseEating(snap(20, []), 10)).toBe(false);
  });

  it('is true when a hostile is within the radius, inclusive', () => {
    expect(shouldPauseEating(snap(20, [mob(1, 10)]), 10)).toBe(true);
    expect(shouldPauseEating(snap(20, [mob(1, 3)]), 10)).toBe(true);
  });

  it('is false when the hostile is farther away', () => {
    expect(shouldPauseEating(snap(20, [mob(1, 10.1)]), 10)).toBe(false);
  });

  it('counts hostiles it cannot see, since they may be just behind a wall', () => {
    expect(shouldPauseEating(snap(20, [mob(1, 4, { visible: false })]), 10)).toBe(true);
  });

  it('ignores passive animals, players and other mobs', () => {
    const near = [
      mob(1, 3, { category: 'passive', kind: 'cow' }),
      mob(2, 3, { category: 'player', kind: 'Steve' }),
      mob(3, 3, { category: 'other', kind: 'villager' }),
    ];
    expect(shouldPauseEating(snap(20, near), 10)).toBe(false);
  });

  it('is off entirely with a radius of 0 and no adjacent hostile', () => {
    expect(shouldPauseEating(snap(20, [mob(1, 1)]), 0)).toBe(false);
  });
});
