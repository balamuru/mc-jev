import { describe, expect, it } from 'vitest';
import { Blackboard } from '../src/swarm/blackboard.js';
import { InProcessBus } from '../src/swarm/bus.js';
import type { SwarmEvent } from '../src/swarm/events.js';

function setup(over: { claimTtlMs?: number } = {}) {
  const clock = { t: 1_000_000 };
  const bus = new InProcessBus();
  const events: SwarmEvent[] = [];
  bus.subscribe('*', (e) => void events.push(e));
  const board = new Blackboard(bus, { claimTtlMs: over.claimTtlMs ?? 8000, now: () => clock.t });
  const beat = (agent: string, x = 0, hp = 20, role = 'fighter') =>
    bus.publish({
      type: 'heartbeat',
      agent,
      at: clock.t,
      role,
      position: { x, y: 64, z: 0 },
      hp,
    });
  return { clock, bus, board, events, beat };
}

describe('Blackboard allies', () => {
  it('knows the bots that have reported in, and lists the others', () => {
    const { board, beat } = setup();
    beat('A', 0, 20, 'tank');
    beat('B', 10, 14);
    expect(
      board
        .allAllies()
        .map((a) => a.agent)
        .sort(),
    ).toEqual(['A', 'B']);
    expect(board.alliesOf('A')).toMatchObject([{ agent: 'B', hp: 14, position: { x: 10 } }]);
  });

  it('forgets a bot that goes quiet, and one that dies or leaves', () => {
    const { board, bus, clock, beat } = setup();
    beat('A');
    beat('B');
    beat('C');
    clock.t += 10_001;
    beat('B');
    beat('C');
    expect(
      board
        .allAllies()
        .map((a) => a.agent)
        .sort(),
    ).toEqual(['B', 'C']);
    bus.publish({ type: 'died', agent: 'B', at: clock.t });
    bus.publish({ type: 'left', agent: 'C', at: clock.t });
    expect(board.allAllies()).toEqual([]);
  });
});

describe('Blackboard claims', () => {
  it('lets the first bot claim a target and refuses the second', () => {
    const { board, beat } = setup();
    beat('A');
    beat('B');
    expect(board.tryClaim('A', 7, 'zombie')).toBe(true);
    expect(board.tryClaim('B', 7, 'zombie')).toBe(false);
    expect(board.tryClaim('A', 7, 'zombie')).toBe(true); // refreshing your own claim
    expect(board.claimedByOthers('B')).toEqual(new Set([7]));
    expect(board.claimedByOthers('A')).toEqual(new Set());
  });

  it('frees a target when released, but only by its owner', () => {
    const { board, beat } = setup();
    beat('A');
    beat('B');
    board.tryClaim('A', 7, 'zombie');
    board.release('B', 7);
    expect(board.tryClaim('B', 7, 'zombie')).toBe(false);
    board.release('A', 7);
    expect(board.tryClaim('B', 7, 'zombie')).toBe(true);
  });

  it('lets a claim lapse unless it is refreshed', () => {
    const { board, clock, beat } = setup({ claimTtlMs: 5000 });
    beat('A');
    beat('B');
    board.tryClaim('A', 7, 'zombie');
    clock.t += 4000;
    beat('A');
    beat('B');
    board.tryClaim('A', 7, 'zombie'); // refreshed
    clock.t += 4000;
    beat('A');
    beat('B');
    expect(board.tryClaim('B', 7, 'zombie')).toBe(false);
    clock.t += 5001;
    beat('A');
    beat('B');
    expect(board.tryClaim('B', 7, 'zombie')).toBe(true);
  });

  it('drops every claim of a bot that dies or leaves', () => {
    const { board, bus, clock, beat } = setup();
    beat('A');
    beat('B');
    board.tryClaim('A', 7, 'zombie');
    board.tryClaim('A', 8, 'zombie');
    bus.publish({ type: 'died', agent: 'A', at: clock.t });
    expect(board.liveClaims()).toEqual([]);
    expect(board.tryClaim('B', 7, 'zombie')).toBe(true);
  });

  it('ignores a claim from a bot that never reported in', () => {
    const { board } = setup();
    board.tryClaim('Ghost', 7, 'zombie');
    expect(board.liveClaims()).toEqual([]); // no heartbeat, so the claim does not stand
  });

  it('records claims and releases on the bus', () => {
    const { board, events, beat } = setup();
    beat('A');
    board.tryClaim('A', 7, 'zombie');
    board.tryClaim('A', 7, 'zombie');
    board.release('A', 7);
    expect(events.filter((e) => e.type === 'claim')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'release')).toHaveLength(1);
  });
});

describe('Blackboard threats', () => {
  it('collects what different bots have seen, and expires it', () => {
    const { board, bus, clock } = setup();
    bus.publish({
      type: 'threats',
      agent: 'A',
      at: clock.t,
      threats: [{ id: 5, kind: 'zombie', position: { x: 1, y: 64, z: 2 } }],
    });
    bus.publish({
      type: 'threats',
      agent: 'B',
      at: clock.t,
      threats: [{ id: 5, kind: 'zombie', position: { x: 2, y: 64, z: 2 } }],
    });
    expect(board.knownThreats()).toEqual([
      {
        id: 5,
        kind: 'zombie',
        position: { x: 2, y: 64, z: 2 },
        lastSeen: clock.t,
        seenBy: ['A', 'B'],
      },
    ]);
    clock.t += 5001;
    expect(board.knownThreats()).toEqual([]);
  });
});

describe('Blackboard help requests', () => {
  const hurt = (bus: InProcessBus, agent: string, at: number, hp: number) =>
    bus.publish({ type: 'damaged', agent, at, hp });

  it('points to the nearest ally that was hit recently and is low on HP', () => {
    const { board, bus, clock, beat } = setup();
    beat('A', 0);
    beat('B', 10, 6);
    beat('C', 30, 5);
    hurt(bus, 'B', clock.t, 6);
    hurt(bus, 'C', clock.t, 5);
    expect(board.helpNeededBy('A', { x: 0, y: 64, z: 0 }, 8)).toMatchObject({ agent: 'B', hp: 6 });
  });

  it('does not count healthy allies, old injuries, far allies or the caller itself', () => {
    const { board, bus, clock, beat } = setup();
    beat('A', 0, 5);
    beat('B', 10, 15);
    beat('C', 10, 5);
    beat('D', 100, 4);
    hurt(bus, 'A', clock.t, 5);
    hurt(bus, 'B', clock.t, 15);
    hurt(bus, 'D', clock.t, 4);
    expect(board.helpNeededBy('A', { x: 0, y: 64, z: 0 }, 8)).toBeNull(); // B healthy, C not hit, D too far
    hurt(bus, 'C', clock.t - 6000, 5);
    expect(board.helpNeededBy('A', { x: 0, y: 64, z: 0 }, 8)).toBeNull(); // C hit too long ago
  });
});

describe('Blackboard directives', () => {
  it('holds a focus target until it expires', () => {
    const { board, bus, clock } = setup();
    expect(board.focusTarget()).toBeNull();
    bus.publish({ type: 'directive', at: clock.t, ttlMs: 6000, focusTargetId: 42 });
    expect(board.focusTarget()).toBe(42);
    clock.t += 5999;
    expect(board.focusTarget()).toBe(42);
    clock.t += 2;
    expect(board.focusTarget()).toBeNull();
  });

  it('is replaced by a newer directive', () => {
    const { board, bus, clock } = setup();
    bus.publish({ type: 'directive', at: clock.t, ttlMs: 6000, focusTargetId: 1 });
    bus.publish({ type: 'directive', at: clock.t, ttlMs: 6000, focusTargetId: 2 });
    expect(board.focusTarget()).toBe(2);
  });
});

describe('Blackboard.close', () => {
  it('stops listening to the bus', () => {
    const { board, bus, clock } = setup();
    board.close();
    bus.publish({ type: 'directive', at: clock.t, ttlMs: 6000, focusTargetId: 9 });
    expect(board.focusTarget()).toBeNull();
  });
});
