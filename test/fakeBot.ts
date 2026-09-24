import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { BotLike } from '../src/agent/mineflayerAdapter.js';
import type { EntityLike, ItemLike } from '../src/perception/types.js';

/** A stand-in for a Mineflayer bot: an EventEmitter with just the fields mc-jev reads. */
export class FakeBot extends EventEmitter implements BotLike {
  entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0, onGround: true, isInWater: false };
  entities: Record<string, EntityLike> = {};
  health = 20;
  food = 20;
  heldItem: ItemLike | null = null;
  inventory: { items(): ItemLike[]; slots: Array<ItemLike | null | undefined> } = {
    items: () => [],
    slots: [],
  };
  world = { raycast: vi.fn((): unknown => null) };
  quit = vi.fn();

  constructor() {
    super();
    this.entities['0'] = this.entity as unknown as EntityLike;
  }
}
