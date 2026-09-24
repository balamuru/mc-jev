import { IDLE, type Intent } from '../intent.js';
import type { EntitySummary, Snapshot } from '../perception/types.js';
import { NEUTRAL_MOBS, estimateFight, weaponFromInventory } from './danger.js';

export interface RuleSettings {
  retreat: boolean;
  retreatHp: number;
  resumeHp: number;
  engageRadiusBlocks: number;
  eatBelowFood: number;
  noEatRadiusBlocks: number;
  dangerMargin: number;
  retreatCheckMs: number;
  retreatMinGainBlocks: number;
  fightBackMs: number;
}

/** A different hostile must be at least this much closer before the bot drops its current target. */
export const TARGET_SWITCH_MARGIN_BLOCKS = 3;

/** At or below `retreatHp` the bot still fights if the expected damage is under this share of its HP. */
export const SAFE_FIGHT_FRACTION = 0.3;

/** While retreating, the fight must look this much safer than the entry margin before the bot returns. */
export const RESUME_MARGIN_FACTOR = 0.8;

/** Hostiles the bot should deal with: visible, in range, and not neutral until provoked. */
export function threatsIn(snapshot: Snapshot, engageRadiusBlocks: number): EntitySummary[] {
  return snapshot.entities.filter(
    (e) =>
      e.category === 'hostile' &&
      e.visible &&
      e.dist <= engageRadiusBlocks &&
      !NEUTRAL_MOBS.has(e.kind),
  );
}

/**
 * Deterministic combat policy, and the fallback whenever Jev is unavailable or unsure.
 *
 * - No visible, non-neutral hostile in range: idle.
 * - Retreating is only considered when `rules.retreat` is on (it is off by default: see the survival
 *   benchmark). Then retreat when the fight looks lost (expected damage at or above `dangerMargin` of current HP),
 *   or when HP is at or below `retreatHp` and the fight is not clearly safe. Once retreating, keep
 *   going until HP is back to `resumeHp` and the fight looks comfortably winnable (hysteresis, so
 *   the bot does not flap between fighting and fleeing at a threshold).
 * - Otherwise engage the nearest hostile, staying on the current target unless another is
 *   clearly closer.
 */
export function decideByRules(
  snapshot: Snapshot,
  rules: RuleSettings,
  previous: Intent = IDLE,
): Intent {
  const threats = threatsIn(snapshot, rules.engageRadiusBlocks);
  const nearest = threats[0]; // snapshot entities are sorted nearest first
  if (!nearest) return IDLE;

  const hp = snapshot.self.hp;
  const { expectedDamage } = estimateFight(threats, {
    armor: snapshot.self.armor,
    weapon: weaponFromInventory(snapshot.inventory, snapshot.self.heldItem),
  });
  const lost = expectedDamage >= hp * rules.dangerMargin;
  const lowHp = hp <= rules.retreatHp && expectedDamage >= hp * SAFE_FIGHT_FRACTION;
  const keepFleeing =
    previous.tactic === 'retreat' &&
    (hp < rules.resumeHp || expectedDamage >= hp * rules.dangerMargin * RESUME_MARGIN_FACTOR);

  if (rules.retreat && (lost || lowHp || keepFleeing)) {
    return {
      tactic: 'retreat',
      targetId: nearest.id,
      reason: `hp ${hp}, expected damage ${expectedDamage.toFixed(1)}: fleeing ${nearest.kind}`,
    };
  }

  const current =
    previous.tactic === 'engage' ? threats.find((e) => e.id === previous.targetId) : undefined;
  const target: EntitySummary =
    current && current.dist - nearest.dist < TARGET_SWITCH_MARGIN_BLOCKS ? current : nearest;
  return { tactic: 'engage', targetId: target.id, reason: `fighting ${target.kind}` };
}
