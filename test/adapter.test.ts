import { describe, expect, it } from 'vitest';
import { readSnapshot } from '../src/agent/mineflayerAdapter.js';
import { FakeBot } from './fakeBot.js';

const zombie = (id: number, z: number) => ({
  id,
  type: 'hostile',
  name: 'zombie',
  position: { x: 0, y: 64, z },
  velocity: { x: 0, y: 0, z: 0 },
});

describe('readSnapshot', () => {
  it('reads bot state and excludes the bot itself from entities', () => {
    const bot = new FakeBot();
    bot.health = 14;
    bot.food = 9;
    bot.heldItem = { name: 'stone_sword', count: 1 };
    bot.inventory.items = () => [{ name: 'apple', count: 3 }];
    bot.entities['7'] = zombie(7, -4);

    const snap = readSnapshot(bot, {}, 99);
    expect(snap.t).toBe(99);
    expect(snap.self).toMatchObject({ hp: 14, food: 9, heldItem: 'stone_sword' });
    expect(snap.inventory).toEqual(['applex3']);
    expect(snap.entities.map((e) => e.id)).toEqual([7]);
  });

  it('lists worn armor from slots 5-8 and skips empty slots', () => {
    const bot = new FakeBot();
    bot.inventory.slots = [];
    bot.inventory.slots[5] = { name: 'iron_helmet', count: 1 };
    bot.inventory.slots[6] = null;
    bot.inventory.slots[8] = { name: 'iron_boots', count: 1 };
    bot.inventory.slots[9] = { name: 'apple', count: 1 }; // not armor
    expect(readSnapshot(bot).self.armor).toEqual(['iron_helmet', 'iron_boots']);
  });

  it('treats a missing isInWater as false', () => {
    const bot = new FakeBot();
    delete (bot.entity as { isInWater?: boolean }).isInWater;
    expect(readSnapshot(bot).self.inWater).toBe(false);
  });

  it('checks line of sight with a normalized ray whose range is the distance', () => {
    const bot = new FakeBot();
    bot.entities['3'] = zombie(3, -10);
    readSnapshot(bot, { requireLineOfSight: true });

    expect(bot.world.raycast).toHaveBeenCalledTimes(1);
    const [from, direction, range] = bot.world.raycast.mock.calls[0] as unknown as [
      { x: number; y: number; z: number },
      { x: number; y: number; z: number; norm(): number },
      number,
    ];
    expect(from.y).toBeCloseTo(65.62);
    expect(direction.norm()).toBeCloseTo(1);
    expect(direction.z).toBeCloseTo(-1);
    expect(range).toBeCloseTo(10);
  });

  it('hides entities when the ray hits a block', () => {
    const bot = new FakeBot();
    bot.entities['3'] = zombie(3, -10);
    bot.world.raycast.mockReturnValue({ name: 'stone' });
    expect(readSnapshot(bot, { requireLineOfSight: true }).entities).toEqual([]);
    bot.world.raycast.mockReturnValue(null);
    expect(readSnapshot(bot, { requireLineOfSight: true }).entities).toHaveLength(1);
  });
});
