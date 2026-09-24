import type { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { buildSnapshot } from '../perception/observe.js';
import type {
  EntityLike,
  ItemLike,
  PerceptionOptions,
  Snapshot,
  Vec3Like,
} from '../perception/types.js';

/**
 * The slice of a Mineflayer bot that mc-jev uses. Declared structurally so agents can be tested
 * with fakes; `createMineflayerBot` casts the real bot to this at the single boundary.
 */
export interface BotLike extends EventEmitter {
  entity: {
    position: Vec3Like;
    yaw: number;
    onGround: boolean;
    isInWater?: boolean;
  };
  entities: Record<string, EntityLike>;
  /** Players the server has told the bot about; `entity` is set while they are close enough to track. */
  players: Record<string, { entity?: EntityLike | null }>;
  health: number;
  food: number;
  heldItem: ItemLike | null;
  inventory: {
    items(): ItemLike[];
    /** Armor lives in slots 5 (head) to 8 (feet). */
    slots: Array<ItemLike | null | undefined>;
  };
  world: {
    /** First solid block along the ray, or null. */
    raycast(from: Vec3, direction: Vec3, range: number): unknown;
  };
  quit(reason?: string): void;
  chat(message: string): void;
}

const ARMOR_SLOTS = [5, 6, 7, 8];
const OFFHAND_SLOT = 45;

/** Read the bot's current perception snapshot. */
export function readSnapshot(
  bot: BotLike,
  options: Partial<PerceptionOptions> = {},
  now: number = Date.now(),
  ownerName?: string,
  hostilePlayers?: ReadonlySet<string>,
): Snapshot {
  const self = bot.entity;
  return buildSnapshot(
    {
      now,
      self: {
        position: self.position,
        yaw: self.yaw,
        health: bot.health,
        food: bot.food,
        onGround: self.onGround,
        inWater: self.isInWater ?? false,
        heldItem: bot.heldItem,
        armor: ARMOR_SLOTS.flatMap((slot) => bot.inventory.slots[slot]?.name ?? []),
        offhand: bot.inventory.slots[OFFHAND_SLOT] ?? null,
        inventory: bot.inventory.items(),
      },
      // Exclude the bot itself; the snapshot already describes it.
      entities: Object.values(bot.entities).filter((e) => e !== (self as unknown)),
      owner: ownerName ? findPlayer(bot, ownerName) : null,
      hostilePlayers,
      hasLineOfSight: (from, to) => {
        const origin = new Vec3(from.x, from.y, from.z);
        const delta = new Vec3(to.x - from.x, to.y - from.y, to.z - from.z);
        const dist = delta.norm();
        if (dist === 0) return true;
        return bot.world.raycast(origin, delta.scaled(1 / dist), dist) == null;
      },
    },
    options,
  );
}

/** A player's entity by name (any case), if the bot can currently see them. */
function findPlayer(bot: BotLike, name: string): EntityLike | null {
  const wanted = name.toLowerCase();
  for (const [username, player] of Object.entries(bot.players)) {
    if (username.toLowerCase() === wanted) return player.entity ?? null;
  }
  return null;
}
