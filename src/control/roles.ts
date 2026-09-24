import type { Intent } from '../intent.js';
import { distance } from '../perception/geometry.js';
import type { EntitySummary, Snapshot, Vec3Like } from '../perception/types.js';
import { canShoot } from '../reflex/bow.js';
import { TARGET_SWITCH_MARGIN_BLOCKS } from '../reflex/rules.js';

export const ROLES = ['fighter', 'tank', 'support', 'scout', 'ranged'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string | null | undefined): value is Role {
  return (ROLES as readonly string[]).includes(value ?? '');
}

/** Mobs that attack from a distance. A ranged bot duels them rather than backing away. */
export const RANGED_ATTACKERS = new Set([
  'skeleton',
  'stray',
  'bogged',
  'witch',
  'pillager',
  'blaze',
  'breeze',
]);
/** What a ranged bot shoots first: mobs that hurt from afar, and creepers, which must never get close. */
export const RANGED_PRIORITY = new Set([...RANGED_ATTACKERS, 'creeper']);
/** A ranged bot backs away from any other threat that comes this close... */
export const RANGED_BACK_OFF_BLOCKS = 8;
/** ...and keeps backing away until the threat is this far. */
export const RANGED_RESUME_BLOCKS = 12;
/** An ally at or below this HP is hurt enough for a tank to cover them. */
export const TANK_COVER_HP = 14;
/** A support bot answers calls for help at this many HP more than the squad's `helpHp`. */
export const SUPPORT_EXTRA_HELP_HP = 4;
/** A support bot heading to an ally stops once this close; from there it fights. */
export const SUPPORT_REACHED_BLOCKS = 6;
/** A support bot on its way to an ally still fights a threat this close to itself. */
export const SUPPORT_SELF_DEFENSE_BLOCKS = 3;
/** Scouts wander this many times farther than other hunters. */
export const SCOUT_WANDER_FACTOR = 2;

export interface AllyView {
  agent: string;
  position: Vec3Like;
  hp: number;
}

export interface RoleInput {
  role: Role;
  snapshot: Snapshot;
  /** Threats as the rules see them, nearest first. */
  threats: EntitySummary[];
  /** The intent before the role is applied. */
  intent: Intent;
  /** The intent of the previous step, for hysteresis. */
  previous: Intent;
  /** The other bots in the squad. */
  allies: AllyView[];
  /** The nearest ally in trouble by the support threshold, for the `support` role. */
  help: AllyView | null;
}

/**
 * Adjust a combat intent for the bot's squad role; any other intent is returned unchanged. `fighter` and `scout` fight like everyone else, and a `ranged` bot without a bow and
 * arrows fights as a `fighter`.
 */
export function applyRole(input: RoleInput): Intent {
  switch (input.role) {
    case 'tank':
      return tankIntent(input);
    case 'support':
      return supportIntent(input);
    case 'ranged':
      return rangedIntent(input);
    default:
      return input.intent;
  }
}

/** A tank takes on the threat closest to the most hurt ally, rather than the one closest to itself. */
function tankIntent({ intent, threats, allies, previous }: RoleInput): Intent {
  if (intent.tactic !== 'engage' || !threats.length) return intent;
  const hurt = allies.filter((a) => a.hp <= TANK_COVER_HP).sort((a, b) => a.hp - b.hp)[0];
  if (!hurt) return intent;
  const near = (e: EntitySummary) => distance(e.position, hurt.position);
  const best = [...threats].sort((a, b) => near(a) - near(b))[0]!;
  // Stay on the current target unless another is clearly closer to the ally, so the tank does not flap.
  const current =
    previous.tactic === 'engage' ? threats.find((e) => e.id === previous.targetId) : undefined;
  const target =
    current && near(current) - near(best) < TARGET_SWITCH_MARGIN_BLOCKS ? current : best;
  return {
    tactic: 'engage',
    targetId: target.id,
    reason: `covering ${hurt.agent} from ${target.kind}`,
  };
}

/** A support bot goes to an ally in trouble before it takes on a fresh target of its own. */
function supportIntent({ intent, previous, help, snapshot, threats }: RoleInput): Intent {
  if (!help || intent.tactic !== 'engage') return intent;
  if (distance(snapshot.self.position, help.position) <= SUPPORT_REACHED_BLOCKS) return intent;
  const target = threats.find((e) => e.id === intent.targetId);
  if (target && target.dist <= SUPPORT_SELF_DEFENSE_BLOCKS) return intent; // fight what is on it
  if (previous.tactic === 'engage' && previous.targetId === intent.targetId) return intent;
  return { tactic: 'goto', position: help.position, reason: `supporting ${help.agent}` };
}

/**
 * A ranged bot keeps its distance and shoots: it backs away from melee threats and creepers that
 * come close, and shoots archers and creepers first. When backing away fails (the reflex loop's
 * retreat check), the loop turns it round to fight, so melee is the fallback when cornered.
 */
function rangedIntent({ intent, previous, threats, snapshot }: RoleInput): Intent {
  if (intent.tactic !== 'engage' || !canShoot(snapshot.inventory)) return intent;
  const limit = previous.tactic === 'retreat' ? RANGED_RESUME_BLOCKS : RANGED_BACK_OFF_BLOCKS;
  const close = threats.find((e) => !RANGED_ATTACKERS.has(e.kind) && e.dist < limit);
  if (close) {
    return {
      tactic: 'retreat',
      targetId: close.id,
      reason: `keeping my distance from ${close.kind}`,
    };
  }
  const current = threats.find((e) => e.id === intent.targetId);
  if (current && RANGED_PRIORITY.has(current.kind)) return intent;
  const priority = threats.find((e) => RANGED_PRIORITY.has(e.kind)); // nearest first
  if (!priority) return intent;
  return { tactic: 'engage', targetId: priority.id, reason: `shooting ${priority.kind} first` };
}
