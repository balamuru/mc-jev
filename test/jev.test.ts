import { APIConnectionError, APIError, APITimeoutError, APIUserAbortError } from '@typesafe-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  INPUT_USD_PER_TOKEN,
  installAbortGuard,
  isAbortLike,
  JevError,
  costOf,
  createJevClient,
  toJevError,
} from '../src/strategic/jev.js';

const httpError = (status: number) => APIError.fromResponse(status, { error: 'x' }, new Headers());

describe('toJevError', () => {
  it.each([
    [httpError(401), 'auth', 401],
    [httpError(403), 'auth', 403],
    [httpError(402), 'payment', 402],
    [httpError(429), 'rate-limited', 429],
    [httpError(529), 'rate-limited', 529],
    [httpError(500), 'server', 500],
    [httpError(503), 'server', 503],
    [httpError(400), 'invalid', 400],
    [httpError(422), 'invalid', 422],
    [httpError(404), 'invalid', 404],
  ])('maps HTTP %#', (err, kind, status) => {
    const e = toJevError(err);
    expect(e).toBeInstanceOf(JevError);
    expect(e.kind).toBe(kind);
    expect(e.status).toBe(status);
  });

  it('maps timeouts before generic connection errors', () => {
    expect(toJevError(new APITimeoutError(800)).kind).toBe('timeout');
    expect(toJevError(new APIConnectionError('dns')).kind).toBe('network');
  });

  it('maps cancellation', () => {
    expect(toJevError(new APIUserAbortError()).kind).toBe('aborted');
  });

  it('treats anything unknown as a network problem and keeps JevErrors as they are', () => {
    expect(toJevError(new Error('weird')).kind).toBe('network');
    expect(toJevError('a string').kind).toBe('network');
    const own = new JevError('auth', 'x');
    expect(toJevError(own)).toBe(own);
  });
});

describe('costOf', () => {
  it('uses the provider cost when it reports one', () => {
    expect(costOf({ input_tokens: 1000, cost: 0.0005 })).toBe(0.0005);
    expect(costOf({ input_tokens: 1000, cost: 0 })).toBe(0);
  });

  it('falls back to the published token price', () => {
    expect(costOf({ input_tokens: 1_000_000 })).toBeCloseTo(0.042);
    expect(costOf({ input_tokens: 1000, cost: 'n/a' })).toBeCloseTo(1000 * INPUT_USD_PER_TOKEN);
    expect(costOf({ input_tokens: 1000, cost: -1 })).toBeCloseTo(1000 * INPUT_USD_PER_TOKEN);
  });
});

describe('createJevClient (real SDK, fake network)', () => {
  const request = {
    model: 'jev-latest',
    state: { self: { hp: 20 } },
    questions: { ambush: { type: 'noul' as const, instructions: 'Ambush?' } },
  };
  const options = { timeoutMs: 500, maxRetries: 0 };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts to /v1/systemone under the base URL with a bearer key, and parses the result', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      json({
        model: 'typesafe/jev-1.13',
        answers: { ambush: { type: 'noul', noul: 0.25 } },
        usage: { input_tokens: 800, output_tokens: 0, cost: 0.0000336 },
      }),
    );
    const client = createJevClient({
      apiKey: 'sk-test-123',
      baseURL: 'https://openrouter.ai/api',
      fetch,
    });
    const r = await client.ask(request, options);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://openrouter.ai/api/v1/systemone');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test-123');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'jev-latest',
      state: { self: { hp: 20 } },
      questions: { ambush: { type: 'noul' } },
    });
    expect(r).toEqual({
      model: 'typesafe/jev-1.13',
      answers: { ambush: { type: 'noul', noul: 0.25 } },
      usage: { inputTokens: 800, outputTokens: 0, costUsd: 0.0000336 },
    });
  });

  it('computes cost from tokens when the provider reports none', async () => {
    const fetch = async () =>
      json({
        model: 'jev-1.13.0',
        answers: { ambush: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 2000, output_tokens: 0 },
      });
    const r = await createJevClient({ apiKey: 'k', fetch }).ask(request, options);
    expect(r.usage.costUsd).toBeCloseTo(2000 * INPUT_USD_PER_TOKEN);
  });

  it('turns HTTP failures into typed JevErrors', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [402, 'payment'],
      [429, 'rate-limited'],
      [500, 'server'],
      [422, 'invalid'],
    ] as const) {
      const client = createJevClient({
        apiKey: 'k',
        fetch: async () => json({ error: 'no' }, status),
      });
      await expect(client.ask(request, options)).rejects.toMatchObject({ kind, status });
    }
  });

  it('reports a slow server as a timeout', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      });
    const client = createJevClient({ apiKey: 'k', fetch: hang });
    await expect(client.ask(request, { timeoutMs: 50, maxRetries: 0 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('reports cancellation as aborted', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted')),
        );
      });
    const controller = new AbortController();
    const client = createJevClient({ apiKey: 'k', fetch: hang });
    const pending = client.ask(request, {
      timeoutMs: 5000,
      maxRetries: 0,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('reports a dropped connection as a network error', async () => {
    const client = createJevClient({
      apiKey: 'k',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(client.ask(request, options)).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('the abort guard for the SDK’s leaked rejections', () => {
  it('recognizes abort and timeout errors, and nothing else', () => {
    expect(isAbortLike(new DOMException('This operation was aborted', 'AbortError'))).toBe(true);
    expect(isAbortLike(new APIUserAbortError())).toBe(true);
    expect(isAbortLike(new APITimeoutError(800))).toBe(true);
    const named = new Error('x');
    named.name = 'AbortError';
    expect(isAbortLike(named)).toBe(true);
    expect(isAbortLike(new Error('boom'))).toBe(false);
    expect(isAbortLike(new TypeError('fetch failed'))).toBe(false);
    expect(isAbortLike('AbortError')).toBe(false);
    expect(isAbortLike(undefined)).toBe(false);
  });

  it('is installed once however many clients are created', () => {
    const before = process.listenerCount('unhandledRejection');
    createJevClient({ apiKey: 'k', fetch: async () => new Response('{}') });
    createJevClient({ apiKey: 'k', fetch: async () => new Response('{}') });
    installAbortGuard();
    expect(process.listenerCount('unhandledRejection')).toBeLessThanOrEqual(before + 1);
    const after = process.listenerCount('unhandledRejection');
    installAbortGuard();
    expect(process.listenerCount('unhandledRejection')).toBe(after);
  });

  it('lets a real unhandled error through: the listener throws for anything but an abort', () => {
    createJevClient({ apiKey: 'k', fetch: async () => new Response('{}') });
    const listeners = process.listeners('unhandledRejection') as Array<(r: unknown) => void>;
    const guard = listeners.find((l) => l.toString().includes('isAbortLike'));
    expect(guard).toBeDefined();
    expect(() => guard!(new DOMException('aborted', 'AbortError'))).not.toThrow();
    expect(() => guard!(new Error('a real bug'))).toThrow('a real bug');
  });
});
