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
}

const ARMOR_SLOTS = [5, 6, 7, 8];

/** Read the bot's current perception snapshot. */
export function readSnapshot(
  bot: BotLike,
  options: Partial<PerceptionOptions> = {},
  now: number = Date.now(),
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
        inventory: bot.inventory.items(),
      },
      // Exclude the bot itself; the snapshot already describes it.
      entities: Object.values(bot.entities).filter((e) => e !== (self as unknown)),
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
