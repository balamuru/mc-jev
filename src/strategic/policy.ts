import type { Intent } from '../intent.js';
import { IDLE } from '../intent.js';
import type { Snapshot } from '../perception/types.js';
import { isProtectedPlayer } from '../reflex/protect.js';
import { threatsIn, type RuleSettings } from '../reflex/rules.js';
import type { Judgment } from './questions.js';

export interface Thresholds {
  /** Confidence at or above which Jev's answer is acted on directly. */
  act: number;
  /** Confidence at or above which Jev may add caution (never remove it). */
  cautious: number;
}

/** A threat level at or above this (out of 3) counts as a vote to retreat. */
export const RETREAT_THREAT_LEVEL = 2.5;
/** An ambush probability at or above this, with several threats, counts as a vote to retreat. */
export const RETREAT_AMBUSH = 0.85;
/** Jev may tell the bot to ignore only threats farther away than this. */
export const IGNORE_MIN_DISTANCE_BLOCKS = 8;

export type DecisionSource = 'jev' | 'rules';

export interface Decision {
  intent: Intent;
  source: DecisionSource;
  /** Why this source won, for the decision log. */
  why: string;
}

/**
 * Combine Jev's judgment with the rules' intent, gated by confidence. The rules are the safety net:
 *
 * - Jev can always make the bot more careful (retreat votes need only `cautious` confidence).
 * - Jev can make the bot less careful (overrule a retreat, or ignore a threat) only with `act`
 *   confidence, never when HP is at or below the retreat floor, and never for a threat within
 *   ignore distance.
 * - Otherwise Jev only chooses which threat to attack; everything else follows the rules.
 */
export function decideWithJev(
  judgment: Judgment,
  rulesIntent: Intent,
  snapshot: Snapshot,
  rules: RuleSettings,
  thresholds: Thresholds,
): Decision {
  const fromRules = (why: string): Decision => ({ intent: rulesIntent, source: 'rules', why });
  const threats = threatsIn(snapshot, rules);
  const nearest = threats[0];
  if (!nearest) return fromRules('no threats to decide about');

  const hp = snapshot.self.hp;
  const { tactic, threatLevel, ambush } = judgment;

  // Safety floor: at critical HP the rules' retreat stands, whatever Jev says.
  if (rulesIntent.tactic === 'retreat' && hp <= rules.retreatHp) {
    return fromRules('rules retreat at critical HP');
  }

  // With retreating switched off, Jev can still pick targets and ignore far threats, but it cannot
  // send the bot running: the benchmark shows that does more harm than good.
  const votesRetreat =
    rules.retreat &&
    ((tactic.label === 'retreat' && tactic.confidence >= thresholds.cautious) ||
      (threatLevel.score >= RETREAT_THREAT_LEVEL && threatLevel.confidence >= thresholds.act) ||
      (ambush >= RETREAT_AMBUSH && threats.length >= 2));
  if (votesRetreat) {
    if (rulesIntent.tactic === 'retreat' && rulesIntent.targetId !== undefined) {
      return { intent: rulesIntent, source: 'jev', why: 'jev agrees with the rules to retreat' };
    }
    return {
      intent: {
        tactic: 'retreat',
        targetId: nearest.id,
        reason: `jev: retreat (${describe(judgment)})`,
      },
      source: 'jev',
      why: 'jev voted to retreat',
    };
  }

  if (rulesIntent.tactic === 'retreat') {
    // The rules want out. Jev may overrule them only when it is sure the fight is fine.
    if (tactic.label === 'engage' && tactic.confidence >= thresholds.act) {
      return engage(judgment, snapshot, rules, thresholds, 'jev overruled a rules retreat');
    }
    return fromRules('rules retreat stands');
  }

  if (tactic.label === 'engage' && tactic.confidence >= thresholds.cautious) {
    return engage(judgment, snapshot, rules, thresholds, 'jev chose to engage');
  }

  if (
    tactic.label === 'ignore' &&
    tactic.confidence >= thresholds.act &&
    nearest.dist > IGNORE_MIN_DISTANCE_BLOCKS &&
    !nearest.approaching
  ) {
    return {
      intent: { ...IDLE, reason: `jev: ignore ${nearest.kind} (${describe(judgment)})` },
      source: 'jev',
      why: 'jev said to ignore distant threats',
    };
  }

  return fromRules('jev not confident enough to change the rules');
}

function engage(
  judgment: Judgment,
  snapshot: Snapshot,
  rules: RuleSettings,
  thresholds: Thresholds,
  why: string,
): Decision {
  const threats = threatsIn(snapshot, rules);
  // Use Jev's pick of target only when it is confident and still a valid threat.
  const chosen =
    judgment.target.id !== null && judgment.target.confidence >= thresholds.cautious
      ? threats.find((e) => e.id === judgment.target.id)
      : undefined;
  const target = chosen ?? threats[0]!;
  return {
    intent: {
      tactic: 'engage',
      targetId: target.id,
      reason: `jev: fight ${target.kind} (${describe(judgment)})`,
    },
    source: 'jev',
    why,
  };
}

function describe(j: Judgment): string {
  return `${j.tactic.label} ${(j.tactic.confidence * 100).toFixed(0)}%, threat ${j.threatLevel.score.toFixed(1)}/3`;
}

/** Jev must be at least this sure a player is about to attack before the bot treats them as hostile. */
export const HOSTILE_PLAYER_CONFIDENCE = 0.85;
/** ...and the player must be within this many blocks. */
export const HOSTILE_PLAYER_MAX_DISTANCE = 8;

/**
 * Which players Jev's judgment says to treat as hostile. This is the riskiest thing Jev can do
 * (a wrong answer makes the bot attack a bystander), so it is strict: Jev must be very sure, the
 * player must be armed and close, and protected players are never included.
 */
export function judgeHostilePlayers(
  judgment: Judgment,
  snapshot: Snapshot,
  rules: Pick<RuleSettings, 'pvp' | 'protectedPlayers'>,
): string[] {
  if (!rules.pvp) return [];
  const names: string[] = [];
  for (const { id, hostile } of judgment.players) {
    if (hostile < HOSTILE_PLAYER_CONFIDENCE) continue;
    const player = snapshot.entities.find((e) => e.id === id && e.category === 'player');
    if (!player || !player.held || player.dist > HOSTILE_PLAYER_MAX_DISTANCE) continue;
    if (isProtectedPlayer(player.kind, rules.protectedPlayers)) continue;
    names.push(player.kind);
  }
  return names;
}
