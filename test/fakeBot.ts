import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { BotLike } from '../src/agent/mineflayerAdapter.js';
import type { EntityLike, ItemLike } from '../src/perception/types.js';

/** A stand-in for a Mineflayer bot: an EventEmitter with just the fields mc-jev reads. */
export class FakeBot extends EventEmitter implements BotLike {
  entity = { position: { x: 0, y: 64, z: 0 }, yaw: 0, onGround: true, isInWater: false };
  entities: Record<string, EntityLike> = {};
  players: Record<string, { entity?: EntityLike | null }> = {};
  health = 20;
  food = 20;
  heldItem: ItemLike | null = null;
  inventory: { items(): ItemLike[]; slots: Array<ItemLike | null | undefined> } = {
    items: () => [],
    slots: [],
  };
  world = { raycast: vi.fn((): unknown => null) };
  quit = vi.fn();
  chat = vi.fn();

  /** Give the bot an iron sword and full iron armor, as a typical geared fighter. */
  equipIron(): this {
    this.heldItem = { name: 'iron_sword', count: 1 };
    this.inventory.items = () => [{ name: 'iron_sword', count: 1 }];
    this.inventory.slots = [];
    ['helmet', 'chestplate', 'leggings', 'boots'].forEach((piece, i) => {
      this.inventory.slots[5 + i] = { name: `iron_${piece}`, count: 1 };
    });
    return this;
  }

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
  follow = vi.fn((id: number) => void this.calls.push(`follow ${id}`));
  goTo = vi.fn(
    (p: { x: number; y: number; z: number }) => void this.calls.push(`goto ${p.x},${p.y},${p.z}`),
  );
  stop = vi.fn(() => void this.calls.push('stop'));
  eating: boolean[] = [];
  setEatingPaused = vi.fn((paused: boolean) => void this.eating.push(paused));
  tick = vi.fn((n: number) => void this.ticks.push(n));
}
