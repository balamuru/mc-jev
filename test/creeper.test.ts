import { describe, expect, it } from 'vitest';
import { CREEPER_SAFE_BLOCKS, creeperStep, type CreeperInput } from '../src/reflex/creeper.js';

const step = (over: Partial<CreeperInput>) =>
  creeperStep({ dist: 10, ready: true, reach: 3, backingOff: false, ...over });

describe('creeperStep', () => {
  it('closes in when the weapon is ready', () => {
    expect(step({ dist: 10 })).toEqual({ move: 'close', attack: false, backingOff: false });
    expect(step({ dist: 4 })).toMatchObject({ move: 'close', attack: false });
  });

  it('swings once in reach, then backs off', () => {
    expect(step({ dist: 2.5 })).toEqual({ move: 'back', attack: true, backingOff: true });
  });

  it('keeps backing off until clear of the blast, even once the weapon is ready', () => {
    expect(step({ dist: 2.5, backingOff: true })).toEqual({
      move: 'back',
      attack: false,
      backingOff: true,
    });
    expect(step({ dist: CREEPER_SAFE_BLOCKS - 0.1, backingOff: true, ready: true }).move).toBe(
      'back',
    );
  });

  it('closes in again once clear and ready', () => {
    expect(step({ dist: CREEPER_SAFE_BLOCKS + 0.5, backingOff: true })).toEqual({
      move: 'close',
      attack: false,
      backingOff: false,
    });
  });

  it('waits for the weapon out of the blast, never inside it', () => {
    expect(step({ dist: 5, ready: false })).toMatchObject({ move: 'back', attack: false });
    expect(step({ dist: 9, ready: false })).toMatchObject({ move: 'hold', attack: false });
  });
});
