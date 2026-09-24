import { describe, expect, it } from 'vitest';
import { formatSummary, parseJsonl, summarize } from '../src/telemetry/analyze.js';
import type { DecisionEntry } from '../src/telemetry/decisionLog.js';

const entry = (over: Partial<DecisionEntry> = {}): DecisionEntry => ({
  time: '2026-09-24T12:00:00.000Z',
  agent: 'Bot',
  trigger: 'event:newThreat',
  questionSet: 'v2',
  outcome: 'rules',
  why: 'x',
  situation: 's',
  ...over,
});
const answered = (over: Partial<DecisionEntry> & { conf?: number; tactic?: string } = {}) =>
  entry({
    latencyMs: 200,
    costUsd: 0.00003,
    inputTokens: 700,
    answers: {
      tactic: { choice: over.tactic ?? 'engage', confidence: over.conf ?? 0.8 },
      target: { id: 1, confidence: 0.9 },
      threatLevel: { score: 1, confidence: 0.5 },
      ambush: 0.1,
    },
    ...over,
  });

describe('parseJsonl', () => {
  it('reads valid lines and counts the rest', () => {
    const good = JSON.stringify(entry());
    const { entries, bad } = parseJsonl(`${good}\nnot json\n\n{"foo":1}\n${good}\n`);
    expect(entries).toHaveLength(2);
    expect(bad).toBe(2);
  });

  it('handles an empty file', () => {
    expect(parseJsonl('')).toEqual({ entries: [], bad: 0 });
  });
});

describe('summarize', () => {
  it('is well-behaved with nothing to summarize', () => {
    const s = summarize([]);
    expect(s).toMatchObject({
      entries: 0,
      latencyMs: null,
      costUsd: 0,
      costPerCallUsd: null,
      jevChangedRules: null,
      suggestedTimeoutMs: null,
      timeoutRate: null,
    });
  });

  it('counts outcomes, agents and triggers, and the share where Jev changed the rules', () => {
    const s = summarize([
      answered({ outcome: 'applied' }),
      answered({ outcome: 'rules', agent: 'Other', trigger: 'interval' }),
      answered({ outcome: 'rules' }),
      answered({ outcome: 'rules' }),
      answered({ outcome: 'stale' }),
    ]);
    expect(s.outcomes).toEqual({ applied: 1, rules: 3, stale: 1 });
    expect(s.agents).toEqual({ Bot: 4, Other: 1 });
    expect(s.triggers).toEqual({ 'event:newThreat': 4, interval: 1 });
    expect(s.jevChangedRules).toBeCloseTo(0.25); // 1 of the 4 that were applied or left to the rules
  });

  it('computes latency percentiles and suggests a timeout with headroom', () => {
    const entries = Array.from({ length: 100 }, (_, i) => answered({ latencyMs: (i + 1) * 10 }));
    const s = summarize(entries);
    expect(s.latencyMs).toMatchObject({
      count: 100,
      min: 10,
      p50: 500,
      p90: 900,
      p99: 990,
      max: 1000,
    });
    expect(s.latencyMs!.mean).toBeCloseTo(505);
    expect(s.suggestedTimeoutMs).toBe(1500); // 990 * 1.5 = 1485, rounded up to the next 100
  });

  it('sums cost and tokens and reports the cost per priced call', () => {
    const s = summarize([answered({ costUsd: 0.00002 }), answered({ costUsd: 0.00004 }), entry()]);
    expect(s.costUsd).toBeCloseTo(0.00006);
    expect(s.inputTokens).toBe(1400);
    expect(s.costPerCallUsd).toBeCloseTo(0.00003);
  });

  it('groups errors by reason and works out the timeout rate among calls that reached Jev', () => {
    const s = summarize([
      answered(),
      answered(),
      answered(),
      entry({ outcome: 'error', error: 'timeout' }),
      entry({ outcome: 'error', error: 'budget' }), // never sent
    ]);
    expect(s.errors).toEqual({ timeout: 1, budget: 1 });
    expect(s.timeoutRate).toBeCloseTo(0.25);
  });

  it('reports how confident Jev was per tactic against the thresholds', () => {
    const s = summarize(
      [
        answered({ tactic: 'engage', conf: 0.9 }),
        answered({ tactic: 'engage', conf: 0.6 }),
        answered({ tactic: 'engage', conf: 0.4 }),
        answered({ tactic: 'retreat', conf: 0.95 }),
      ],
      { act: 0.7, cautious: 0.5 },
    );
    expect(s.tactics.engage).toMatchObject({ count: 3, atOrAboveCautious: 2, atOrAboveAct: 1 });
    expect(s.tactics.engage!.meanConfidence).toBeCloseTo(0.6333, 3);
    expect(s.tactics.retreat).toMatchObject({ count: 1, atOrAboveAct: 1 });
  });
});

describe('summarize: how often Jev really differed', () => {
  const decided = (
    intent: { tactic: string; targetId?: number },
    rulesIntent: { tactic: string; targetId?: number },
  ) => answered({ outcome: 'applied', intent: { ...intent, reason: 'x' }, rulesIntent });

  it('counts a different tactic or a different target, but not an identical choice', () => {
    const s = summarize([
      decided({ tactic: 'engage', targetId: 1 }, { tactic: 'engage', targetId: 1 }),
      decided({ tactic: 'engage', targetId: 2 }, { tactic: 'engage', targetId: 1 }),
      decided({ tactic: 'idle' }, { tactic: 'engage', targetId: 1 }),
      decided({ tactic: 'engage', targetId: 1 }, { tactic: 'engage', targetId: 1 }),
    ]);
    expect(s.jevDifferedFromRules).toBeCloseTo(0.5);
    expect(s.jevChangedRules).toBe(1); // all four were "applied"
  });

  it('is null when the rules’ intent was not logged (older logs)', () => {
    expect(summarize([answered({ outcome: 'applied' })]).jevDifferedFromRules).toBeNull();
  });
});

describe('formatSummary', () => {
  it('writes a readable report', () => {
    const text = formatSummary(
      summarize([answered({ outcome: 'applied' }), entry({ outcome: 'error', error: 'timeout' })]),
    );
    expect(text).toContain('2 decisions from 1 agent(s)');
    expect(text).toContain('outcomes: applied 1, error 1');
    expect(text).toContain('errors: timeout 1');
    expect(text).toMatch(/latency: p50 200ms/);
    expect(text).toMatch(/cost: \$0\.000030 over 700 input tokens/);
    expect(text).toContain('tactic engage: 1x');
  });

  it('copes with an empty summary', () => {
    expect(formatSummary(summarize([]))).toContain('0 decisions');
  });
});
