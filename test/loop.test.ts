import { describe, expect, it, vi } from 'vitest';
import { IDLE } from '../src/intent.js';
import type { Snapshot } from '../src/perception/types.js';
import { ReflexLoop } from '../src/reflex/loop.js';
import type { RuleSettings } from '../src/reflex/rules.js';
import { FakeActuator } from './fakeBot.js';
import { BARE, mob, rules as defaultRules, snap } from './fixtures.js';

function setup(everyTicks = 1, rules: RuleSettings = defaultRules) {
  const state = { snap: snap(20, []) as Snapshot | null };
  const actuator = new FakeActuator();
  const onIntent = vi.fn();
  const onError = vi.fn();
  const loop = new ReflexLoop({
    everyTicks,
    rules,
    read: () => state.snap,
    actuator,
    onIntent,
    onError,
  });
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) loop.onTick();
  };
  return { state, actuator, loop, tick, onIntent, onError };
}

describe('ReflexLoop', () => {
  it('runs every N ticks and passes the elapsed ticks to the actuator', () => {
    const { actuator, tick } = setup(4);
    tick(3);
    expect(actuator.tick).not.toHaveBeenCalled();
    tick(1);
    expect(actuator.tick).toHaveBeenCalledTimes(1);
    expect(actuator.ticks).toEqual([4]);
    tick(8);
    expect(actuator.tick).toHaveBeenCalledTimes(3);
  });

  it('engages a hostile and does not re-issue the command while nothing changes', () => {
    const { state, actuator, tick, loop, onIntent } = setup();
    state.snap = snap(20, [mob(7, 6)]);
    tick(5);
    expect(actuator.calls).toEqual(['engage 7']);
    expect(loop.intent).toMatchObject({ tactic: 'engage', targetId: 7 });
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent.mock.calls[0]![1]).toBe(IDLE);
  });

  it('retreats when HP drops, then stops when the threat is gone', () => {
    const { state, actuator, tick } = setup();
    state.snap = snap(20, [mob(7, 6)]);
    tick();
    state.snap = snap(4, [mob(7, 5)], BARE);
    tick();
    state.snap = snap(4, []);
    tick();
    expect(actuator.calls).toEqual(['engage 7', 'retreat 7', 'stop']);
  });

  it('follows a new target when the old one disappears', () => {
    const { state, actuator, tick } = setup();
    state.snap = snap(20, [mob(1, 5), mob(2, 9)]);
    tick();
    state.snap = snap(20, [mob(2, 8)]);
    tick();
    expect(actuator.calls).toEqual(['engage 1', 'engage 2']);
  });

  it('does nothing while there is no snapshot', () => {
    const { state, actuator, tick } = setup();
    state.snap = null;
    tick(3);
    expect(actuator.calls).toEqual([]);
    expect(actuator.tick).not.toHaveBeenCalled();
  });

  it('uses an override in place of the rules until it expires', () => {
    const { state, actuator, tick, loop } = setup();
    state.snap = snap(20, [mob(1, 5), mob(2, 9)]);
    loop.setOverride({ tactic: 'engage', targetId: 2, reason: 'jev' }, 3);
    tick(2);
    expect(loop.intent).toMatchObject({ targetId: 2, reason: 'jev' });
    tick(2); // override expires at tick 3, rules pick the nearest (1)
    expect(loop.intent).toMatchObject({ targetId: 1 });
    expect(actuator.calls).toEqual(['engage 2', 'engage 1']);
  });

  it('passes an override through adjustOverride each step', () => {
    const actuator = new FakeActuator();
    const state = { snap: snap(20, [mob(1, 5), mob(2, 9)]) };
    const loop = new ReflexLoop({
      everyTicks: 1,
      rules: defaultRules,
      read: () => state.snap,
      actuator,
      adjustOverride: (_s, intent) => ({ ...intent, targetId: 1, reason: 'role' }),
    });
    loop.setOverride({ tactic: 'engage', targetId: 2, reason: 'jev' }, 100);
    loop.onTick();
    expect(loop.intent).toMatchObject({ targetId: 1, reason: 'role' });
  });

  it('can drop an override early', () => {
    const { state, tick, loop } = setup();
    state.snap = snap(20, [mob(1, 5), mob(2, 9)]);
    loop.setOverride({ tactic: 'engage', targetId: 2, reason: 'jev' }, 1000);
    tick();
    loop.clearOverride();
    tick();
    expect(loop.intent.targetId).toBe(1);
  });

  it('reports errors instead of throwing, and keeps running', () => {
    const { state, actuator, tick, onError } = setup();
    actuator.tick.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    state.snap = snap(20, []);
    expect(() => tick(2)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(actuator.tick).toHaveBeenCalledTimes(2);
  });

  it('stops everything and resets on dispose', () => {
    const { state, actuator, tick, loop } = setup();
    state.snap = snap(20, [mob(1, 5)]);
    tick();
    loop.dispose();
    expect(actuator.calls).toEqual(['engage 1', 'stop']);
    expect(loop.intent).toEqual(IDLE);
  });
});

describe('ReflexLoop eating', () => {
  it('pauses eating while a hostile is close and resumes when it is gone, once each', () => {
    const { state, actuator, tick } = setup();
    tick(3);
    expect(actuator.eating).toEqual([]);

    state.snap = snap(20, [mob(1, 9)]);
    tick(5);
    expect(actuator.eating).toEqual([true]);

    state.snap = snap(20, [mob(1, 12)]);
    tick(5);
    expect(actuator.eating).toEqual([true, false]);
  });

  it('pauses eating even for hostiles the bot will not fight', () => {
    const { state, actuator, tick } = setup();
    state.snap = snap(20, [mob(1, 4, { kind: 'enderman' })]);
    tick();
    expect(actuator.eating).toEqual([true]);
  });

  it('follows the configured radius', () => {
    const { state, actuator, tick } = setup(1, { ...defaultRules, noEatRadiusBlocks: 4 });
    state.snap = snap(20, [mob(1, 6)]);
    tick();
    expect(actuator.eating).toEqual([]);
    state.snap = snap(20, [mob(1, 4)]);
    tick();
    expect(actuator.eating).toEqual([true]);
  });

  it('allows eating again on dispose if it was paused', () => {
    const { state, actuator, tick, loop } = setup();
    state.snap = snap(20, [mob(1, 5)]);
    tick();
    loop.dispose();
    expect(actuator.eating).toEqual([true, false]);
  });

  it('leaves eating alone on dispose if it was never paused', () => {
    const { actuator, tick, loop } = setup();
    tick();
    loop.dispose();
    expect(actuator.eating).toEqual([]);
  });
});

describe('ReflexLoop failed retreats', () => {
  // Defaults: judge every 2000ms (40 ticks), need 1.5 blocks gained, fight back for 4000ms (80 ticks).
  const stuck = () => snap(4, [mob(7, 5)], BARE); // low HP: the rules say retreat, and the zombie stays put

  it('keeps retreating while the distance grows', () => {
    const { state, actuator, tick } = setup();
    for (let i = 0; i < 100; i++) {
      state.snap = snap(4, [mob(7, 5 + i * 0.1)], BARE);
      tick();
    }
    expect(actuator.calls).toEqual(['retreat 7']);
  });

  it('turns and fights when the distance does not grow', () => {
    const { state, actuator, tick, loop } = setup();
    state.snap = stuck();
    tick(40);
    expect(actuator.calls).toEqual(['retreat 7']);
    tick(1); // the first full window has passed
    expect(actuator.calls).toEqual(['retreat 7', 'engage 7']);
    expect(loop.intent.reason).toBe('retreat from zombie failed, fighting back');
  });

  it('fights back for the configured time, then lets the rules decide again', () => {
    const { state, actuator, tick } = setup();
    state.snap = stuck();
    tick(41);
    tick(79); // still inside the fight-back period
    expect(actuator.calls).toEqual(['retreat 7', 'engage 7']);
    tick(2); // period over: low HP, so the rules retreat again
    expect(actuator.calls).toEqual(['retreat 7', 'engage 7', 'retreat 7']);
  });

  it('does not fight back when fight-back is turned off', () => {
    const { state, actuator, tick } = setup(1, { ...defaultRules, fightBackMs: 0 });
    state.snap = stuck();
    tick(200);
    expect(actuator.calls).toEqual(['retreat 7']);
  });

  it('stops fighting back if the target is gone', () => {
    const { state, actuator, tick } = setup();
    state.snap = stuck();
    tick(41);
    state.snap = snap(4, []);
    tick();
    expect(actuator.calls).toEqual(['retreat 7', 'engage 7', 'stop']);
  });

  it('forgets a slow start when the threat leaves view', () => {
    const { state, actuator, tick } = setup();
    state.snap = stuck();
    tick(30);
    state.snap = snap(4, [mob(9, 20, { visible: false })], BARE); // nothing visible to flee from
    tick();
    state.snap = stuck();
    tick(30); // only 30 ticks since the restart, so no verdict yet
    expect(actuator.calls).not.toContain('engage 7');
  });

  it('respects the configured window and minimum gain', () => {
    const quick = { ...defaultRules, retreatCheckMs: 500, retreatMinGainBlocks: 0.5 };
    const { state, actuator, tick } = setup(1, quick);
    state.snap = stuck();
    tick(11); // 500ms = 10 ticks
    expect(actuator.calls).toEqual(['retreat 7', 'engage 7']);
  });
});

describe('ReflexLoop with a custom decision function', () => {
  it('uses it in place of the plain rules', () => {
    const state = { snap: snap(20, [mob(1, 5)]) as Snapshot | null };
    const actuator = new FakeActuator();
    const decide = vi.fn(() => ({ tactic: 'idle' as const, reason: 'standing down' }));
    const loop = new ReflexLoop({
      everyTicks: 1,
      rules: defaultRules,
      read: () => state.snap,
      actuator,
      decide,
    });
    loop.onTick();
    expect(decide).toHaveBeenCalled();
    expect(actuator.calls).toEqual([]); // the rules would have engaged the zombie
  });

  it('passes the current intent as the previous one', () => {
    const state = { snap: snap(20, [mob(1, 5)]) as Snapshot | null };
    const actuator = new FakeActuator();
    const seen: string[] = [];
    const loop = new ReflexLoop({
      everyTicks: 1,
      rules: defaultRules,
      read: () => state.snap,
      actuator,
      decide: (_s, previous) => {
        seen.push(previous.tactic);
        return { tactic: 'engage', targetId: 1, reason: 'x' };
      },
    });
    loop.onTick();
    loop.onTick();
    expect(seen).toEqual(['idle', 'engage']);
  });

  it('drives follow and goto intents through the actuator, and only when they change', () => {
    const state = { snap: snap(20, []) as Snapshot | null };
    const actuator = new FakeActuator();
    let next: Parameters<typeof actuator.follow>[0] | { x: number; y: number; z: number } = 7;
    const loop = new ReflexLoop({
      everyTicks: 1,
      rules: defaultRules,
      read: () => state.snap,
      actuator,
      decide: () =>
        typeof next === 'number'
          ? { tactic: 'follow', targetId: next, reason: 'owner' }
          : { tactic: 'goto', position: next, reason: 'post' },
    });
    loop.onTick();
    loop.onTick();
    next = { x: 1, y: 2, z: 3 };
    loop.onTick();
    loop.onTick();
    next = { x: 1, y: 2, z: 4 }; // a different point is a new order
    loop.onTick();
    expect(actuator.calls).toEqual(['follow 7', 'goto 1,2,3', 'goto 1,2,4']);
  });
});
