import { IDLE, type Intent } from '../intent.js';
import type { EntitySummary, Snapshot } from '../perception/types.js';

export interface RuleSettings {
  retreatHp: number;
  resumeHp: number;
  engageRadiusBlocks: number;
}

/** A different hostile must be at least this much closer before the bot drops its current target. */
export const TARGET_SWITCH_MARGIN_BLOCKS = 3;

/**
 * Deterministic combat policy, and the fallback whenever Jev is unavailable or unsure.
 *
 * - No visible hostile in range: idle.
 * - HP at or below `retreatHp`: retreat, and keep retreating until HP is back to `resumeHp`
 *   (hysteresis, so the bot does not flap between fighting and fleeing at the threshold).
 * - Otherwise engage the nearest hostile, staying on the current target unless another is
 *   clearly closer.
 */
export function decideByRules(
  snapshot: Snapshot,
  rules: RuleSettings,
  previous: Intent = IDLE,
): Intent {
  const threats = snapshot.entities.filter(
    (e) => e.category === 'hostile' && e.visible && e.dist <= rules.engageRadiusBlocks,
  );
  const nearest = threats[0]; // snapshot entities are sorted nearest first
  if (!nearest) return IDLE;

  const hp = snapshot.self.hp;
  const wasRetreating = previous.tactic === 'retreat';
  if (hp <= rules.retreatHp || (wasRetreating && hp < rules.resumeHp)) {
    return {
      tactic: 'retreat',
      targetId: nearest.id,
      reason: `hp ${hp} is low, fleeing ${nearest.kind}`,
    };
  }

  const current =
    previous.tactic === 'engage' ? threats.find((e) => e.id === previous.targetId) : undefined;
  const target: EntitySummary =
    current && current.dist - nearest.dist < TARGET_SWITCH_MARGIN_BLOCKS ? current : nearest;
  return { tactic: 'engage', targetId: target.id, reason: `fighting ${target.kind}` };
}
