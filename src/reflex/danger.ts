import type { EntitySummary } from '../perception/types.js';
import { bestWeapon, cooldownTicks, weaponDamage } from './weapons.js';

/**
 * Rough per-mob combat numbers at Normal difficulty, used to guess whether a fight is winnable.
 *
 * - `dps`: damage per second before armor while it is attacking.
 * - `burst`: expected one-off damage before armor (a creeper's explosion, averaged over the
 *   chance that it goes off).
 * - `speed`: blocks per second it closes in at; 0 means it attacks from range, with no approach.
 * - `engagement`: the share of its time alive that it actually lands damage. Melee mobs get
 *   knocked back, miss and wait out cooldowns, so they land far less than their raw dps.
 *
 * Calibrated against `npm run benchmark:survival` (see docs/survival-benchmark.md). They are
 * estimates, not game data: re-run the benchmark before changing them.
 */
export interface MobStats {
  hp: number;
  dps: number;
  burst: number;
  speed: number;
  engagement: number;
}

const melee = (hp: number, dps: number, speed = 4): MobStats => ({
  hp,
  dps,
  burst: 0,
  speed,
  engagement: 0.25,
});
const ranged = (hp: number, dps: number): MobStats => ({
  hp,
  dps,
  burst: 0,
  speed: 0,
  engagement: 1,
});

export const MOB_STATS: Record<string, MobStats> = {
  zombie: melee(20, 3),
  husk: melee(20, 3),
  drowned: melee(20, 3),
  zombie_villager: melee(20, 3),
  spider: melee(16, 2, 5),
  cave_spider: melee(12, 2, 5),
  slime: melee(16, 2, 3),
  vindicator: melee(24, 6),
  ravager: melee(100, 8),
  wither_skeleton: melee(20, 5),
  skeleton: ranged(20, 2),
  stray: ranged(20, 2),
  pillager: ranged(24, 3),
  witch: ranged(26, 2),
  blaze: ranged(20, 4),
  creeper: { hp: 20, dps: 0, burst: 8, speed: 4, engagement: 1 },
};

export const DEFAULT_MOB: MobStats = melee(20, 3);

/** A player hits with whatever they hold, and lands about half their swings while dodging. */
export function playerStats(held: string | null): MobStats {
  const hitsPerSecond = 20 / cooldownTicks(held);
  return {
    hp: 20,
    dps: weaponDamage(held) * hitsPerSecond * 0.5,
    burst: 0,
    speed: 5,
    engagement: 0.6,
  };
}

/**
 * Mobs the game classes as hostile that leave you alone until provoked. Attacking them starts a
 * fight the bot does not need (an enderman has 40 HP and hits for 7).
 */
export const NEUTRAL_MOBS = new Set([
  'enderman',
  'zombified_piglin',
  'piglin',
  'iron_golem',
  'bee',
  'wolf',
  'polar_bear',
]);

/** Armor points by material for [helmet, chestplate, leggings, boots]. */
const ARMOR_POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
};
const SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];

export function armorPoints(armor: string[]): number {
  let total = 0;
  for (const name of armor) {
    if (name === 'turtle_helmet') {
      total += 2;
      continue;
    }
    const [material, slot] = [name.slice(0, name.indexOf('_')), name.slice(name.indexOf('_') + 1)];
    const points = ARMOR_POINTS[material]?.[SLOTS.indexOf(slot)];
    if (points !== undefined) total += points;
  }
  return total;
}

/** Fraction of damage armor absorbs: 4% per point, at most 80%. */
export function armorReduction(points: number): number {
  return Math.min(0.8, points * 0.04);
}

/** Share of swings that connect while chasing and being knocked around. */
export const HIT_EFFICIENCY = 0.85;
/** A creeper explodes about this long after it ignites, unless it is killed first. */
const CREEPER_FUSE_SECONDS = 1.5;

export function mobStats(kind: string): MobStats {
  return MOB_STATS[kind] ?? DEFAULT_MOB;
}

export interface Gear {
  armor: string[];
  weapon: string | null;
}

/** Inventory entries look like "iron_swordx1"; the best weapon in them, or null. */
export function weaponFromInventory(inventory: string[], held: string | null): string | null {
  const names = inventory.map((entry) => ({ name: entry.replace(/x\d+$/, ''), count: 1 }));
  if (held) names.push({ name: held, count: 1 });
  return bestWeapon(names)?.name ?? null;
}

export interface FightEstimate {
  /** Damage the bot is expected to take while killing every threat, after armor. */
  expectedDamage: number;
  /** Seconds to kill them all, one after another. */
  secondsToKill: number;
}

/**
 * Guess how a fight would go. The bot kills threats nearest first; each threat only starts to
 * matter once it has reached the bot, and then lands `dps * engagement` until it is dead. Pure
 * and approximate: it exists to spot fights that are clearly not worth taking.
 */
export function estimateFight(threats: EntitySummary[], gear: Gear): FightEstimate {
  const myDps = weaponDamage(gear.weapon) * (20 / cooldownTicks(gear.weapon)) * HIT_EFFICIENCY;
  const reduction = armorReduction(armorPoints(gear.armor));

  let t = 0;
  let damage = 0;
  for (const threat of [...threats].sort((a, b) => a.dist - b.dist)) {
    const stats = threat.category === 'player' ? playerStats(threat.held) : mobStats(threat.kind);
    const killSeconds = stats.hp / myDps;
    t += killSeconds;
    const arrival = stats.speed > 0 ? threat.dist / stats.speed : 0;
    const exposure = Math.max(0, t - arrival);
    const burst = killSeconds > CREEPER_FUSE_SECONDS ? stats.burst : 0;
    damage += (stats.dps * stats.engagement * exposure + burst) * (1 - reduction);
  }
  return { expectedDamage: damage, secondsToKill: t };
}
