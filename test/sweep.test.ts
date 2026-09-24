import { describe, expect, it } from 'vitest';
import {
  SWEEP_DANGER_BLOCKS,
  SWEEP_DANGER_HEIGHT,
  sweepEndangers,
  weaponSweeps,
} from '../src/reflex/sweep.js';

const at = (x: number, y = 64, z = 0) => ({ x, y, z });

describe('weaponSweeps', () => {
  it('is true only for swords', () => {
    expect(weaponSweeps('iron_sword')).toBe(true);
    expect(weaponSweeps('netherite_sword')).toBe(true);
    expect(weaponSweeps('diamond_axe')).toBe(false);
    expect(weaponSweeps('bow')).toBe(false);
    expect(weaponSweeps(null)).toBe(false);
    expect(weaponSweeps(undefined)).toBe(false);
  });
});

describe('sweepEndangers', () => {
  const target = at(10);

  it('flags a player right next to the target', () => {
    expect(sweepEndangers(target, [at(11)])).toBe(true);
    expect(sweepEndangers(target, [at(10 + SWEEP_DANGER_BLOCKS)])).toBe(true);
  });

  it('measures horizontally, in both x and z', () => {
    expect(sweepEndangers(target, [{ x: 11.2, y: 64, z: 1.2 }])).toBe(true);
    expect(sweepEndangers(target, [{ x: 11.5, y: 64, z: 1.5 }])).toBe(false);
  });

  it('ignores players farther away, or well above or below', () => {
    expect(sweepEndangers(target, [at(10 + SWEEP_DANGER_BLOCKS + 0.1)])).toBe(false);
    expect(sweepEndangers(target, [at(10, 64 + SWEEP_DANGER_HEIGHT + 0.1)])).toBe(false);
  });

  it('is false with nobody around, and true if any one of several is close', () => {
    expect(sweepEndangers(target, [])).toBe(false);
    expect(sweepEndangers(target, [at(30), at(10.5)])).toBe(true);
  });
});
