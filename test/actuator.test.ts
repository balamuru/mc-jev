import { EventEmitter } from 'node:events';
import type { Bot } from 'mineflayer';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';
import { MineflayerActuator, OFFHAND_SLOT } from '../src/agent/actuator.js';

/** Just enough of a Mineflayer bot for the actuator. */
function fakeBot(
  opts: { shield?: boolean; weapon?: string; items?: Array<{ name: string; count: number }> } = {},
) {
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
  const emitter = new EventEmitter();
  const bot = {
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    _client: client,
    entity: self,
    entities: { 0: self } as Record<number, unknown>,
    heldItem: { name: opts.weapon ?? 'iron_sword' },
    inventory: {
      slots,
      items: () => opts.items ?? [{ name: opts.weapon ?? 'iron_sword', count: 1 }],
    },
    quickBarSlot: 0,
    setQuickBarSlot: vi.fn((slot: number) => void events.push(`slot ${slot}`)),
    look: vi.fn(async () => {}),
    world: { raycast: vi.fn((): unknown => null) },
    pathfinder: { setGoal: vi.fn() },
    lookAt: vi.fn(async () => {}),
    equip: vi.fn(async () => {}),
    attack: vi.fn(() => void events.push('attack')),
    activateItem: vi.fn((offhand?: boolean) => void events.push(offhand ? 'raise' : 'draw')),
    deactivateItem: vi.fn(
      () => void events.push(bot.heldItem.name === 'bow' ? 'release' : 'lower'),
    ),
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

describe('MineflayerActuator bow', () => {
  const kit = [
    { name: 'bow', count: 1 },
    { name: 'arrow', count: 16 },
    { name: 'iron_sword', count: 1 },
  ];
  const archer = (x: number, over: Record<string, unknown> = {}) => {
    const f = fakeBot({ weapon: 'bow', items: kit });
    f.add(1, 'zombie', x);
    const a = new MineflayerActuator(f.asBot, {
      bow: true,
      bowRange: { minBlocks: 6, maxBlocks: 20 },
      ...over,
    });
    return { f, a };
  };

  it('draws for a full second (20 ticks), then releases at a target in range, and counts the shot', () => {
    const { f, a } = archer(12);
    a.engage(1);
    ticks(a, 20);
    expect(f.events.filter((e) => e === 'draw' || e === 'release')).toEqual(['draw']);
    a.tick(1);
    expect(f.events.filter((e) => e === 'draw' || e === 'release')).toEqual(['draw', 'release']);
    expect(a.bowStats.shots).toBe(1);
    expect(f.bot.attack).not.toHaveBeenCalled();
  });

  it('aims towards the target, and higher for a farther one', () => {
    const pitchAt = (x: number) => {
      const { f, a } = archer(x);
      a.engage(1);
      a.tick(1);
      return f.bot.look.mock.calls[0] as unknown as [number, number];
    };
    const [yaw, near] = pitchAt(8);
    const [, far] = pitchAt(19);
    expect(yaw).toBeCloseTo(-Math.PI / 2); // the target is towards +x
    expect(far).toBeGreaterThan(near);
    expect(Math.abs(near)).toBeLessThan(0.2); // nearly flat at short range
  });

  it('stands still to shoot once in range', () => {
    const { f, a } = archer(12);
    a.engage(1);
    a.tick(1);
    expect(f.bot.pathfinder.setGoal).toHaveBeenLastCalledWith(null, false);
  });

  it('holds the draw while another player is in the line of fire, and never releases', () => {
    const { f, a } = archer(12);
    f.add(9, 'Owner', 6, 'player');
    a.engage(1);
    ticks(a, 60);
    expect(f.events).toContain('draw');
    expect(f.events).not.toContain('release');
  });

  it('holds the draw while a block is in the way', () => {
    const { f, a } = archer(12);
    f.bot.world.raycast.mockReturnValue({ name: 'stone' });
    a.engage(1);
    ticks(a, 40);
    expect(f.events).not.toContain('release');
  });

  it('uses melee inside the minimum range, and without arrows', () => {
    for (const [x, items] of [
      [4, kit],
      [
        12,
        [
          { name: 'bow', count: 1 },
          { name: 'iron_sword', count: 1 },
        ],
      ],
    ] as const) {
      const f = fakeBot({ weapon: 'iron_sword', items: [...items] });
      f.add(1, 'zombie', x);
      const a = new MineflayerActuator(f.asBot, {
        bow: true,
        bowRange: { minBlocks: 6, maxBlocks: 20 },
      });
      a.engage(1);
      ticks(a, 25);
      expect(f.events).not.toContain('draw');
    }
  });

  it('does nothing with the bow when switched off', () => {
    const { f, a } = archer(12, { bow: false });
    a.engage(1);
    ticks(a, 25);
    expect(f.events).not.toContain('draw');
  });

  it('cancels a draw without firing when the target comes too close', () => {
    const { f, a } = archer(12);
    a.engage(1);
    ticks(a, 10); // mid-draw
    (f.bot.entities[1] as { position: Vec3 }).position = new Vec3(3, 64, 0);
    f.bot.heldItem = { name: 'iron_sword' };
    a.tick(1);
    expect(f.events).not.toContain('release');
    expect(f.events.some((e) => e.startsWith('slot '))).toBe(true); // switched slot to cancel
  });

  it('counts a hit when the target is hurt soon after a shot, once per shot', () => {
    const { f, a } = archer(12);
    a.engage(1);
    ticks(a, 21); // one shot
    f.bot.emit('entityHurt', f.bot.entities[1]);
    f.bot.emit('entityHurt', f.bot.entities[1]); // e.g. a melee hit afterwards: not an arrow hit
    expect(a.bowStats).toEqual({ shots: 1, hits: 1 });
  });

  it('does not count the target being hurt when no shot is in flight', () => {
    const { f, a } = archer(12);
    a.engage(1);
    f.bot.emit('entityHurt', f.bot.entities[1]);
    expect(a.bowStats).toEqual({ shots: 0, hits: 0 });
  });

  it('cancels a draw without firing on stop', () => {
    const { f, a } = archer(12);
    a.engage(1);
    ticks(a, 10);
    a.stop();
    expect(f.events).not.toContain('release');
    expect(f.events.some((e) => e.startsWith('slot '))).toBe(true);
  });
});
