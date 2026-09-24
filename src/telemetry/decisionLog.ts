import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type DecisionOutcome =
  /** Jev's judgment changed what the bot does. */
  | 'applied'
  /** Jev answered, but the rules stayed in charge. */
  | 'rules'
  /** The answer arrived after the situation had changed, so it was thrown away. */
  | 'stale'
  /** The answer did not have the expected shape. */
  | 'invalid'
  /** No answer: rate limit, budget, timeout, error. The rules decided. */
  | 'error';

export interface DecisionEntry {
  /** ISO timestamp. */
  time: string;
  agent: string;
  /** What triggered the call: `interval` or `event:hurt`. */
  trigger: string;
  questionSet: string;
  model?: string;
  outcome: DecisionOutcome;
  /** Why this outcome, in a few words. */
  why: string;
  /** A short text summary of what the bot saw. */
  situation: string;
  answers?: {
    tactic: { choice: string; confidence: number };
    target: { id: number | null; confidence: number };
    threatLevel: { score: number; confidence: number };
    ambush: number;
  };
  /** Players Jev judged to be about to attack, and who were therefore marked hostile. */
  hostilePlayers?: string[];
  /** What the rules alone would have done in this situation. */
  rulesIntent?: { tactic: string; targetId?: number };
  /** The intent that resulted, if any. */
  intent?: { tactic: string; targetId?: number; reason: string };
  latencyMs?: number;
  costUsd?: number;
  inputTokens?: number;
  /** For `error` outcomes: the reason, e.g. `timeout` or `budget`. */
  error?: string;
}

export interface DecisionSink {
  write(entry: DecisionEntry): void;
}

/** Appends one JSON object per line to `<dir>/decisions-YYYY-MM-DD.jsonl`. Never throws. */
export class JsonlDecisionLog implements DecisionSink {
  private ready = false;

  constructor(
    private readonly dir: string,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  write(entry: DecisionEntry): void {
    try {
      if (!this.ready) {
        mkdirSync(this.dir, { recursive: true });
        this.ready = true;
      }
      const file = join(this.dir, `decisions-${entry.time.slice(0, 10)}.jsonl`);
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.onError(`could not write decision log: ${err instanceof Error ? err.message : err}`);
    }
  }
}
