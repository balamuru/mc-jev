import { appendFileSync, mkdirSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { describe, expect, it } from 'vitest';
import { JevGateway } from '../../src/strategic/gateway.js';
import { createJevClient } from '../../src/strategic/jev.js';
import { buildQuestions, buildState, parseJudgment } from '../../src/strategic/questions.js';
import { mob, snap } from '../fixtures.js';

// Real calls through the configured provider (OpenRouter by default in .env).
// Total spend for this file is a small fraction of a cent.
loadEnv({ quiet: true });
const apiKey = process.env.TYPESAFE_API_KEY;
const baseURL = process.env.TYPESAFE_BASE_URL || undefined;

const model = process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest';
const live = apiKey ? describe : describe.skip;

/** Vitest hides console output of passing tests, so measurements go to a file too. */
function note(record: unknown): void {
  mkdirSync('logs', { recursive: true });
  appendFileSync('logs/live-smoke.jsonl', `${JSON.stringify(record)}\n`);
}

live('Jev live smoke test', () => {
  const client = createJevClient({ apiKey: apiKey!, baseURL });
  const gateway = new JevGateway({
    client,
    limits: { maxCallsPerMinute: 30, dailyBudgetUsd: 0.05 },
  });
  const ask = (snapshot: ReturnType<typeof snap>) =>
    gateway.ask(
      'live',
      {
        model,
        state: buildState(snapshot, 16),
        questions: buildQuestions(snapshot, 16),
      },
      { timeoutMs: 10_000, maxRetries: 1 },
    );

  it('answers the real question set in the expected shape', async () => {
    const out = await ask(snap(20, [mob(5, 4)]));
    if (!out.ok) throw new Error(`Jev call failed: ${out.reason} ${out.message ?? ''}`);

    const judgment = parseJudgment(out.response.answers);
    expect(judgment).not.toBeNull();
    expect(out.response.usage.inputTokens).toBeGreaterThan(0);
    expect(out.response.usage.costUsd).toBeGreaterThan(0);
    note({
      test: 'shape',
      latencyMs: out.latencyMs,
      inputTokens: out.response.usage.inputTokens,
      costUsd: out.response.usage.costUsd,
      model: out.response.model,
      judgment,
    });
  });

  it('judges a hopeless fight as more dangerous than an easy one', async () => {
    const easy = await ask(snap(20, [mob(5, 6)]));
    const deadly = await ask(
      snap(3, [mob(1, 2), mob(2, 3), mob(3, 3), mob(4, 4)], { armor: [], weapon: null }),
    );
    if (!easy.ok || !deadly.ok) throw new Error('a Jev call failed');
    const e = parseJudgment(easy.response.answers)!;
    const d = parseJudgment(deadly.response.answers)!;
    note({ test: 'easy-vs-deadly', easy: e, deadly: d, spentUsd: gateway.stats().costUsd });
    expect(d.threatLevel.score).toBeGreaterThan(e.threatLevel.score);
  });

  it('reports a rejected key as an auth failure, not a crash', async () => {
    const bad = new JevGateway({
      client: createJevClient({ apiKey: 'sk-invalid-key-for-test', baseURL }),
      limits: { maxCallsPerMinute: 5, dailyBudgetUsd: 0.05 },
    });
    const out = await bad.ask(
      'live',
      { model, state: 'x', questions: { q: { type: 'noul', instructions: 'Is it?' } } },
      { timeoutMs: 10_000, maxRetries: 0 },
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(['auth', 'invalid']).toContain(out.reason);
  });
});
