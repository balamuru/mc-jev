import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { MineflayerActuator, OFFHAND_SLOT } from '../src/agent/actuator.js';

/** Just enough of a Mineflayer bot for the actuator. */
function fakeBot(opts: { shield?: boolean; weapon?: string } = {}) {
  const client = new EventEmitter();
  const events: string[] = [];
  const self = {
    id: 0,
    position: new Vec3(0, 64, 0),
    velocity: new Vec3(0, 0, 0),
    onGround: true,
    isValid: true,
  };
  const slots: Array<{ name: string } | null> = [];
  if (opts.shield) slots[OFFHAND_SLOT] = { name: 'shield' };
  const bot = {
    _client: client,
    entity: self,
    entities: { 0: self } as Record<number, unknown>,
    heldItem: { name: opts.weapon ?? 'iron_sword' },
    inventory: { slots, items: () => [{ name: opts.weapon ?? 'iron_sword', count: 1 }] },
    pathfinder: { setGoal: vi.fn() },
    lookAt: vi.fn(async () => {}),
    equip: vi.fn(async () => {}),
    attack: vi.fn(() => void events.push('attack')),
    activateItem: vi.fn(() => void events.push('raise')),
    deactivateItem: vi.fn(() => void events.push('lower')),
    setControlState: vi.fn((state: string, on: boolean) => {
      if (on && (state === 'left' || state === 'right')) events.push(state);
    }),
    clearControlStates: vi.fn(),
  };
  const add = (id: number, name: string, x: number, type = 'hostile') => {
    bot.entities[id] = {
      id,
      type,
      name,
      username: type === 'player' ? name : undefined,
      position: new Vec3(x, 64, 0),
      velocity: new Vec3(0, 0, 0),
      height: 1.95,
      isValid: true,
    };
  };
  return { bot, client, events, add, asBot: bot as unknown as Bot };
}

const ticks = (a: MineflayerActuator, n: number) => {
  for (let i = 0; i < n; i++) a.tick(1);
};

describe('MineflayerActuator shield', () => {
  it('swings first, raises the shield while the sword recharges, and lowers it for the next swing', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'zombie', 2);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    ticks(a, 14); // iron sword: 13 ticks between swings
    expect(f.events).toEqual(['attack', 'raise', 'lower', 'attack']);
    expect(a.blocking).toBe(false);
    a.tick(1);
    expect(a.blocking).toBe(true);
  });

  it('never attacks while the shield is up', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'zombie', 2);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    let up = false;
    f.bot.activateItem.mockImplementation(() => void (up = true));
    f.bot.deactivateItem.mockImplementation(() => void (up = false));
    f.bot.attack.mockImplementation(() => {
      expect(up).toBe(false);
    });
    ticks(a, 60);
    expect(f.bot.attack).toHaveBeenCalledTimes(5);
  });

  it('does nothing with the shield when it is switched off, or there is no shield', () => {
    for (const [shieldOn, hasShield] of [
      [false, true],
      [true, false],
    ]) {
      const f = fakeBot({ shield: hasShield });
      f.add(1, 'zombie', 2);
      const a = new MineflayerActuator(f.asBot, { shield: shieldOn });
      a.engage(1);
      ticks(a, 30);
      expect(f.bot.activateItem).not.toHaveBeenCalled();
    }
  });

  it('keeps the shield down while chasing a distant target', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'zombie', 10);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    ticks(a, 20);
    expect(f.bot.activateItem).not.toHaveBeenCalled();
  });

  it('blocks a nearby creeper while closing in on it', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'creeper', 3.5);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    a.tick(1);
    expect(a.blocking).toBe(true);
  });

  it('lowers the shield and keeps it down while an axe hit has it on cooldown', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'zombie', 2);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    ticks(a, 2);
    expect(a.blocking).toBe(true);
    f.client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 20 });
    expect(a.blocking).toBe(false);
    let upDuringCooldown = false;
    for (let i = 0; i < 18; i++) {
      a.tick(1);
      upDuringCooldown ||= a.blocking;
    }
    expect(upDuringCooldown).toBe(false);
    let upAfter = false;
    for (let i = 0; i < 13; i++) {
      a.tick(1);
      upAfter ||= a.blocking;
    }
    expect(upAfter).toBe(true);
  });

  it('ignores cooldowns for other items', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'zombie', 2);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    ticks(a, 2);
    f.client.emit('set_cooldown', { cooldownGroup: 'minecraft:ender_pearl', cooldownTicks: 20 });
    expect(a.blocking).toBe(true);
  });

  it('lowers the shield on stop and when the target is gone', () => {
    const f = fakeBot({ shield: true });
    f.add(1, 'zombie', 2);
    const a = new MineflayerActuator(f.asBot, { shield: true });
    a.engage(1);
    ticks(a, 2);
    a.stop();
    expect(a.blocking).toBe(false);
    a.engage(1);
    ticks(a, 2);
    (f.bot.entities[1] as { isValid: boolean }).isValid = false;
    a.tick(1);
    expect(a.blocking).toBe(false);
  });
});

describe('MineflayerActuator strafing against mobs', () => {
  it('side-steps a melee mob between swings when switched on', () => {
    const f = fakeBot();
    f.add(1, 'zombie', 2);
    const a = new MineflayerActuator(f.asBot, { strafeMobs: true });
    a.engage(1);
    ticks(a, 10);
    expect(f.events.filter((e) => e === 'left' || e === 'right').length).toBeGreaterThan(0);
  });

  it('does not strafe when switched off, against archers or creepers, or while chasing', () => {
    const cases: Array<[boolean, string, number]> = [
      [false, 'zombie', 2],
      [true, 'skeleton', 2],
      [true, 'creeper', 2],
      [true, 'zombie', 6],
    ];
    for (const [on, kind, x] of cases) {
      const f = fakeBot();
      f.add(1, kind, x);
      const a = new MineflayerActuator(f.asBot, { strafeMobs: on });
      a.engage(1);
      ticks(a, 10);
      expect(
        f.events.filter((e) => e === 'left' || e === 'right'),
        `${kind} ${on}`,
      ).toEqual([]);
    }
  });
});

describe('MineflayerActuator protection', () => {
  it('refuses to engage a protected player', () => {
    const f = fakeBot();
    f.add(9, 'Boss', 2, 'player');
    const a = new MineflayerActuator(f.asBot, { protectedPlayers: ['boss'] });
    a.engage(9);
    ticks(a, 20);
    expect(f.bot.attack).not.toHaveBeenCalled();
  });
});

describe('MineflayerActuator sweep safety', () => {
  it('does not swing a sword from the ground when another player stands next to the target', () => {
    const f = fakeBot();
    f.add(1, 'zombie', 2);
    f.add(9, 'Owner', 2.8, 'player'); // right beside the zombie
    const a = new MineflayerActuator(f.asBot);
    a.engage(1);
    ticks(a, 40);
    expect(f.bot.attack).not.toHaveBeenCalled();
    expect(f.bot.setControlState).toHaveBeenCalledWith('jump', true); // it jumps to crit instead
  });

  it('hits as a critical, on the way down, when someone is at risk', () => {
    const f = fakeBot();
    f.add(1, 'zombie', 2);
    f.add(9, 'Owner', 2.8, 'player');
    const a = new MineflayerActuator(f.asBot);
    a.engage(1);
    f.bot.entity.onGround = false;
    f.bot.entity.velocity = new Vec3(0, -0.3, 0);
    a.tick(1);
    expect(f.bot.attack).toHaveBeenCalledTimes(1);
  });

  it('swings normally when nobody is near the target', () => {
    const f = fakeBot();
    f.add(1, 'zombie', 2);
    f.add(9, 'Owner', 8, 'player');
    const a = new MineflayerActuator(f.asBot);
    a.engage(1);
    a.tick(1);
    expect(f.bot.attack).toHaveBeenCalledTimes(1);
  });

  it('does not worry about sweeps with an axe, which does not sweep', () => {
    const f = fakeBot({ weapon: 'iron_axe' });
    f.add(1, 'zombie', 2);
    f.add(9, 'Owner', 2.8, 'player');
    const a = new MineflayerActuator(f.asBot);
    a.engage(1);
    a.tick(1);
    expect(f.bot.attack).toHaveBeenCalledTimes(1);
  });
});
