import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  RateLimitError,
  TypeSafeClient,
  UnprocessableEntityError,
  type ChoiceResponse,
  type EntryType,
  type Fetch,
  type NoulResponse,
  type Questions,
  type ScoreResponse,
} from '@typesafe-ai/sdk';

/** Jev input pricing: $0.042 per million input tokens, output is free. */
export const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;

export type JevErrorKind =
  'timeout' | 'aborted' | 'auth' | 'payment' | 'rate-limited' | 'server' | 'network' | 'invalid';

/** A failed Jev call, reduced to what the rest of the program needs to react to. */
export class JevError extends Error {
  constructor(
    readonly kind: JevErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'JevError';
  }
}

export type JevAnswer = ChoiceResponse | ScoreResponse | NoulResponse;

export interface JevRequest {
  model: string;
  state: EntryType;
  questions: Questions;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface JevCallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxRetries: number;
}

/** What the gateway needs from a Jev backend. Implemented over the SDK here, and by fakes in tests. */
export interface JevClient {
  ask(request: JevRequest, options: JevCallOptions): Promise<JevResponse>;
}

export interface JevApiSettings {
  apiKey: string;
  /** Set to https://openrouter.ai/api to go through OpenRouter. */
  baseURL?: string;
  /** Replaceable HTTP transport, for tests. */
  fetch?: Fetch;
}

/** Turn whatever the SDK threw into a `JevError`. Exported for tests. */
export function toJevError(err: unknown): JevError {
  if (err instanceof JevError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof APIUserAbortError) return new JevError('aborted', message);
  if (err instanceof APITimeoutError) return new JevError('timeout', message);
  if (err instanceof AuthenticationError) return new JevError('auth', message, 401);
  if (err instanceof RateLimitError) return new JevError('rate-limited', message, 429);
  if (err instanceof BadRequestError || err instanceof UnprocessableEntityError) {
    return new JevError('invalid', message, err.status);
  }
  if (err instanceof APIConnectionError) return new JevError('network', message);
  if (err instanceof APIError) {
    const status = err.status;
    if (status === 402) return new JevError('payment', message, status);
    if (status === 401 || status === 403) return new JevError('auth', message, status);
    if (status === 429 || status === 529) return new JevError('rate-limited', message, status);
    if (typeof status === 'number' && status >= 500) return new JevError('server', message, status);
    return new JevError('invalid', message, status);
  }
  return new JevError('network', message);
}

/** Cost of a call: the provider's own figure when it reports one (OpenRouter does), else from tokens. */
export function costOf(usage: { input_tokens: number; cost?: unknown }): number {
  return typeof usage.cost === 'number' && usage.cost >= 0
    ? usage.cost
    : usage.input_tokens * INPUT_USD_PER_TOKEN;
}

/** A real client over TypeSafe's official SDK. The API key never leaves this object. */
export function createJevClient(settings: JevApiSettings): JevClient {
  const client = new TypeSafeClient({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    fetch: settings.fetch,
    logLevel: 'off',
  });
  return {
    async ask(request, options) {
      try {
        const result = await client.systemOne(
          { model: request.model, state: request.state, questions: request.questions },
          {
            signal: options.signal,
            timeout: options.timeoutMs,
            retry: { maxRetries: options.maxRetries },
          },
        );
        const usage = result.usage as {
          input_tokens: number;
          output_tokens: number;
          cost?: unknown;
        };
        return {
          model: result.model,
          answers: result.answers as unknown as Record<string, JevAnswer>,
          usage: {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            costUsd: costOf(usage),
          },
        };
      } catch (err) {
        throw toJevError(err);
      }
    },
  };
}
