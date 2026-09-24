import { describe, expect, it, vi } from 'vitest';
import { JevGateway, type GatewayOptions } from '../src/strategic/gateway.js';
import {
  JevError,
  type JevAnswer,
  type JevCallOptions,
  type JevClient,
  type JevRequest,
  type JevResponse,
} from '../src/strategic/jev.js';

const request: JevRequest = { model: 'jev-latest', state: 'x', questions: {} };
const call = { timeoutMs: 800, maxRetries: 0 };

const reply = (costUsd = 0.001, tokens = 800): JevResponse => ({
  model: 'jev-1.13.0',
  answers: { a: { type: 'noul', noul: 0.5 } as JevAnswer },
  usage: { inputTokens: tokens, outputTokens: 0, costUsd },
});

/** A client whose calls the test resolves or rejects by hand. */
function fakeClient() {
  const pending: Array<{
    options: JevCallOptions;
    resolve: (r: JevResponse) => void;
    reject: (e: unknown) => void;
  }> = [];
  const client: JevClient = {
    ask: vi.fn(
      (_req, options) =>
        new Promise<JevResponse>((resolve, reject) => {
          pending.push({ options, resolve, reject });
          options.signal?.addEventListener('abort', () =>
            reject(new JevError('aborted', 'cancelled')),
          );
        }),
    ),
  };
  return { client, pending };
}

function setup(over: Partial<GatewayOptions> = {}, start = Date.UTC(2026, 8, 24, 12, 0, 0)) {
  const clock = { t: start };
  const { client, pending } = fakeClient();
  const gateway = new JevGateway({
    client,
    limits: { maxCallsPerMinute: 60, dailyBudgetUsd: 1 },
    now: () => clock.t,
    cooldownMs: 5000,
    ...over,
  });
  /** Ask and immediately answer. */
  const answer = async (agent = 'a', response: JevResponse = reply()) => {
    const p = gateway.ask(agent, request, call);
    pending.at(-1)!.resolve(response);
    return p;
  };
  const fail = async (error: JevError, agent = 'a') => {
    const p = gateway.ask(agent, request, call);
    pending.at(-1)!.reject(error);
    return p;
  };
  return { gateway, clock, client, pending, answer, fail };
}

describe('JevGateway basics', () => {
  it('returns the response with its latency and counts the cost', async () => {
    const { gateway, clock, pending } = setup();
    const p = gateway.ask('a', request, call);
    clock.t += 180;
    pending[0]!.resolve(reply(0.002, 900));
    const out = await p;
    expect(out).toMatchObject({ ok: true, latencyMs: 180 });
    expect(gateway.stats()).toMatchObject({
      calls: 1,
      failures: 0,
      costUsd: 0.002,
      inputTokens: 900,
      spentTodayUsd: 0.002,
      disabledReason: null,
    });
  });

  it('passes the call settings and an abort signal to the client', async () => {
    const { gateway, client, pending } = setup();
    const p = gateway.ask('a', request, { timeoutMs: 1234, maxRetries: 1 });
    expect(client.ask).toHaveBeenCalledWith(
      request,
      expect.objectContaining({ timeoutMs: 1234, maxRetries: 1 }),
    );
    expect(pending[0]!.options.signal).toBeInstanceOf(AbortSignal);
    pending[0]!.resolve(reply());
    await p;
  });

  it('refuses without a client', async () => {
    const gateway = new JevGateway({
      client: null,
      limits: { maxCallsPerMinute: 60, dailyBudgetUsd: 1 },
    });
    expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'no-client' });
    expect(gateway.available).toBe(false);
  });

  it('is disabled by a zero budget', async () => {
    const { gateway } = setup({ limits: { maxCallsPerMinute: 60, dailyBudgetUsd: 0 } });
    expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'disabled' });
  });
});

describe('JevGateway limits', () => {
  it('stops at the daily budget and resets the next day', async () => {
    const { gateway, clock, answer } = setup({
      limits: { maxCallsPerMinute: 1000, dailyBudgetUsd: 0.01 },
    });
    expect((await answer('a', reply(0.006))).ok).toBe(true);
    expect((await answer('a', reply(0.006))).ok).toBe(true); // 0.012 spent now
    expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'budget' });
    expect(gateway.stats().spentTodayUsd).toBeCloseTo(0.012);

    clock.t += 24 * 3600 * 1000;
    expect(gateway.available).toBe(true);
    expect(gateway.stats().spentTodayUsd).toBe(0);
    expect(gateway.stats().costUsd).toBeCloseTo(0.012); // lifetime total is kept
  });

  it('applies the budget across all bots', async () => {
    const { gateway, answer } = setup({
      limits: { maxCallsPerMinute: 1000, dailyBudgetUsd: 0.01 },
    });
    await answer('a', reply(0.006));
    await answer('b', reply(0.006));
    expect(await gateway.ask('c', request, call)).toEqual({ ok: false, reason: 'budget' });
  });

  it('limits calls per minute with a sliding window', async () => {
    const { gateway, clock, answer } = setup({
      limits: { maxCallsPerMinute: 3, dailyBudgetUsd: 1 },
    });
    for (let i = 0; i < 3; i++) {
      await answer();
      clock.t += 10_000;
    }
    expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'rate-limited' });
    clock.t += 30_001; // the first call is now more than a minute old
    expect((await answer()).ok).toBe(true);
  });

  it('counts a failed call towards the rate limit', async () => {
    const { gateway, fail } = setup({ limits: { maxCallsPerMinute: 1, dailyBudgetUsd: 1 } });
    await fail(new JevError('timeout', 'slow'));
    expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'rate-limited' });
  });
});

describe('JevGateway failures', () => {
  it('reports the failure kind and counts it', async () => {
    const { gateway, fail } = setup();
    expect(await fail(new JevError('timeout', 'too slow'))).toEqual({
      ok: false,
      reason: 'timeout',
      message: 'too slow',
    });
    expect(gateway.stats()).toMatchObject({ calls: 1, failures: 1 });
  });

  it('wraps a non-Jev error as a network failure instead of throwing', async () => {
    const { gateway, pending } = setup();
    const p = gateway.ask('a', request, call);
    pending[0]!.reject(new TypeError('boom'));
    expect(await p).toMatchObject({ ok: false, reason: 'network' });
  });

  it('does not back off after a timeout or an invalid request', async () => {
    const { gateway, fail } = setup();
    await fail(new JevError('timeout', 'x'));
    await fail(new JevError('invalid', 'x'));
    expect(gateway.available).toBe(true);
  });

  it.each(['rate-limited', 'server', 'network'] as const)(
    'backs off after a %s error',
    async (kind) => {
      const { gateway, clock, fail } = setup();
      await fail(new JevError(kind, 'x'));
      expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'cooldown' });
      clock.t += 5001;
      expect(gateway.available).toBe(true);
    },
  );

  it('stops for good when the key is rejected', async () => {
    const { gateway, clock, fail } = setup();
    await fail(new JevError('auth', 'bad key', 401));
    clock.t += 3600_000;
    expect(await gateway.ask('a', request, call)).toEqual({ ok: false, reason: 'disabled' });
    expect(gateway.stats().disabledReason).toMatch(/key was rejected/);
  });

  it('stops for good when there is no credit', async () => {
    const { gateway, fail } = setup();
    await fail(new JevError('payment', 'no credit', 402));
    expect(gateway.available).toBe(false);
    expect(gateway.stats().disabledReason).toMatch(/out of credit/);
  });
});

describe('JevGateway single flight', () => {
  it('cancels a bot’s older call when it asks again, without counting a failure', async () => {
    const { gateway, pending } = setup();
    const first = gateway.ask('a', request, call);
    const second = gateway.ask('a', request, call);
    expect(pending[0]!.options.signal?.aborted).toBe(true);
    expect(await first).toEqual({ ok: false, reason: 'superseded' });
    pending[1]!.resolve(reply());
    expect((await second).ok).toBe(true);
    expect(gateway.stats().failures).toBe(0);
  });

  it('leaves other bots’ calls alone', async () => {
    const { gateway, pending } = setup();
    const a = gateway.ask('a', request, call);
    const b = gateway.ask('b', request, call);
    expect(pending[0]!.options.signal?.aborted).toBe(false);
    pending[0]!.resolve(reply());
    pending[1]!.resolve(reply());
    expect((await a).ok && (await b).ok).toBe(true);
  });

  it('cancel() aborts a bot’s pending call', async () => {
    const { gateway, pending } = setup();
    const p = gateway.ask('a', request, call);
    gateway.cancel('a');
    expect(pending[0]!.options.signal?.aborted).toBe(true);
    expect(await p).toEqual({ ok: false, reason: 'superseded' });
  });

  it('cancel() is harmless when nothing is pending', () => {
    expect(() => setup().gateway.cancel('nobody')).not.toThrow();
  });
});
