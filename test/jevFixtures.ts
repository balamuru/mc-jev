import { vi } from 'vitest';
import type { JevAnswer, JevClient, JevRequest, JevResponse } from '../src/strategic/jev.js';
import type { JevTactic, Judgment } from '../src/strategic/questions.js';

export interface AnswerSpec {
  tactic?: JevTactic;
  tacticConfidence?: number;
  /** Target label such as `t5`, or `none`. */
  target?: string;
  targetConfidence?: number;
  threatLevel?: number;
  threatConfidence?: number;
  ambush?: number;
  /** Probability that each player (by entity id) is about to attack. */
  players?: Record<number, number>;
}

/** Jev answers in the shape the SDK returns them. */
export function answers(spec: AnswerSpec = {}): Record<string, JevAnswer> {
  return {
    tactic: {
      type: 'choice',
      choice: spec.tactic ?? 'engage',
      confidence: spec.tacticConfidence ?? 0.9,
      probabilities: {},
    } as unknown as JevAnswer,
    target: {
      type: 'choice',
      choice: spec.target ?? 'none',
      confidence: spec.targetConfidence ?? 0.9,
      probabilities: {},
    } as unknown as JevAnswer,
    threat_level: {
      type: 'score',
      score: spec.threatLevel ?? 1,
      confidence: spec.threatConfidence ?? 0.9,
      legend: {},
      probabilities: {},
    } as unknown as JevAnswer,
    ambush: { type: 'noul', noul: spec.ambush ?? 0.1 },
    ...Object.fromEntries(
      Object.entries(spec.players ?? {}).map(([id, p]) => [
        `hostile_p${id}`,
        { type: 'noul', noul: p } as JevAnswer,
      ]),
    ),
  };
}

/** A parsed judgment, for policy tests. */
export function judgment(
  spec: {
    tactic?: JevTactic;
    tacticConfidence?: number;
    targetId?: number | null;
    targetConfidence?: number;
    threatLevel?: number;
    threatConfidence?: number;
    ambush?: number;
    players?: Array<{ id: number; hostile: number }>;
  } = {},
): Judgment {
  return {
    tactic: { label: spec.tactic ?? 'engage', confidence: spec.tacticConfidence ?? 0.9 },
    target: { id: spec.targetId ?? null, confidence: spec.targetConfidence ?? 0.9 },
    threatLevel: { score: spec.threatLevel ?? 1, confidence: spec.threatConfidence ?? 0.9 },
    ambush: spec.ambush ?? 0.1,
    players: spec.players ?? [],
  };
}

/** A Jev client that answers immediately with whatever `reply` returns, and records requests. */
export function scriptedClient(reply: () => Record<string, JevAnswer> | Error) {
  const requests: JevRequest[] = [];
  const client: JevClient = {
    ask: vi.fn(async (request): Promise<JevResponse> => {
      requests.push(request);
      const r = reply();
      if (r instanceof Error) throw r;
      return {
        model: 'jev-1.13.0',
        answers: r,
        usage: { inputTokens: 900, outputTokens: 0, costUsd: 0.0000378 },
      };
    }),
  };
  return { client, requests };
}
