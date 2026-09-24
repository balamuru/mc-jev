import { describe, expect, it } from 'vitest';
import {
  HIT_EFFICIENCY,
  armorPoints,
  armorReduction,
  estimateFight,
  mobStats,
  weaponFromInventory,
} from '../src/reflex/danger.js';
import { weaponDamage } from '../src/reflex/weapons.js';
import { IRON_ARMOR, mob } from './fixtures.js';

describe('armorPoints and armorReduction', () => {
  it('sums points by material and slot', () => {
    expect(armorPoints(IRON_ARMOR)).toBe(15);
    expect(armorPoints(['leather_helmet', 'leather_boots'])).toBe(2);
    expect(
      armorPoints(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']),
    ).toBe(20);
    expect(armorPoints(['turtle_helmet'])).toBe(2);
  });

  it('ignores unknown items', () => {
    expect(armorPoints(['elytra', 'shield', 'mystery_helmet'])).toBe(0);
    expect(armorPoints([])).toBe(0);
  });

  it('absorbs 4% per point up to 80%', () => {
    expect(armorReduction(0)).toBe(0);
    expect(armorReduction(15)).toBeCloseTo(0.6);
    expect(armorReduction(30)).toBe(0.8);
  });
});

describe('weaponDamage', () => {
  it.each([
    [null, 1],
    ['wooden_sword', 4],
    ['iron_sword', 6],
    ['diamond_sword', 7],
    ['netherite_sword', 8],
    ['stone_axe', 9],
    ['netherite_axe', 10],
    ['trident', 9],
    ['stick', 1],
  ])('%s hits for %d', (name, damage) => expect(weaponDamage(name)).toBe(damage));
});

describe('weaponFromInventory', () => {
  it('finds the best weapon among inventory entries and the held item', () => {
    expect(weaponFromInventory(['applex3', 'stone_swordx1', 'diamond_swordx1'], null)).toBe(
      'diamond_sword',
    );
    expect(weaponFromInventory(['stone_swordx1'], 'iron_sword')).toBe('iron_sword');
    expect(weaponFromInventory(['applex3'], null)).toBeNull();
  });
});

describe('mobStats', () => {
  it('knows common mobs and falls back for unknown ones', () => {
    expect(mobStats('zombie')).toMatchObject({ hp: 20, dps: 3, speed: 4 });
    expect(mobStats('creeper').burst).toBeGreaterThan(0);
    expect(mobStats('something_new')).toEqual(mobStats('zombie'));
  });

  it('models skeletons as ranged and zombies as melee', () => {
    expect(mobStats('skeleton')).toMatchObject({ speed: 0, engagement: 1 });
    expect(mobStats('zombie').engagement).toBeLessThan(1);
  });
});

describe('estimateFight', () => {
  const iron = { armor: IRON_ARMOR, weapon: 'iron_sword' };
  const swordDps = 6 * (20 / 13) * HIT_EFFICIENCY;
  const killTime = 20 / swordDps;
  const zombie = mobStats('zombie');

  it('is zero with no threats', () => {
    expect(estimateFight([], iron)).toEqual({ expectedDamage: 0, secondsToKill: 0 });
  });

  it('counts a zombie only from the moment it arrives, at its engaged damage rate, after armor', () => {
    const arrival = 5 / zombie.speed;
    const r = estimateFight([mob(1, 5)], iron);
    expect(r.secondsToKill).toBeCloseTo(killTime);
    expect(r.expectedDamage).toBeCloseTo(
      zombie.dps * zombie.engagement * (killTime - arrival) * 0.4,
    );
  });

  it('costs nothing from a threat that would be dead before it arrived', () => {
    expect(estimateFight([mob(1, 200)], iron).expectedDamage).toBe(0);
  });

  it('makes later kills cost more because earlier threats keep hitting', () => {
    const one = estimateFight([mob(1, 5)], iron).expectedDamage;
    const three = estimateFight([mob(1, 5), mob(2, 5), mob(3, 5)], iron).expectedDamage;
    expect(three).toBeGreaterThan(one * 3);
    const arrival = 5 / zombie.speed;
    const exposures = [1, 2, 3].map((n) => n * killTime - arrival);
    const expected = exposures.reduce(
      (sum, e) => sum + zombie.dps * zombie.engagement * e * 0.4,
      0,
    );
    expect(three).toBeCloseTo(expected);
  });

  it('is much worse without armor or a weapon', () => {
    const geared = estimateFight([mob(1, 5)], iron).expectedDamage;
    const armorless = estimateFight([mob(1, 5)], {
      armor: [],
      weapon: 'iron_sword',
    }).expectedDamage;
    const bare = estimateFight([mob(1, 5)], { armor: [], weapon: null }).expectedDamage;
    expect(armorless).toBeCloseTo(geared / 0.4);
    expect(bare).toBeGreaterThan(armorless * 3);
  });

  it('counts a ranged mob from the start, whatever its distance', () => {
    const near = estimateFight([mob(1, 3, { kind: 'skeleton' })], iron).expectedDamage;
    const far = estimateFight([mob(1, 15, { kind: 'skeleton' })], iron).expectedDamage;
    expect(near).toBeCloseTo(far);
    expect(near).toBeCloseTo(2 * 1 * killTime * 0.4);
  });

  it('adds a creeper explosion unless the creeper dies before its fuse runs out', () => {
    const creeper = [mob(1, 5, { kind: 'creeper' })];
    expect(estimateFight(creeper, { armor: [], weapon: 'iron_sword' }).expectedDamage).toBeCloseTo(
      8,
    );
    expect(estimateFight(creeper, iron).expectedDamage).toBeCloseTo(3.2);
  });

  it('treats unknown mobs like a zombie', () => {
    const a = estimateFight([mob(1, 5, { kind: 'zombie' })], iron);
    const b = estimateFight([mob(1, 5, { kind: 'mystery_mob' })], iron);
    expect(b).toEqual(a);
  });

  it('kills nearest threats first regardless of input order', () => {
    const a = estimateFight([mob(1, 9, { kind: 'creeper' }), mob(2, 3)], iron);
    const b = estimateFight([mob(2, 3), mob(1, 9, { kind: 'creeper' })], iron);
    expect(a.expectedDamage).toBeCloseTo(b.expectedDamage);
  });

  it('matches what the survival benchmark saw (within a factor of two)', () => {
    // Baseline runs, mobs summoned 8 blocks away, HP lost: 3 zombies with iron gear ~3.1,
    // 2 zombies with a wooden sword and no armor ~4.9, 1 skeleton with iron gear ~2.1.
    const at8 = (n: number) => Array.from({ length: n }, (_, i) => mob(i + 1, 8));
    const three = estimateFight(at8(3), iron).expectedDamage;
    const weak = estimateFight(at8(2), { armor: [], weapon: 'wooden_sword' }).expectedDamage;
    const skeleton = estimateFight([mob(1, 8, { kind: 'skeleton' })], iron).expectedDamage;
    for (const [got, saw] of [
      [three, 3.1],
      [weak, 4.9],
      [skeleton, 2.1],
    ] as const) {
      expect(got).toBeGreaterThan(saw / 2);
      expect(got).toBeLessThan(saw * 2);
    }
  });
});
