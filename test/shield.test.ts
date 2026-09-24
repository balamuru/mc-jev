import { describe, expect, it } from 'vitest';
import {
  CHASE_DISTANCE_BLOCKS,
  SHIELD_CREEPER_RANGE_BLOCKS,
  SHIELD_MELEE_RANGE_BLOCKS,
  SHIELD_RANGED_RANGE_BLOCKS,
  isShieldCooldown,
  shouldBlock,
  type ShieldInput,
} from '../src/reflex/shield.js';

const base: ShieldInput = {
  hasShield: true,
  disabled: false,
  engaging: true,
  targetDist: 2.5,
  swingReady: false,
  nearestMeleeDist: 2.5,
  nearestCreeperDist: null,
  nearestRangedDist: null,
};
const block = (over: Partial<ShieldInput> = {}) => shouldBlock({ ...base, ...over });

describe('shouldBlock', () => {
  it('blocks between swings when a melee threat is close', () => {
    expect(block()).toBe(true);
  });

  it('drops the shield for a ready swing at a target in reach', () => {
    expect(block({ swingReady: true })).toBe(false);
  });

  it('keeps blocking when the swing is ready but the target is just out of reach', () => {
    expect(block({ swingReady: true, targetDist: 3.5, nearestMeleeDist: 3.5 })).toBe(true);
  });

  it('never blocks without a shield, while it is disabled, or when not fighting', () => {
    expect(block({ hasShield: false })).toBe(false);
    expect(block({ disabled: true })).toBe(false);
    expect(block({ engaging: false })).toBe(false);
  });

  it('does not block while chasing a distant target', () => {
    const far = CHASE_DISTANCE_BLOCKS + 1;
    expect(block({ targetDist: far, nearestMeleeDist: far })).toBe(false);
    expect(block({ targetDist: far, nearestMeleeDist: far, nearestRangedDist: 10 })).toBe(false);
  });

  it('blocks a nearby creeper, even while closing in', () => {
    expect(
      block({
        targetDist: 6,
        nearestMeleeDist: null,
        nearestCreeperDist: SHIELD_CREEPER_RANGE_BLOCKS,
      }),
    ).toBe(true);
    expect(block({ targetDist: 6, nearestMeleeDist: null, nearestCreeperDist: 5 })).toBe(false);
  });

  it('still swings at a creeper in reach when the swing is ready', () => {
    expect(block({ swingReady: true, nearestCreeperDist: 2.5, nearestMeleeDist: null })).toBe(
      false,
    );
  });

  it('blocks arrows from an archer in range while fighting up close', () => {
    expect(block({ nearestMeleeDist: null, nearestRangedDist: 12 })).toBe(true);
    expect(
      block({ nearestMeleeDist: null, nearestRangedDist: SHIELD_RANGED_RANGE_BLOCKS + 1 }),
    ).toBe(false);
  });

  it('does not block a melee threat that is not close yet', () => {
    expect(block({ nearestMeleeDist: SHIELD_MELEE_RANGE_BLOCKS + 0.5, targetDist: 3.9 })).toBe(
      false,
    );
  });

  it('does not block with no threats at all', () => {
    expect(block({ targetDist: null, nearestMeleeDist: null })).toBe(false);
  });
});

describe('isShieldCooldown', () => {
  it('recognizes the shield cooldown group with or without a namespace', () => {
    expect(isShieldCooldown('minecraft:shield')).toBe(true);
    expect(isShieldCooldown('shield')).toBe(true);
  });

  it('ignores other groups and junk', () => {
    expect(isShieldCooldown('minecraft:ender_pearl')).toBe(false);
    expect(isShieldCooldown('minecraft:shield_banner')).toBe(false);
    expect(isShieldCooldown(1296)).toBe(false);
    expect(isShieldCooldown(undefined)).toBe(false);
  });
});
