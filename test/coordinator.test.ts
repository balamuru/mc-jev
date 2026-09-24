import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blackboard } from '../src/swarm/blackboard.js';
import { InProcessBus } from '../src/swarm/bus.js';
import { COORDINATOR_QUESTION_SET, Coordinator, rolesByGear } from '../src/swarm/coordinator.js';
import type { AllyInfo } from '../src/swarm/blackboard.js';
import type { SwarmEvent } from '../src/swarm/events.js';
import { JevGateway } from '../src/strategic/gateway.js';
import { JevError, type JevAnswer } from '../src/strategic/jev.js';
import type { DecisionEntry } from '../src/telemetry/decisionLog.js';
import { scriptedClient } from './jevFixtures.js';

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 24, 12, 0, 0) }));
afterEach(() => vi.useRealTimers());

const focus = (choice: string, confidence = 0.9): Record<string, JevAnswer> => ({
  focus: { type: 'choice', choice, confidence, probabilities: {} } as unknown as JevAnswer,
});

const role = (choice: string, confidence = 0.9): JevAnswer =>
  ({ type: 'choice', choice, confidence, probabilities: {} }) as unknown as JevAnswer;

function setup(
  reply: () => Record<string, JevAnswer> | Error = () => focus('t5'),
  assignRoles = false,
) {
  const bus = new InProcessBus();
  const events: SwarmEvent[] = [];
  bus.subscribe('*', (e) => void events.push(e));
  const board = new Blackboard(bus, { claimTtlMs: 8000 });
  const { client, requests } = scriptedClient(reply);
  const gateway = new JevGateway({
    client,
    limits: { maxCallsPerMinute: 1000, dailyBudgetUsd: 1 },
  });
  const entries: DecisionEntry[] = [];
  const warnings: string[] = [];
  const coordinator = new Coordinator({
    gateway,
    board,
    bus,
    settings: {
      intervalMs: 4000,
      directiveTtlMs: 6000,
      model: 'jev-latest',
      timeoutMs: 1500,
      assignRoles,
    },
    thresholds: { act: 0.7, cautious: 0.5 },
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
    decisions: { write: (e) => void entries.push(e) },
  });
  const squad = (bots = 2, threats = 2, gear: Array<{ armor: number; bow: boolean }> = []) => {
    for (let i = 0; i < bots; i++) {
      bus.publish({
        type: 'heartbeat',
        agent: `Bot${i}`,
        at: Date.now(),
        role: 'fighter',
        position: { x: i * 3, y: 64, z: 0 },
        hp: 20 - i,
        armorPoints: gear[i]?.armor ?? 15,
        canShoot: gear[i]?.bow ?? false,
      });
    }
    bus.publish({
      type: 'threats',
      agent: 'Bot0',
      at: Date.now(),
      threats: Array.from({ length: threats }, (_, i) => ({
        id: 5 + i,
        kind: 'zombie',
        position: { x: 10 + i, y: 64, z: 4 },
      })),
    });
  };
  return { coordinator, bus, board, events, requests, entries, warnings, squad };
}

describe('Coordinator', () => {
  it('asks Jev which threat the squad should focus on, and broadcasts a directive', async () => {
    const { coordinator, requests, events, board, entries, squad } = setup();
    squad();
    await coordinator.tick();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.state).toMatchObject({
      squad: [
        { name: 'Bot0', hp: 20 },
        { name: 'Bot1', hp: 19 },
      ],
      threats: [{ id: 't5', kind: 'zombie' }, { id: 't6' }],
    });
    expect(Object.keys(requests[0]!.questions)).toEqual(['focus']);
    expect(Object.keys((requests[0]!.questions.focus as { criteria: object }).criteria)).toEqual([
      'none',
      't5',
      't6',
    ]);
    expect(events.find((e) => e.type === 'directive')).toMatchObject({
      focusTargetId: 5,
      ttlMs: 6000,
    });
    expect(board.focusTarget()).toBe(5);
    expect(entries[0]).toMatchObject({
      agent: 'coordinator',
      questionSet: COORDINATOR_QUESTION_SET,
      outcome: 'applied',
      why: 'squad focus on t5',
    });
    expect(entries[0]!.costUsd).toBeGreaterThan(0);
  });

  it.each([
    ['a lone bot', 1, 3],
    ['a single threat', 3, 1],
    ['no threats', 3, 0],
  ])('does not ask with %s', async (_name, bots, threats) => {
    const { coordinator, requests, squad } = setup();
    squad(bots, threats);
    await coordinator.tick();
    expect(requests).toHaveLength(0);
  });

  it('issues no directive when Jev is not confident, or picks none', async () => {
    for (const answer of [focus('t5', 0.4), focus('none', 0.95)]) {
      const { coordinator, events, entries, squad } = setup(() => answer);
      squad();
      await coordinator.tick();
      expect(events.some((e) => e.type === 'directive')).toBe(false);
      expect(entries[0]).toMatchObject({ outcome: 'rules' });
    }
  });

  it('ignores an answer about a target that has since disappeared', async () => {
    const { coordinator, events, entries, squad } = setup(() => focus('t99'));
    squad();
    await coordinator.tick();
    expect(events.some((e) => e.type === 'directive')).toBe(false);
    expect(entries[0]).toMatchObject({ outcome: 'stale' });
  });

  it('ignores an unusable answer', async () => {
    const { coordinator, events, squad } = setup(
      () => ({ focus: { type: 'noul', noul: 0.5 } }) as never,
    );
    squad();
    await coordinator.tick();
    expect(events.some((e) => e.type === 'directive')).toBe(false);
  });

  it('leaves the bots to themselves when Jev fails, and warns once', async () => {
    const { coordinator, events, entries, warnings, squad } = setup(
      () => new JevError('timeout', 'slow'),
    );
    squad();
    await coordinator.tick();
    await coordinator.tick();
    expect(events.some((e) => e.type === 'directive')).toBe(false);
    expect(entries.map((e) => e.error)).toEqual(['timeout', 'timeout']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/bots choose targets on their own/);
  });

  it('does not start a second question while one is pending', async () => {
    const { coordinator, requests, squad } = setup();
    squad();
    const first = coordinator.tick();
    await coordinator.tick();
    await first;
    expect(requests).toHaveLength(1);
  });

  it('runs on its interval once started, and stops when stopped', async () => {
    const { coordinator, requests, squad } = setup();
    squad();
    coordinator.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(requests).toHaveLength(1);
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(requests).toHaveLength(1);
  });

  describe('role assignment', () => {
    const gear = [
      { armor: 15, bow: false },
      { armor: 20, bow: false },
      { armor: 5, bow: true },
    ];

    it('asks one role question per bot in the same request, offering ranged only with a bow', async () => {
      const { coordinator, requests, squad } = setup(() => focus('t5'), true);
      squad(3, 2, gear);
      await coordinator.tick();
      expect(requests).toHaveLength(1);
      const q = requests[0]!.questions as Record<
        string,
        { criteria: object; instructions: string }
      >;
      expect(Object.keys(q)).toEqual(['focus', 'role_0', 'role_1', 'role_2']);
      expect(Object.keys(q.role_0!.criteria)).toEqual(['fighter', 'tank', 'support']);
      expect(Object.keys(q.role_2!.criteria)).toEqual(['fighter', 'tank', 'support', 'ranged']);
      expect(q.role_1!.instructions).toContain('"Bot1"');
      expect(requests[0]!.state).toMatchObject({
        squad: [{ armor_points: 15, has_bow_and_arrows: false }, {}, { has_bow_and_arrows: true }],
      });
    });

    it('asks about roles even with a single threat, but not about focus', async () => {
      const { coordinator, requests, squad } = setup(() => ({}), true);
      squad(2, 1);
      await coordinator.tick();
      expect(Object.keys(requests[0]!.questions)).toEqual(['role_0', 'role_1']);
    });

    it('applies confident, valid roles and ignores the rest', async () => {
      const { coordinator, events, board, entries, squad } = setup(
        () => ({
          ...focus('t5'),
          role_0: role('tank'),
          role_1: role('support', 0.3), // not confident: ignored
          role_2: role('ranged'),
        }),
        true,
      );
      squad(3, 2, gear);
      await coordinator.tick();
      expect(events.find((e) => e.type === 'roles')).toMatchObject({
        ttlMs: 6000,
        roles: { Bot0: 'tank', Bot2: 'ranged' },
      });
      expect(board.assignedRole('Bot0')).toBe('tank');
      expect(board.assignedRole('Bot1')).toBeNull();
      expect(entries[0]).toMatchObject({
        outcome: 'applied',
        why: 'squad focus on t5; roles: Bot0 tank, Bot2 ranged',
      });
      vi.advanceTimersByTime(6000);
      expect(board.assignedRole('Bot0')).toBeNull();
    });

    it('never makes a bot without a bow ranged, whatever Jev says', async () => {
      const { coordinator, events, squad } = setup(
        () => ({ role_0: role('ranged'), role_1: role('wizard') }),
        true,
      );
      squad(2, 1);
      await coordinator.tick();
      expect(events.some((e) => e.type === 'roles')).toBe(false);
    });

    it('assigns roles by gear when Jev is unavailable', async () => {
      const { coordinator, events, entries, warnings, squad } = setup(
        () => new JevError('timeout', 'slow'),
        true,
      );
      squad(3, 1, gear);
      await coordinator.tick();
      expect(events.find((e) => e.type === 'roles')).toMatchObject({
        roles: { Bot0: 'fighter', Bot1: 'tank', Bot2: 'ranged' },
      });
      expect(entries[0]).toMatchObject({ outcome: 'error', error: 'timeout' });
      expect(entries[0]!.why).toContain('roles by gear');
      expect(warnings[0]).toMatch(/roles are assigned by gear/);
    });
  });
});

describe('rolesByGear', () => {
  const ally = (
    agent: string,
    armorPoints: number,
    canShoot = false,
    role = 'fighter',
  ): AllyInfo => ({
    agent,
    role,
    position: { x: 0, y: 64, z: 0 },
    hp: 20,
    lastHeartbeat: 0,
    lastDamagedAt: null,
    armorPoints,
    canShoot,
  });

  it('makes the best-armored bot the tank and everyone else a fighter', () => {
    expect(rolesByGear([ally('A', 8), ally('B', 20), ally('C', 15)])).toEqual({
      A: 'fighter',
      B: 'tank',
      C: 'fighter',
    });
  });

  it('makes the least-armored bot with a bow ranged, and picks the tank from the rest', () => {
    expect(rolesByGear([ally('A', 20, true), ally('B', 10, true), ally('C', 15)])).toEqual({
      A: 'tank',
      B: 'ranged',
      C: 'fighter',
    });
  });

  it('breaks ties by name, and assigns nothing to a lone bot', () => {
    expect(rolesByGear([ally('B', 15), ally('A', 15)])).toEqual({ A: 'tank', B: 'fighter' });
    expect(rolesByGear([ally('A', 15)])).toEqual({});
  });

  it('on a tie, keeps a bot in the role it already has', () => {
    // A picked up a bow mid-fight; C was already ranged, and B already the tank.
    const squad = [
      ally('A', 15, true),
      ally('B', 15, false, 'tank'),
      ally('C', 15, true, 'ranged'),
    ];
    expect(rolesByGear(squad)).toEqual({ A: 'fighter', B: 'tank', C: 'ranged' });
  });
});
