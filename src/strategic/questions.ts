import type { EntryType, Questions } from '@typesafe-ai/sdk';
import type { Snapshot } from '../perception/types.js';
import { NEUTRAL_MOBS, armorPoints } from '../reflex/danger.js';
import type { JevAnswer } from './jev.js';

/** Bump whenever a question or its wording changes: every logged decision records it. */
export const QUESTION_SET_VERSION = 'v1';

/** At most this many threats are described to Jev, nearest first. */
export const MAX_THREATS_IN_STATE = 6;

export const TACTICS = ['engage', 'retreat', 'ignore'] as const;
export type JevTactic = (typeof TACTICS)[number];

export const NO_TARGET = 'none';
const targetLabel = (id: number) => `t${id}`;

/** The hostiles worth describing to Jev, nearest first. */
export function relevantThreats(snapshot: Snapshot, radiusBlocks: number) {
  return snapshot.entities
    .filter((e) => e.category === 'hostile' && e.dist <= radiusBlocks)
    .slice(0, MAX_THREATS_IN_STATE);
}

/** The bot's situation as plain named fields, the way Jev wants state. */
export function buildState(snapshot: Snapshot, radiusBlocks: number): EntryType {
  const { self } = snapshot;
  return {
    self: {
      hp: self.hp,
      max_hp: 20,
      food: self.food,
      weapon: self.heldItem ?? 'bare hands',
      armor_points: armorPoints(self.armor),
      in_water: self.inWater,
    },
    threats: relevantThreats(snapshot, radiusBlocks).map((e) => ({
      id: targetLabel(e.id),
      kind: e.kind,
      distance_blocks: e.dist,
      direction: e.bearing,
      approaching: e.approaching,
      holding: e.held,
      visible: e.visible,
      // Neutral mobs leave the bot alone unless attacked.
      neutral_until_attacked: NEUTRAL_MOBS.has(e.kind),
    })),
  };
}

/** The four questions asked together in one request (they are answered in parallel). */
export function buildQuestions(snapshot: Snapshot, radiusBlocks: number): Questions {
  const threats = relevantThreats(snapshot, radiusBlocks);
  const targets: Record<string, string> = {
    [NO_TARGET]: 'No threat is worth attacking right now.',
  };
  for (const e of threats) {
    targets[targetLabel(e.id)] = `${e.kind}, ${e.dist} blocks ${e.bearing}`;
  }
  return {
    tactic: {
      type: 'choice',
      instructions:
        'A Minecraft fighter (`self`) faces the hostile mobs in `threats`. ' +
        'What should it do right now?',
      criteria: {
        engage: 'Fight: attack a nearby threat. The fighter is likely to win.',
        retreat: 'Run away. Fighting would likely cost the fighter its life or too much health.',
        ignore: 'Do nothing: the threats are far away, harmless, or not worth a fight.',
      },
    },
    target: {
      type: 'choice',
      instructions:
        'If the fighter attacks, which one of the `threats` should it attack first? ' +
        'Prefer the one that is most dangerous or closest.',
      criteria: targets,
    },
    threat_level: {
      type: 'score',
      instructions: 'How dangerous is this situation for the fighter (`self`) given the `threats`?',
      criteria: [
        'No real danger.',
        'Minor danger: easily handled with little damage.',
        'Serious danger: could cause heavy damage.',
        'Deadly: the fighter is likely to die if it fights.',
      ],
    },
    ambush: {
      type: 'noul',
      instructions:
        'Is the fighter (`self`) being surrounded or attacked from several sides at once by the `threats`?',
    },
  };
}

export interface Judgment {
  tactic: { label: JevTactic; confidence: number };
  /** Entity id Jev picked, or null for "none". */
  target: { id: number | null; confidence: number };
  threatLevel: { score: number; confidence: number };
  /** Probability of an ambush, 0 to 1. */
  ambush: number;
}

/** Read and check Jev's answers. Returns null if anything is missing or not what was asked. */
export function parseJudgment(answers: Record<string, JevAnswer>): Judgment | null {
  const tactic = answers.tactic;
  const target = answers.target;
  const level = answers.threat_level;
  const ambush = answers.ambush;
  if (tactic?.type !== 'choice' || !(TACTICS as readonly string[]).includes(tactic.choice)) {
    return null;
  }
  if (target?.type !== 'choice' || level?.type !== 'score' || ambush?.type !== 'noul') return null;

  let targetId: number | null = null;
  if (target.choice !== NO_TARGET) {
    const match = /^t(\d+)$/.exec(target.choice);
    if (!match) return null;
    targetId = Number(match[1]);
  }
  const ok = (n: number) => Number.isFinite(n);
  if (
    ![tactic.confidence, target.confidence, level.score, level.confidence, ambush.noul].every(ok)
  ) {
    return null;
  }
  return {
    tactic: { label: tactic.choice as JevTactic, confidence: tactic.confidence },
    target: { id: targetId, confidence: target.confidence },
    threatLevel: { score: level.score, confidence: level.confidence },
    ambush: ambush.noul,
  };
}
