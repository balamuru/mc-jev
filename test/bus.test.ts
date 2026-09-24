import { describe, expect, it, vi } from 'vitest';
import { InProcessBus } from '../src/swarm/bus.js';
import type { SwarmEvent } from '../src/swarm/events.js';

const beat = (agent = 'A'): SwarmEvent => ({
  type: 'heartbeat',
  agent,
  at: 1,
  role: 'fighter',
  position: { x: 0, y: 0, z: 0 },
  hp: 20,
});
const died = (agent = 'A'): SwarmEvent => ({ type: 'died', agent, at: 2 });

describe('InProcessBus', () => {
  it('delivers an event to subscribers of its type, and to wildcard subscribers', () => {
    const bus = new InProcessBus();
    const beats = vi.fn();
    const all = vi.fn();
    bus.subscribe('heartbeat', beats);
    bus.subscribe('*', all);
    bus.publish(beat());
    bus.publish(died());
    expect(beats).toHaveBeenCalledTimes(1);
    expect(all).toHaveBeenCalledTimes(2);
    expect(beats).toHaveBeenCalledWith(beat());
  });

  it('does not deliver to subscribers of other types', () => {
    const bus = new InProcessBus();
    const deaths = vi.fn();
    bus.subscribe('died', deaths);
    bus.publish(beat());
    expect(deaths).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new InProcessBus();
    const h = vi.fn();
    const off = bus.subscribe('*', h);
    bus.publish(beat());
    off();
    bus.publish(beat());
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering when one handler throws, and reports the error', () => {
    const onError = vi.fn();
    const bus = new InProcessBus(onError);
    const good = vi.fn();
    bus.subscribe('heartbeat', () => {
      throw new Error('boom');
    });
    bus.subscribe('heartbeat', good);
    expect(() => bus.publish(beat())).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('tolerates a handler that unsubscribes while an event is being delivered', () => {
    const bus = new InProcessBus();
    const second = vi.fn();
    const off = bus.subscribe('*', () => off());
    bus.subscribe('*', second);
    bus.publish(beat());
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('carries events that survive a JSON round trip', () => {
    const e = beat();
    expect(JSON.parse(JSON.stringify(e))).toEqual(e);
  });
});
