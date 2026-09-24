import type { EntryType, Questions } from '@typesafe-ai/sdk';
import type { EntitySummary, Snapshot } from '../perception/types.js';
import { isProtectedPlayer } from '../reflex/protect.js';
import type { SwarmContext } from '../swarm/member.js';
import { NEUTRAL_MOBS, armorPoints } from '../reflex/danger.js';
import type { JevAnswer } from './jev.js';

/** Bump whenever a question or its wording changes: every logged decision records it. */
export const QUESTION_SET_VERSION = 'v2';

/** At most this many threats are described to Jev, nearest first. */
export const MAX_THREATS_IN_STATE = 6;

export const TACTICS = ['engage', 'retreat', 'ignore'] as const;
export type JevTactic = (typeof TACTICS)[number];

export const NO_TARGET = 'none';
const targetLabel = (id: number) => `t${id}`;

/** At most this many other players are described to Jev, and asked about. */
export const MAX_PLAYERS_IN_STATE = 3;

/** What the strategic layer needs to know about players. */
export interface PlayerRules {
  pvp: boolean;
  protectedPlayers?: string[];
}

const playerLabel = (id: number) => `p${id}`;

/** The hostiles worth describing to Jev, nearest first: mobs, and players who have attacked the bot. */
export function relevantThreats(snapshot: Snapshot, radiusBlocks: number, rules?: PlayerRules) {
  return snapshot.entities
    .filter((e) => {
      if (e.dist > radiusBlocks) return false;
      if (e.category === 'hostile') return true;
      return (
        e.category === 'player' &&
        !!rules?.pvp &&
        !!e.provoked &&
        !isProtectedPlayer(e.kind, rules.protectedPlayers)
      );
    })
    .slice(0, MAX_THREATS_IN_STATE);
}

/**
 * Other players in view whose intentions are unknown: not protected, not already known to be
 * hostile. Jev is asked whether each is about to attack.
 */
export function playersToJudge(
  snapshot: Snapshot,
  radiusBlocks: number,
  rules?: PlayerRules,
): EntitySummary[] {
  if (!rules?.pvp) return [];
  return snapshot.entities
    .filter(
      (e) =>
        e.category === 'player' &&
        !e.provoked &&
        e.dist <= radiusBlocks &&
        !isProtectedPlayer(e.kind, rules.protectedPlayers),
    )
    .slice(0, MAX_PLAYERS_IN_STATE);
}

/** The bot's situation as plain named fields, the way Jev wants state. */
export function buildState(
  snapshot: Snapshot,
  radiusBlocks: number,
  rules?: PlayerRules,
  squad?: SwarmContext | null,
): EntryType {
  const { self } = snapshot;
  return {
    ...(squad ? { squad } : {}),
    self: {
      hp: self.hp,
      max_hp: 20,
      food: self.food,
      weapon: self.heldItem ?? 'bare hands',
      armor_points: armorPoints(self.armor),
      in_water: self.inWater,
    },
    players: playersToJudge(snapshot, radiusBlocks, rules).map((e) => ({
      id: playerLabel(e.id),
      name: e.kind,
      distance_blocks: e.dist,
      direction: e.bearing,
      approaching: e.approaching,
      holding: e.held,
    })),
    threats: relevantThreats(snapshot, radiusBlocks, rules).map((e) => ({
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
export function buildQuestions(
  snapshot: Snapshot,
  radiusBlocks: number,
  rules?: PlayerRules,
  squad?: SwarmContext | null,
): Questions {
  const threats = relevantThreats(snapshot, radiusBlocks, rules);
  const targets: Record<string, string> = {
    [NO_TARGET]: 'No threat is worth attacking right now.',
  };
  for (const e of threats) {
    targets[targetLabel(e.id)] = `${e.kind}, ${e.dist} blocks ${e.bearing}`;
  }
  const hostility: Questions = {};
  for (const p of playersToJudge(snapshot, radiusBlocks, rules)) {
    hostility[`hostile_${playerLabel(p.id)}`] = {
      type: 'noul',
      instructions:
        `Is the player ${playerLabel(p.id)} listed in \`players\` about to attack the fighter (\`self\`)? ` +
        'A player who is just passing by, or holding a tool rather than a weapon, is not.',
    };
  }
  return {
    ...hostility,
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
        'Prefer the one that is most dangerous or closest.' +
        (squad
          ? ' The fighter is part of a squad (`squad`): prefer a threat that no ally already attacks (`squad.claims`), and follow `squad.focus` if it is set.'
          : ''),
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

/** Jev's estimate, per nearby player, of the probability that they are about to attack. */
export interface PlayerJudgment {
  id: number;
  hostile: number;
}

export interface Judgment {
  tactic: { label: JevTactic; confidence: number };
  /** Entity id Jev picked, or null for "none". */
  target: { id: number | null; confidence: number };
  threatLevel: { score: number; confidence: number };
  /** Probability of an ambush, 0 to 1. */
  ambush: number;
  /** Players Jev was asked about. */
  players: PlayerJudgment[];
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
    players: parsePlayerAnswers(answers),
  };
}

function parsePlayerAnswers(answers: Record<string, JevAnswer>): PlayerJudgment[] {
  const out: PlayerJudgment[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    const match = /^hostile_p(\d+)$/.exec(key);
    if (!match || answer.type !== 'noul' || !Number.isFinite(answer.noul)) continue;
    out.push({ id: Number(match[1]), hostile: answer.noul });
  }
  return out;
}
