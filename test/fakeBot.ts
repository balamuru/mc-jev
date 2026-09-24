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

/** Records what the reflex layer asked it to do. */
export class FakeActuator {
  calls: string[] = [];
  ticks: number[] = [];
  engage = vi.fn((id: number) => void this.calls.push(`engage ${id}`));
  retreatFrom = vi.fn((id: number) => void this.calls.push(`retreat ${id}`));
  stop = vi.fn(() => void this.calls.push('stop'));
  tick = vi.fn((n: number) => void this.ticks.push(n));
}
