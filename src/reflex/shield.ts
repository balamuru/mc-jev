/**
 * When to hold up a shield. In Java Edition a raised shield blocks melee hits, arrows and most of
 * a creeper blast from the front, but the bot cannot attack while blocking and walks at a crawl.
 * So the shield goes up between swings and against specific dangers, and always comes down for a
 * ready swing or a chase. Pure, so the timing is unit-tested without a server.
 */

/** Melee threats this close are worth blocking between swings. */
export const SHIELD_MELEE_RANGE_BLOCKS = 4;
/** A creeper this close may explode; block it. */
export const SHIELD_CREEPER_RANGE_BLOCKS = 4;
/** Archers within this range can hit the bot. */
export const SHIELD_RANGED_RANGE_BLOCKS = 16;
/** Beyond this distance to its target the bot is chasing, and blocking would slow it down. */
export const CHASE_DISTANCE_BLOCKS = 4;
/** Feet-to-feet reach for a melee swing (matches the actuator). */
export const SHIELD_REACH_BLOCKS = 3;

export interface ShieldInput {
  /** A shield is in the off-hand. */
  hasShield: boolean;
  /** The shield is on cooldown, e.g. after an axe hit. */
  disabled: boolean;
  /** The bot is fighting (engage intent). It never blocks while fleeing, following or idle. */
  engaging: boolean;
  /** Distance to the target it is fighting, if any. */
  targetDist: number | null;
  /** The weapon has recharged, so a swing is due as soon as the target is in reach. */
  swingReady: boolean;
  /** Distance to the nearest melee hostile (the target included), if any. */
  nearestMeleeDist: number | null;
  nearestCreeperDist: number | null;
  nearestRangedDist: number | null;
}

export function shouldBlock(i: ShieldInput): boolean {
  if (!i.hasShield || i.disabled || !i.engaging) return false;

  // A ready swing always wins: blocking would stop it.
  if (i.swingReady && i.targetDist !== null && i.targetDist <= SHIELD_REACH_BLOCKS) return false;

  // A creeper close by: block even while closing in, the blast is the bigger danger.
  if (i.nearestCreeperDist !== null && i.nearestCreeperDist <= SHIELD_CREEPER_RANGE_BLOCKS) {
    return true;
  }

  // Chasing: keep moving at full speed.
  if (i.targetDist !== null && i.targetDist > CHASE_DISTANCE_BLOCKS) return false;

  if (i.nearestMeleeDist !== null && i.nearestMeleeDist <= SHIELD_MELEE_RANGE_BLOCKS) return true;
  if (i.nearestRangedDist !== null && i.nearestRangedDist <= SHIELD_RANGED_RANGE_BLOCKS)
    return true;
  return false;
}

/** True when a `set_cooldown` packet's group is the shield's (e.g. `minecraft:shield`). */
export function isShieldCooldown(group: unknown): boolean {
  return typeof group === 'string' && /(^|:)shield$/.test(group);
}
