/**
 * What a bot is currently trying to do. Set by the rules (this phase) or by Jev (Phase 3);
 * the reflex layer turns it into movement and attacks.
 */
export type Tactic = 'idle' | 'engage' | 'retreat';

export interface Intent {
  tactic: Tactic;
  /** Entity id to fight or flee from. Present for `engage` and `retreat`. */
  targetId?: number;
  /** Short explanation, used in logs. */
  reason: string;
}

export const IDLE: Intent = { tactic: 'idle', reason: 'no threats' };

/** True when applying `b` would change what the bot does compared to `a`. */
export function intentChanged(a: Intent, b: Intent): boolean {
  return a.tactic !== b.tactic || a.targetId !== b.targetId;
}
