import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Intent } from '../src/intent.js';
import { IDLE } from '../src/intent.js';
import { JevGateway } from '../src/strategic/gateway.js';
import { JevError, type JevAnswer } from '../src/strategic/jev.js';
import {
  MIN_OVERRIDE_TTL_MS,
  STALE_HP_DROP,
  StrategicLayer,
  type StrategicDeps,
} from '../src/strategic/layer.js';
import { QUESTION_SET_VERSION } from '../src/strategic/questions.js';
import type { DecisionEntry } from '../src/telemetry/decisionLog.js';
import { mob, rules, snap } from './fixtures.js';
import { answers, scriptedClient } from './jevFixtures.js';

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 24, 12, 0, 0) }));
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);

function setup(
  reply: () => Record<string, JevAnswer> | Error = () =>
    answers({ tactic: 'retreat', tacticConfidence: 0.9 }),
  over: Partial<StrategicDeps> = {},
) {
  const { client, requests } = scriptedClient(reply);
  const gateway = new JevGateway({
    client,
    limits: { maxCallsPerMinute: 1000, dailyBudgetUsd: 1 },
  });
  const applied: Array<{ intent: Intent; ttlMs: number }> = [];
  const state = { intent: IDLE as Intent, cleared: 0 };
  const entries: DecisionEntry[] = [];
  const warnings: string[] = [];
  const layer = new StrategicLayer({
    agentId: 'Bot',
    strategic: {
      intervalMs: 2000,
      eventTriggers: ['hurt', 'newThreat', 'lowHp'],
      minGapMs: 250,
    } as StrategicDeps['strategic'],
    jev: {
      model: 'jev-latest',
      timeoutMs: 800,
      maxRetries: 0,
      thresholds: { act: 0.7, cautious: 0.5 },
    },
    rules,
    gateway,
    currentIntent: () => state.intent,
    apply: (intent, ttlMs) => applied.push({ intent, ttlMs }),
    clear: () => void state.cleared++,
    log: { info() {}, warn: (m) => warnings.push(m), error() {} },
    decisions: { write: (e) => void entries.push(e) },
    ...over,
  });
  layer.start();
  return { layer, gateway, client, requests, applied, state, entries, warnings };
}

describe('StrategicLayer triggers', () => {
  it('does not call Jev when there are no threats, however long it waits', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, []));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(0);
  });

  it('ignores neutral mobs and threats out of range', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [mob(1, 5, { kind: 'enderman' }), mob(2, 40)]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(0);
  });

  it('calls Jev straight away when a new threat appears', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe('jev-latest');
    expect(Object.keys(requests[0]!.questions)).toEqual([
      'tactic',
      'target',
      'threat_level',
      'ambush',
    ]);
  });

  it('does not call again for the same threat until the interval', async () => {
    const { layer, requests } = setup();
    const s = snap(20, [mob(1, 5)]);
    layer.observe(s);
    await flush();
    layer.observe(s);
    layer.observe(s);
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600); // interval passes
    expect(requests).toHaveLength(2);
  });

  it('calls when HP drops, and when it falls to the retreat floor', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(1);
    layer.observe(snap(17, [mob(1, 5)])); // hurt
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(2);
    layer.observe(snap(6, [mob(1, 5)])); // hurt and low HP
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(3);
  });

  it('does not treat tiny HP jitter as being hurt', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);
    layer.observe(snap(19.8, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(1);
  });

  it('only reacts to the configured trigger events', async () => {
    const { layer, requests } = setup(undefined, {
      strategic: { intervalMs: 2000, eventTriggers: ['hurt'], minGapMs: 250 },
    });
    layer.observe(snap(20, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(0); // newThreat is not configured
    layer.observe(snap(15, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(1);
  });

  it('waits out the minimum gap, then makes one trailing call', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(requests).toHaveLength(1);
    layer.observe(snap(15, [mob(1, 5)])); // hurt, 0ms after the last call
    layer.observe(snap(10, [mob(1, 5)])); // hurt again
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(requests).toHaveLength(2); // exactly one call for both events
  });
});

describe('StrategicLayer decisions', () => {
  it('asks about the state it was given and applies a confident answer as an override', async () => {
    const { layer, applied, entries } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();

    expect(applied).toHaveLength(1);
    expect(applied[0]!.intent).toMatchObject({ tactic: 'retreat', targetId: 1 });
    expect(applied[0]!.ttlMs).toBe(3000); // 1.5 x the 2000ms interval

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: 'Bot',
      trigger: 'event:newThreat',
      questionSet: QUESTION_SET_VERSION,
      model: 'jev-1.13.0',
      outcome: 'applied',
      why: 'jev voted to retreat',
      inputTokens: 900,
      costUsd: 0.0000378,
      intent: { tactic: 'retreat', targetId: 1 },
      answers: { tactic: { choice: 'retreat', confidence: 0.9 }, ambush: 0.1 },
    });
    expect(entries[0]!.situation).toContain('zombie 5.0m');
    expect(entries[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('never holds an override for less than the minimum time', async () => {
    const { layer, applied } = setup(undefined, {
      strategic: { intervalMs: 100, eventTriggers: ['newThreat'], minGapMs: 0 },
    });
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(applied[0]!.ttlMs).toBe(MIN_OVERRIDE_TTL_MS);
  });

  it('hands control back to the rules when Jev does not change anything', async () => {
    const { layer, applied, state, entries } = setup(() =>
      answers({ tactic: 'engage', tacticConfidence: 0.2 }),
    );
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(applied).toHaveLength(0);
    expect(state.cleared).toBe(1);
    expect(entries[0]).toMatchObject({ outcome: 'rules' });
  });

  it('feeds the current intent to the rules for their hysteresis', async () => {
    // At 10 HP after retreating the rules keep retreating; a merely fairly-sure Jev engage cannot change that.
    const retreating: Intent = { tactic: 'retreat', targetId: 1, reason: 'x' };
    const { layer, applied, entries } = setup(
      () => answers({ tactic: 'engage', tacticConfidence: 0.6 }),
      { currentIntent: () => retreating },
    );
    layer.observe(snap(10, [mob(1, 5)]));
    await flush();
    expect(entries[0]).toMatchObject({ outcome: 'rules', why: 'rules retreat stands' });
    expect(applied).toHaveLength(0);
  });
});

describe('StrategicLayer freshness', () => {
  /** Ask, then change the world before the answer is applied. */
  async function changedWorld(
    next: ReturnType<typeof snap>,
    reply?: () => Record<string, JevAnswer>,
  ) {
    const s = setup(
      reply ?? (() => answers({ tactic: 'engage', target: 't1', targetConfidence: 0.9 })),
    );
    s.layer.observe(snap(20, [mob(1, 5)]));
    s.layer.observe(next); // arrives before the async answer is processed
    await flush();
    return s;
  }

  it('throws away an answer whose target has gone', async () => {
    const { applied, state, entries } = await changedWorld(snap(20, [mob(2, 6)]));
    expect(applied).toHaveLength(0);
    expect(state.cleared).toBe(0);
    expect(entries[0]).toMatchObject({ outcome: 'stale', why: 'the chosen target is gone' });
  });

  it('throws away an answer when HP fell a lot while it was in flight', async () => {
    const { applied, entries } = await changedWorld(snap(20 - STALE_HP_DROP, [mob(1, 5)]));
    expect(applied).toHaveLength(0);
    expect(entries[0]).toMatchObject({ outcome: 'stale', why: 'HP dropped while waiting' });
  });

  it('throws away an answer when every threat is gone', async () => {
    const { applied, entries } = await changedWorld(snap(20, []), () =>
      answers({ tactic: 'retreat', target: 'none' }),
    );
    expect(applied).toHaveLength(0);
    expect(entries[0]).toMatchObject({ outcome: 'stale', why: 'the threats are gone' });
  });

  it('still records the cost and answers of a stale reply', async () => {
    const { entries } = await changedWorld(snap(20, [mob(2, 6)]));
    expect(entries[0]).toMatchObject({ costUsd: 0.0000378, inputTokens: 900 });
    expect(entries[0]!.answers?.tactic.choice).toBe('engage');
  });
});

describe('StrategicLayer failures', () => {
  it('falls back to the rules on an error, records it, and warns only once', async () => {
    const { layer, applied, state, entries, warnings } = setup(
      () => new JevError('timeout', 'too slow'),
    );
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    layer.observe(snap(15, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);
    layer.observe(snap(11, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(300);

    expect(applied).toHaveLength(0);
    expect(state.cleared).toBe(0);
    expect(entries.map((e) => [e.outcome, e.error])).toEqual([
      ['error', 'timeout'],
      ['error', 'timeout'],
      ['error', 'timeout'],
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Jev unavailable \(timeout: too slow\); the rules are deciding/);
  });

  it('records a refusal such as an exhausted budget without a message', async () => {
    const { client, requests } = scriptedClient(() => answers());
    const gateway = new JevGateway({
      client,
      limits: { maxCallsPerMinute: 60, dailyBudgetUsd: 0 },
    });
    const { layer, entries } = setup(undefined, { gateway });
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(requests).toHaveLength(0);
    expect(entries[0]).toMatchObject({ outcome: 'error', error: 'disabled' });
  });

  it('records an answer of the wrong shape as invalid and changes nothing', async () => {
    const { layer, applied, state, entries } = setup(
      () => ({ tactic: { type: 'noul', noul: 0.5 } }) as never,
    );
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(applied).toHaveLength(0);
    expect(state.cleared).toBe(0);
    expect(entries[0]).toMatchObject({ outcome: 'invalid' });
  });
});

describe('StrategicLayer and hostile players', () => {
  const stranger = mob(11, 5, {
    category: 'player',
    kind: 'Stranger',
    held: 'iron_sword',
    provoked: false,
  });

  it('asks about strangers and reports the ones Jev is sure about', async () => {
    const hostile: Array<[string[], number]> = [];
    const { layer, requests, entries } = setup(() => answers({ players: { 11: 0.95 } }), {
      onHostilePlayers: (names, ttl) => void hostile.push([names, ttl]),
    });
    layer.observe(snap(20, [mob(1, 6), stranger]));
    await flush();
    expect(Object.keys(requests[0]!.questions)).toContain('hostile_p11');
    expect(hostile).toEqual([[['Stranger'], 10_000]]);
    expect(entries[0]).toMatchObject({ hostilePlayers: ['Stranger'] });
  });

  it('asks about a lone stranger even with no mob around, and only once until something changes', async () => {
    const { layer, requests } = setup(() => answers({ players: { 11: 0.2 } }));
    const s = snap(20, [stranger]);
    layer.observe(s);
    await flush();
    expect(requests).toHaveLength(1);
    layer.observe(s);
    await vi.advanceTimersByTimeAsync(500);
    expect(requests).toHaveLength(1); // the same stranger is not new
  });

  it('does not report a stranger Jev is unsure about', async () => {
    const hostile: string[][] = [];
    const { layer, entries } = setup(() => answers({ players: { 11: 0.5 } }), {
      onHostilePlayers: (names) => void hostile.push(names),
    });
    layer.observe(snap(20, [mob(1, 6), stranger]));
    await flush();
    expect(hostile).toEqual([]);
    expect(entries[0]).not.toHaveProperty('hostilePlayers');
  });

  it('asks nothing about players when pvp is off', async () => {
    const { layer, requests } = setup(undefined, { rules: { ...rules, pvp: false } });
    layer.observe(snap(20, [mob(1, 6), stranger]));
    await flush();
    expect(Object.keys(requests[0]!.questions)).not.toContain('hostile_p11');
  });

  it('asks about a player who attacked the bot, as a threat', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [{ ...stranger, provoked: true }]));
    await flush();
    expect(requests).toHaveLength(1); // a provoked player alone is reason enough to decide
  });
});

describe('StrategicLayer when held off', () => {
  it('asks nothing while inactive, and treats the threats as new when it resumes', async () => {
    const state = { active: false };
    const { layer, requests } = setup(undefined, { active: () => state.active });
    const s = snap(20, [mob(1, 5)]);
    layer.observe(s);
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(0);

    state.active = true;
    layer.observe(s); // the same threat, but it was never "used up" while held off
    await flush();
    expect(requests).toHaveLength(1);
  });
});

describe('StrategicLayer lifecycle', () => {
  it('makes no calls before it is started or after it is stopped', async () => {
    const { layer, requests } = setup();
    layer.stop();
    layer.observe(snap(20, [mob(1, 5)]));
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(0);
  });

  it('ignores an answer that arrives after it was stopped', async () => {
    const { layer, applied, entries } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    layer.stop();
    await flush();
    expect(applied).toHaveLength(0);
    expect(entries).toHaveLength(0);
  });

  it('forgets the situation on reset, and waits for a fresh snapshot', async () => {
    const { layer, requests } = setup();
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    layer.reset();
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests).toHaveLength(1); // the interval found nothing to decide about
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(requests).toHaveLength(2); // and the same threat counts as new again
  });

  it('can be started again after being stopped', async () => {
    const { layer, requests } = setup();
    layer.stop();
    layer.start();
    layer.observe(snap(20, [mob(1, 5)]));
    await flush();
    expect(requests).toHaveLength(1);
  });
});
