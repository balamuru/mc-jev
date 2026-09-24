import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from '../src/agent/backoff.js';

describe('backoffDelayMs', () => {
  const opts = { baseMs: 1000, maxMs: 30_000 };

  it('doubles each attempt', () => {
    expect([0, 1, 2, 3, 4].map((a) => backoffDelayMs(a, opts))).toEqual([
      1000, 2000, 4000, 8000, 16_000,
    ]);
  });

  it('caps at the maximum', () => {
    expect(backoffDelayMs(5, opts)).toBe(30_000);
    expect(backoffDelayMs(50, opts)).toBe(30_000);
  });

  it('treats a negative attempt as the first', () => {
    expect(backoffDelayMs(-3, opts)).toBe(1000);
  });
});
