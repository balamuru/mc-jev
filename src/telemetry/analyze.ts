import type { DecisionEntry } from './decisionLog.js';

export interface LatencyStats {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface TacticStats {
  count: number;
  meanConfidence: number;
  /** How many were at or above each threshold. */
  atOrAboveCautious: number;
  atOrAboveAct: number;
}

export interface DecisionSummary {
  entries: number;
  agents: Record<string, number>;
  triggers: Record<string, number>;
  outcomes: Record<string, number>;
  /** Failure reasons for `error` outcomes, e.g. `timeout`. */
  errors: Record<string, number>;
  latencyMs: LatencyStats | null;
  costUsd: number;
  inputTokens: number;
  costPerCallUsd: number | null;
  /** Of the calls that got a usable answer, the share where Jev changed what the bot did. */
  jevChangedRules: number | null;
  /**
   * Of the decisions where the rules' own intent was logged, the share where Jev's intent was
   * actually different (another tactic or another target), not just "applied".
   */
  jevDifferedFromRules: number | null;
  /** Jev's tactic answers and how confident they were. */
  tactics: Record<string, TacticStats>;
  /** The timeout that would have covered 99% of calls with headroom, rounded up to 100ms. */
  suggestedTimeoutMs: number | null;
  timeoutRate: number | null;
}

export interface Thresholds {
  act: number;
  cautious: number;
}

const DEFAULT_THRESHOLDS: Thresholds = { act: 0.7, cautious: 0.5 };

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function count(into: Record<string, number>, key: string | undefined): void {
  if (key === undefined) return;
  into[key] = (into[key] ?? 0) + 1;
}

/** Parse a JSONL decision log. Lines that are not valid entries are counted, not fatal. */
export function parseJsonl(text: string): { entries: DecisionEntry[]; bad: number } {
  const entries: DecisionEntry[] = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<DecisionEntry>;
      if (typeof parsed.outcome === 'string' && typeof parsed.agent === 'string') {
        entries.push(parsed as DecisionEntry);
      } else bad++;
    } catch {
      bad++;
    }
  }
  return { entries, bad };
}

/** Summarize a set of decisions: how often Jev answered, how fast, how confident, what it cost. */
export function summarize(
  entries: DecisionEntry[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): DecisionSummary {
  const agents: Record<string, number> = {};
  const triggers: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const latencies: number[] = [];
  const tacticConf: Record<string, number[]> = {};
  let costUsd = 0;
  let inputTokens = 0;
  let priced = 0;
  let comparable = 0;
  let differed = 0;

  for (const e of entries) {
    count(agents, e.agent);
    count(triggers, e.trigger);
    count(outcomes, e.outcome);
    if (e.outcome === 'error') count(errors, e.error ?? 'unknown');
    if (typeof e.latencyMs === 'number') latencies.push(e.latencyMs);
    if (typeof e.costUsd === 'number') {
      costUsd += e.costUsd;
      priced++;
    }
    inputTokens += e.inputTokens ?? 0;
    if (e.intent && e.rulesIntent) {
      comparable++;
      if (e.intent.tactic !== e.rulesIntent.tactic || e.intent.targetId !== e.rulesIntent.targetId)
        differed++;
    }
    if (e.answers) (tacticConf[e.answers.tactic.choice] ??= []).push(e.answers.tactic.confidence);
  }

  latencies.sort((a, b) => a - b);
  const latencyMs: LatencyStats | null = latencies.length
    ? {
        count: latencies.length,
        min: latencies[0]!,
        mean: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        p50: percentile(latencies, 50),
        p90: percentile(latencies, 90),
        p99: percentile(latencies, 99),
        max: latencies[latencies.length - 1]!,
      }
    : null;

  const answered = (outcomes.applied ?? 0) + (outcomes.rules ?? 0);
  const tactics: Record<string, TacticStats> = {};
  for (const [tactic, confs] of Object.entries(tacticConf)) {
    tactics[tactic] = {
      count: confs.length,
      meanConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
      atOrAboveCautious: confs.filter((c) => c >= thresholds.cautious).length,
      atOrAboveAct: confs.filter((c) => c >= thresholds.act).length,
    };
  }

  // Calls that reached Jev: those that answered (they carry a latency) plus those that timed out.
  const reached = latencies.length + (errors.timeout ?? 0);
  return {
    entries: entries.length,
    agents,
    triggers,
    outcomes,
    errors,
    latencyMs,
    costUsd,
    inputTokens,
    costPerCallUsd: priced ? costUsd / priced : null,
    jevChangedRules: answered ? (outcomes.applied ?? 0) / answered : null,
    jevDifferedFromRules: comparable ? differed / comparable : null,
    tactics,
    suggestedTimeoutMs: latencyMs ? Math.ceil((latencyMs.p99 * 1.5) / 100) * 100 : null,
    timeoutRate: reached ? (errors.timeout ?? 0) / reached : null,
  };
}

const pct = (n: number | null) => (n === null ? '-' : `${(n * 100).toFixed(0)}%`);
const ms = (n: number) => `${Math.round(n)}ms`;

/** A plain-text report of a summary. */
export function formatSummary(s: DecisionSummary): string {
  const lines: string[] = [];
  lines.push(`${s.entries} decisions from ${Object.keys(s.agents).length} agent(s)`);
  lines.push(
    `outcomes: ${
      Object.entries(s.outcomes)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ') || 'none'
    }`,
  );
  if (Object.keys(s.errors).length) {
    lines.push(
      `errors: ${Object.entries(s.errors)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ')}`,
    );
  }
  if (s.latencyMs) {
    const l = s.latencyMs;
    lines.push(
      `latency: p50 ${ms(l.p50)}, p90 ${ms(l.p90)}, p99 ${ms(l.p99)}, max ${ms(l.max)} (${l.count} calls)`,
    );
    lines.push(`suggested timeout: ${s.suggestedTimeoutMs}ms; timeout rate ${pct(s.timeoutRate)}`);
  }
  lines.push(
    `cost: $${s.costUsd.toFixed(6)} over ${s.inputTokens} input tokens` +
      (s.costPerCallUsd !== null ? ` ($${s.costPerCallUsd.toFixed(6)} per call)` : ''),
  );
  lines.push(
    `jev changed what the rules would have done: ${pct(s.jevChangedRules)} of answered calls`,
  );
  for (const [tactic, t] of Object.entries(s.tactics)) {
    lines.push(
      `tactic ${tactic}: ${t.count}x, mean confidence ${(t.meanConfidence * 100).toFixed(0)}%, ` +
        `${t.atOrAboveCautious} >= cautious, ${t.atOrAboveAct} >= act`,
    );
  }
  return lines.join('\n');
}
