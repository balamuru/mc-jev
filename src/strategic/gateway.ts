import {
  JevError,
  type JevClient,
  type JevErrorKind,
  type JevRequest,
  type JevResponse,
} from './jev.js';

export interface GatewayLimits {
  maxCallsPerMinute: number;
  /** Stop calling Jev for the rest of the day once this much has been spent. 0 disables Jev. */
  dailyBudgetUsd: number;
}

export type Rejection =
  'no-client' | 'disabled' | 'budget' | 'rate-limited' | 'cooldown' | 'superseded' | JevErrorKind;

export type GatewayOutcome =
  | { ok: true; response: JevResponse; latencyMs: number }
  | { ok: false; reason: Rejection; message?: string };

export interface GatewayStats {
  calls: number;
  failures: number;
  costUsd: number;
  inputTokens: number;
  spentTodayUsd: number;
  disabledReason: string | null;
}

export interface CallSettings {
  timeoutMs: number;
  maxRetries: number;
}

export interface GatewayOptions {
  client: JevClient | null;
  limits: GatewayLimits;
  now?: () => number;
  /** How long to back off after a 429/5xx or a network failure. */
  cooldownMs?: number;
}

const DAY_MS = 86_400_000;
const localDay = (t: number) => Math.floor((t - new Date(t).getTimezoneOffset() * 60_000) / DAY_MS);

/**
 * The one place every bot's Jev calls go through, so limits are global:
 * - a rate limit and a daily budget across all bots,
 * - one call in flight per bot (a newer call cancels the older one),
 * - a short pause after rate-limit or server errors, and a permanent stop after a bad key or no credit.
 * Every call returns an outcome; it never throws, so callers can always fall back to rules.
 */
export class JevGateway {
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly callTimes: number[] = [];
  private readonly inFlight = new Map<string, AbortController>();
  private cooldownUntil = 0;
  private day: number;
  private spentTodayUsd = 0;
  private disabledReason: string | null = null;
  private calls = 0;
  private failures = 0;
  private costUsd = 0;
  private inputTokens = 0;

  constructor(private readonly opts: GatewayOptions) {
    this.now = opts.now ?? Date.now;
    this.cooldownMs = opts.cooldownMs ?? 5000;
    this.day = localDay(this.now());
  }

  /** True when a call could be made right now. */
  get available(): boolean {
    return this.reject() === null;
  }

  stats(): GatewayStats {
    this.rollDay();
    return {
      calls: this.calls,
      failures: this.failures,
      costUsd: this.costUsd,
      inputTokens: this.inputTokens,
      spentTodayUsd: this.spentTodayUsd,
      disabledReason: this.disabledReason,
    };
  }

  async ask(agentId: string, request: JevRequest, call: CallSettings): Promise<GatewayOutcome> {
    const rejection = this.reject();
    if (rejection) return { ok: false, reason: rejection };

    // One call at a time per bot: a newer decision replaces the older one.
    this.inFlight.get(agentId)?.abort();
    const controller = new AbortController();
    this.inFlight.set(agentId, controller);

    const start = this.now();
    this.callTimes.push(start);
    this.calls++;
    try {
      const response = await this.opts.client!.ask(request, { ...call, signal: controller.signal });
      this.rollDay();
      this.spentTodayUsd += response.usage.costUsd;
      this.costUsd += response.usage.costUsd;
      this.inputTokens += response.usage.inputTokens;
      return { ok: true, response, latencyMs: this.now() - start };
    } catch (err) {
      const error = err instanceof JevError ? err : new JevError('network', String(err));
      if (controller.signal.aborted && error.kind === 'aborted') {
        return { ok: false, reason: 'superseded' }; // a newer call took over; not a failure
      }
      this.failures++;
      this.react(error);
      return { ok: false, reason: error.kind, message: error.message };
    } finally {
      if (this.inFlight.get(agentId) === controller) this.inFlight.delete(agentId);
    }
  }

  /** Cancel a bot's pending call, e.g. when it disconnects. */
  cancel(agentId: string): void {
    this.inFlight.get(agentId)?.abort();
    this.inFlight.delete(agentId);
  }

  private reject(): Rejection | null {
    if (!this.opts.client) return 'no-client';
    if (this.disabledReason) return 'disabled';
    this.rollDay();
    const { dailyBudgetUsd, maxCallsPerMinute } = this.opts.limits;
    if (dailyBudgetUsd <= 0) return 'disabled';
    if (this.spentTodayUsd >= dailyBudgetUsd) return 'budget';
    const t = this.now();
    if (t < this.cooldownUntil) return 'cooldown';
    while (this.callTimes.length && this.callTimes[0]! <= t - 60_000) this.callTimes.shift();
    if (this.callTimes.length >= maxCallsPerMinute) return 'rate-limited';
    return null;
  }

  private react(error: JevError): void {
    if (error.kind === 'auth') this.disabledReason = 'the API key was rejected';
    else if (error.kind === 'payment') this.disabledReason = 'the account is out of credit';
    else if (error.kind === 'rate-limited' || error.kind === 'server' || error.kind === 'network') {
      this.cooldownUntil = this.now() + this.cooldownMs;
    }
  }

  private rollDay(): void {
    const today = localDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.spentTodayUsd = 0;
    }
  }
}
