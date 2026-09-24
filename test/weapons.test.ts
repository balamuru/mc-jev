import { describe, expect, it } from 'vitest';
import { attackSpeed, bestWeapon, cooldownTicks } from '../src/reflex/weapons.js';

const item = (name: string) => ({ name, count: 1 });

describe('bestWeapon', () => {
  it('returns null when there is no weapon', () => {
    expect(bestWeapon([])).toBeNull();
    expect(bestWeapon([item('apple'), item('iron_pickaxe'), item('bow')])).toBeNull();
  });

  it('prefers the highest tier of sword', () => {
    const inv = [item('stone_sword'), item('diamond_sword'), item('iron_sword')];
    expect(bestWeapon(inv)?.name).toBe('diamond_sword');
    expect(bestWeapon([item('golden_sword'), item('wooden_sword')])?.name).toBe('golden_sword');
    expect(bestWeapon([item('netherite_sword'), item('diamond_sword')])?.name).toBe(
      'netherite_sword',
    );
  });

  it('prefers any sword over an axe, and the best axe when there is no sword', () => {
    expect(bestWeapon([item('netherite_axe'), item('wooden_sword')])?.name).toBe('wooden_sword');
    expect(bestWeapon([item('stone_axe'), item('diamond_axe')])?.name).toBe('diamond_axe');
  });

  it('ignores tools that are not weapons', () => {
    expect(bestWeapon([item('diamond_pickaxe'), item('wooden_axe')])?.name).toBe('wooden_axe');
  });
});

describe('attack timing', () => {
  it('knows attack speeds', () => {
    expect(attackSpeed(null)).toBe(4);
    expect(attackSpeed('iron_sword')).toBe(1.6);
    expect(attackSpeed('wooden_axe')).toBe(0.8);
    expect(attackSpeed('iron_axe')).toBe(0.9);
    expect(attackSpeed('diamond_axe')).toBe(1.0);
    expect(attackSpeed('trident')).toBe(1.1);
    expect(attackSpeed('stick')).toBe(4);
  });

  it('converts to ticks between full-damage swings', () => {
    expect(cooldownTicks(undefined)).toBe(5); // fist
    expect(cooldownTicks('diamond_sword')).toBe(13); // 12.5 rounded up
    expect(cooldownTicks('stone_axe')).toBe(25);
    expect(cooldownTicks('netherite_axe')).toBe(20);
  });
});
