export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
}

/** Exponential backoff: baseMs, 2×baseMs, 4×baseMs … capped at maxMs. `attempt` starts at 0. */
export function backoffDelayMs(attempt: number, { baseMs, maxMs }: BackoffOptions): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
}
