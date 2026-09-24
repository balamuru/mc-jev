import type { ItemLike } from '../perception/types.js';

const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];

/** Higher is better. Swords outrank axes of the same tier, and any tier of sword outranks axes. */
function weaponScore(name: string): number {
  const tier = TIERS.findIndex((t) => name.startsWith(`${t}_`));
  if (tier < 0) return -1;
  if (name.endsWith('_sword')) return 100 + tier;
  if (name.endsWith('_axe')) return tier;
  return -1;
}

/** The best melee weapon in the inventory, or null if there is none. */
export function bestWeapon<T extends ItemLike>(items: T[]): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const item of items) {
    const score = weaponScore(item.name);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/** Attack speed in attacks per second (Java Edition 1.9+ combat). */
export function attackSpeed(itemName: string | null | undefined): number {
  if (!itemName) return 4; // bare hand
  if (itemName.endsWith('_sword')) return 1.6;
  if (itemName.endsWith('_axe')) {
    return itemName.startsWith('wooden_') || itemName.startsWith('stone_')
      ? 0.8
      : itemName.startsWith('iron_')
        ? 0.9
        : 1.0;
  }
  if (itemName === 'trident') return 1.1;
  return 4;
}

/** Game ticks to wait between attacks so each swing does full damage. */
export function cooldownTicks(itemName: string | null | undefined): number {
  return Math.ceil(20 / attackSpeed(itemName));
}

/** Melee damage of a fully charged hit (Java Edition), before the target's armor. */
export function weaponDamage(itemName: string | null | undefined): number {
  if (!itemName) return 1;
  const tier = TIERS.findIndex((t) => itemName.startsWith(`${t}_`));
  if (tier >= 0 && itemName.endsWith('_sword')) return [4, 4, 5, 6, 7, 8][tier] as number;
  if (tier >= 0 && itemName.endsWith('_axe')) return [7, 7, 9, 9, 9, 10][tier] as number;
  if (itemName === 'trident') return 9;
  return 1;
}
