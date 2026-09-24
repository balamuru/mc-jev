import { describe, expect, it } from 'vitest';
import {
  JUMP_TICKS,
  MAX_CRIT_WAIT_TICKS,
  PVP_REACH_BLOCKS,
  Strafer,
  pvpAction,
  type PvpInput,
} from '../src/reflex/pvp.js';

const base: PvpInput = {
  dist: 2,
  onGround: true,
  velocityY: 0,
  ticksSinceAttack: 100,
  cooldownTicks: 13,
  ticksSinceJump: 100,
  ticksWaitingForCrit: 0,
};
const act = (over: Partial<PvpInput> = {}) => pvpAction({ ...base, ...over });

describe('pvpAction', () => {
  it('keeps sprinting to close the distance, and does nothing else', () => {
    expect(act({ dist: PVP_REACH_BLOCKS + 0.1 })).toEqual({
      jump: false,
      attack: false,
      sprint: true,
    });
  });

  it('waits for the weapon to recharge without sprinting', () => {
    expect(act({ ticksSinceAttack: 5 })).toEqual({ jump: false, attack: false, sprint: false });
  });

  it('jumps when the swing is ready and the bot is on the ground', () => {
    expect(act()).toEqual({ jump: true, attack: false, sprint: false });
  });

  it('hits on the way down, for a critical', () => {
    expect(act({ onGround: false, velocityY: -0.3 })).toEqual({
      jump: false,
      attack: true,
      sprint: false,
    });
  });

  it('holds off while rising, and does not start a second jump too soon', () => {
    expect(act({ onGround: false, velocityY: 0.4 }).attack).toBe(false);
    const soon = act({ ticksSinceJump: JUMP_TICKS - 1 });
    expect(soon.jump).toBe(false);
    expect(soon.attack).toBe(false);
  });

  it('hits anyway after waiting too long for a critical', () => {
    const late = act({ ticksSinceJump: 1, ticksWaitingForCrit: MAX_CRIT_WAIT_TICKS });
    expect(late).toEqual({ jump: false, attack: true, sprint: false });
  });

  it('with mustCrit, keeps waiting for a critical instead of hitting from the ground', () => {
    const waited = act({ ticksSinceJump: 1, ticksWaitingForCrit: 100, mustCrit: true });
    expect(waited.attack).toBe(false);
    expect(act({ onGround: false, velocityY: -0.3, mustCrit: true }).attack).toBe(true);
    expect(act({ mustCrit: true }).jump).toBe(true);
  });

  it('never hits from outside reach', () => {
    expect(act({ dist: 4, onGround: false, velocityY: -1 }).attack).toBe(false);
  });
});

describe('Strafer', () => {
  it('alternates direction, holding each for a random number of ticks in range', () => {
    const rolls = [0, 0.999, 0.5];
    let i = 0;
    const s = new Strafer(8, 20, () => rolls[i++ % rolls.length]!);
    const seen: string[] = [];
    let last = '';
    const holds: number[] = [];
    let run = 0;
    for (let t = 0; t < 80; t++) {
      const d = s.next();
      if (d !== last) {
        if (last) holds.push(run);
        seen.push(d);
        last = d;
        run = 0;
      }
      run++;
    }
    expect(seen.slice(0, 4)).toEqual(['right', 'left', 'right', 'left']);
    for (const h of holds) {
      expect(h).toBeGreaterThanOrEqual(8);
      expect(h).toBeLessThanOrEqual(20);
    }
  });

  it('counts elapsed ticks when stepped less often than every tick', () => {
    const s = new Strafer(10, 10, () => 0);
    expect(s.next(1)).toBe('right');
    expect(s.next(5)).toBe('right');
    expect(s.next(5)).toBe('left'); // 10 ticks have passed
  });

  it('starts a fresh interval after a reset', () => {
    const s = new Strafer(10, 10, () => 0);
    s.next();
    s.reset();
    expect(s.next()).toBe('left');
  });
});
