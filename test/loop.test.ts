import { describe, expect, it, vi } from 'vitest';
import { IDLE } from '../src/intent.js';
import type { EntitySummary, Snapshot } from '../src/perception/types.js';
import { ReflexLoop } from '../src/reflex/loop.js';
import { FakeActuator } from './fakeBot.js';

const rules = { retreatHp: 6, resumeHp: 14, engageRadiusBlocks: 16 };

const zombie = (id: number, dist: number): EntitySummary => ({
  id,
  kind: 'zombie',
  category: 'hostile',
  dist,
  bearing: 'ahead',
  approaching: true,
  held: null,
  visible: true,
});

function world(hp: number, entities: EntitySummary[]): Snapshot {
  return {
    t: 0,
    self: {
      position: { x: 0, y: 64, z: 0 },
      hp,
      food: 20,
      heldItem: null,
      armor: [],
      onGround: true,
      inWater: false,
    },
    entities,
    inventory: [],
  };
}

function setup(everyTicks = 1) {
  const state = { snap: world(20, []) as Snapshot | null };
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
    state.snap = world(20, [zombie(7, 6)]);
    tick(5);
    expect(actuator.calls).toEqual(['engage 7']);
    expect(loop.intent).toMatchObject({ tactic: 'engage', targetId: 7 });
    expect(onIntent).toHaveBeenCalledTimes(1);
    expect(onIntent.mock.calls[0]![1]).toBe(IDLE);
  });

  it('retreats when HP drops, then stops when the threat is gone', () => {
    const { state, actuator, tick } = setup();
    state.snap = world(20, [zombie(7, 6)]);
    tick();
    state.snap = world(4, [zombie(7, 5)]);
    tick();
    state.snap = world(4, []);
    tick();
    expect(actuator.calls).toEqual(['engage 7', 'retreat 7', 'stop']);
  });

  it('follows a new target when the old one disappears', () => {
    const { state, actuator, tick } = setup();
    state.snap = world(20, [zombie(1, 5), zombie(2, 9)]);
    tick();
    state.snap = world(20, [zombie(2, 8)]);
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
    state.snap = world(20, [zombie(1, 5), zombie(2, 9)]);
    loop.setOverride({ tactic: 'engage', targetId: 2, reason: 'jev' }, 3);
    tick(2);
    expect(loop.intent).toMatchObject({ targetId: 2, reason: 'jev' });
    tick(2); // override expires at tick 3, rules pick the nearest (1)
    expect(loop.intent).toMatchObject({ targetId: 1 });
    expect(actuator.calls).toEqual(['engage 2', 'engage 1']);
  });

  it('can drop an override early', () => {
    const { state, tick, loop } = setup();
    state.snap = world(20, [zombie(1, 5), zombie(2, 9)]);
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
    state.snap = world(20, []);
    expect(() => tick(2)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(actuator.tick).toHaveBeenCalledTimes(2);
  });

  it('stops everything and resets on dispose', () => {
    const { state, actuator, tick, loop } = setup();
    state.snap = world(20, [zombie(1, 5)]);
    tick();
    loop.dispose();
    expect(actuator.calls).toEqual(['engage 1', 'stop']);
    expect(loop.intent).toEqual(IDLE);
  });
});
