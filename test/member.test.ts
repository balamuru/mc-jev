import { describe, expect, it } from 'vitest';
import type { Role } from '../src/control/roles.js';
import { IDLE, type Intent } from '../src/intent.js';
import type { Snapshot } from '../src/perception/types.js';
import { Blackboard } from '../src/swarm/blackboard.js';
import { InProcessBus } from '../src/swarm/bus.js';
import type { SwarmEvent } from '../src/swarm/events.js';
import { SwarmMember, type SwarmMode } from '../src/swarm/member.js';
import { mob, snap } from './fixtures.js';

function squad(mode: SwarmMode = 'cooperative') {
  const clock = { t: 1_000_000 };
  const bus = new InProcessBus();
  const events: SwarmEvent[] = [];
  bus.subscribe('*', (e) => void events.push(e));
  const board = new Blackboard(bus, { claimTtlMs: 8000, now: () => clock.t });
  const member = (
    agent: string,
    over: { helpAllies?: boolean; mode?: SwarmMode; role?: Role } = {},
  ) =>
    new SwarmMember({
      agent,
      role: over.role ?? 'fighter',
      mode: over.mode ?? mode,
      bus,
      board,
      helpHp: 8,
      helpAllies: over.helpAllies ?? true,
      now: () => clock.t,
    });
  return { clock, bus, board, events, member };
}

const at = (s: Snapshot, x: number, hp = s.self.hp): Snapshot => ({
  ...s,
  self: { ...s.self, position: { x, y: 64, z: 0 }, hp },
});
const engage = (targetId: number): Intent => ({ tactic: 'engage', targetId, reason: 'x' });

describe('SwarmMember reporting', () => {
  it('sends a heartbeat with role, position and HP, then only once per interval', () => {
    const { member, events, clock } = squad();
    const a = member('A');
    a.observe(at(snap(17, []), 5), IDLE);
    a.observe(at(snap(17, []), 5), IDLE);
    expect(events.filter((e) => e.type === 'heartbeat')).toEqual([
      {
        type: 'heartbeat',
        agent: 'A',
        at: clock.t,
        role: 'fighter',
        position: { x: 5, y: 64, z: 0 },
        hp: 17,
        armorPoints: 15,
        canShoot: false,
      },
    ]);
    clock.t += 1000;
    a.observe(at(snap(17, []), 5), IDLE);
    expect(events.filter((e) => e.type === 'heartbeat')).toHaveLength(2);
  });

  it('shares the hostiles it sees, with where they are, but not neutral mobs', () => {
    const { member, events } = squad();
    member('A').observe(
      snap(20, [
        mob(5, 6),
        mob(6, 8, { kind: 'enderman' }),
        mob(7, 9, { category: 'passive', kind: 'cow' }),
      ]),
      IDLE,
    );
    const seen = events.find((e) => e.type === 'threats');
    expect(seen).toMatchObject({
      agent: 'A',
      threats: [{ id: 5, kind: 'zombie', position: { x: 0, y: 64, z: -6 } }],
    });
  });

  it('says nothing about threats when none are in view', () => {
    const { member, events } = squad();
    member('A').observe(snap(20, []), IDLE);
    expect(events.some((e) => e.type === 'threats')).toBe(false);
  });

  it('reports damage, but not regeneration jitter', () => {
    const { member, events } = squad();
    const a = member('A');
    a.observe(snap(20, []), IDLE);
    a.observe(snap(19.8, []), IDLE);
    a.observe(snap(15, []), IDLE);
    expect(events.filter((e) => e.type === 'damaged')).toEqual([
      expect.objectContaining({ agent: 'A', hp: 15 }),
    ]);
  });

  it('reports its death and its departure', () => {
    const { member, events } = squad();
    const a = member('A');
    a.observe(snap(20, []), IDLE);
    a.died();
    a.dispose();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['died', 'left']));
  });

  it('does nothing at all in independent mode', () => {
    const { member, events, board } = squad('independent');
    const a = member('A');
    a.observe(snap(20, [mob(5, 6)]), engage(5));
    a.died();
    a.dispose();
    expect(events).toEqual([]);
    expect(board.liveClaims()).toEqual([]);
    expect(a.context()).toBeNull();
    expect(a.claimedByOthers().size).toBe(0);
    expect(a.helpNeeded({ x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe('SwarmMember claims', () => {
  it('claims the target it engages, and the other bot sees it as taken', () => {
    const { member } = squad();
    const a = member('A');
    const b = member('B');
    a.observe(snap(20, [mob(5, 6)]), engage(5));
    b.observe(snap(20, [mob(5, 6)]), IDLE);
    expect(b.claimedByOthers()).toEqual(new Set([5]));
    expect(a.claimedByOthers()).toEqual(new Set());
  });

  it('releases the old target when it switches, and when it stops fighting', () => {
    const { member, board } = squad();
    const a = member('A');
    a.observe(snap(20, [mob(5, 6), mob(6, 7)]), engage(5));
    a.observe(snap(20, [mob(5, 6), mob(6, 7)]), engage(6));
    expect(board.liveClaims().map((c) => c.targetId)).toEqual([6]);
    a.observe(snap(20, []), IDLE);
    expect(board.liveClaims()).toEqual([]);
  });

  it('gives up claims when it dies or leaves', () => {
    const { member, board } = squad();
    const a = member('A');
    a.observe(snap(20, [mob(5, 6)]), engage(5));
    a.died();
    expect(board.liveClaims()).toEqual([]);
  });

  it('does not hold a claim someone else already has', () => {
    const { member, board } = squad();
    const a = member('A');
    const b = member('B');
    a.observe(snap(20, [mob(5, 6)]), engage(5));
    b.observe(snap(20, [mob(5, 6)]), engage(5));
    expect(board.liveClaims()).toMatchObject([{ targetId: 5, agent: 'A' }]);
  });
});

describe('SwarmMember views', () => {
  it('describes the squad for Jev: allies with distance, claims, and the focus', () => {
    const { member, bus, clock } = squad('coordinated');
    const a = member('A');
    const b = member('B');
    a.observe(at(snap(20, [mob(5, 6)]), 0), engage(5));
    b.observe(at(snap(12, []), 10), IDLE);
    bus.publish({ type: 'directive', at: clock.t, ttlMs: 6000, focusTargetId: 5 });
    expect(b.context()).toEqual({
      allies: [{ name: 'A', role: 'fighter', hp: 20, distance_blocks: 10 }],
      claims: [{ target: 't5', by: 'A' }],
      focus: 't5',
    });
    expect(a.context()?.claims).toEqual([]); // its own claim is not "taken by others"
  });

  it('ignores the coordinator’s focus unless in coordinated mode', () => {
    const { member, bus, clock } = squad('cooperative');
    const a = member('A');
    a.observe(snap(20, []), IDLE);
    bus.publish({ type: 'directive', at: clock.t, ttlMs: 6000, focusTargetId: 5 });
    expect(a.focusTarget()).toBeNull();
    expect(a.context()?.focus).toBeNull();
  });

  it('points to a hurt ally who was hit recently, unless helping is switched off', () => {
    const { member, bus, clock } = squad();
    const a = member('A');
    const b = member('B');
    const c = member('C', { helpAllies: false });
    a.observe(at(snap(20, []), 0), IDLE);
    b.observe(at(snap(6, []), 12, 6), IDLE);
    bus.publish({ type: 'damaged', agent: 'B', at: clock.t, hp: 6 });
    expect(a.helpNeeded({ x: 0, y: 64, z: 0 })).toMatchObject({ agent: 'B', position: { x: 12 } });
    c.observe(at(snap(20, []), 3), IDLE);
    expect(c.helpNeeded({ x: 3, y: 64, z: 0 })).toBeNull();
  });
});

describe('SwarmMember roles', () => {
  it('uses its configured role outside coordinated mode, even if one was assigned', () => {
    const { member, bus, clock } = squad('cooperative');
    const a = member('A', { role: 'support' });
    bus.publish({ type: 'roles', at: clock.t, ttlMs: 5000, roles: { A: 'tank' } });
    expect(a.role()).toBe('support');
  });

  it('takes the coordinator’s assignment in coordinated mode until it lapses', () => {
    const { member, bus, clock } = squad('coordinated');
    const a = member('A', { role: 'fighter' });
    bus.publish({ type: 'roles', at: clock.t, ttlMs: 5000, roles: { A: 'tank' } });
    expect(a.role()).toBe('tank');
    clock.t += 5000;
    expect(a.role()).toBe('fighter');
  });

  it('ignores an assignment that is not a known role', () => {
    const { member, bus, clock } = squad('coordinated');
    const a = member('A', { role: 'scout' });
    bus.publish({ type: 'roles', at: clock.t, ttlMs: 5000, roles: { A: 'wizard' } });
    expect(a.role()).toBe('scout');
  });

  it('reports its role, armor and bow in the heartbeat', () => {
    const { member, events } = squad();
    const s = snap(20, [], { armor: [], weapon: null });
    member('A', { role: 'ranged' }).observe({ ...s, inventory: ['bowx1', 'arrowx5'] }, IDLE);
    expect(events.find((e) => e.type === 'heartbeat')).toMatchObject({
      role: 'ranged',
      armorPoints: 0,
      canShoot: true,
    });
  });

  it('as a scout, reports a new threat at once instead of waiting for the next heartbeat', () => {
    const { member, events, clock } = squad();
    const scout = member('S', { role: 'scout' });
    const fighter = member('F');
    scout.observe(snap(20, []), IDLE);
    fighter.observe(snap(20, []), IDLE);
    clock.t += 100;
    scout.observe(snap(20, [mob(1, 10)]), IDLE);
    fighter.observe(snap(20, [mob(2, 10)]), IDLE);
    const reports = events.filter((e) => e.type === 'threats');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ agent: 'S' });
    // The same threat is not reported again before the heartbeat.
    clock.t += 100;
    scout.observe(snap(20, [mob(1, 9)]), IDLE);
    expect(events.filter((e) => e.type === 'threats')).toHaveLength(1);
  });

  it('lists the other bots, and answers calls for help at a raised threshold', () => {
    const { member, clock } = squad();
    const a = member('A');
    const b = member('B');
    a.observe(at(snap(20, []), 0), IDLE);
    b.observe(at(snap(20, []), 10), IDLE);
    clock.t += 100;
    b.observe(at(snap(20, []), 10, 11), IDLE); // hit down to 11 HP
    expect(a.allies()).toEqual([{ agent: 'B', position: { x: 10, y: 64, z: 0 }, hp: 11 }]);
    expect(a.helpNeeded({ x: 0, y: 64, z: 0 })).toBeNull(); // helpHp 8
    expect(a.helpNeeded({ x: 0, y: 64, z: 0 }, 4)?.agent).toBe('B');
  });
});
