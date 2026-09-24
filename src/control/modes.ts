import { IDLE, type Intent } from '../intent.js';
import type { Snapshot, Vec3Like } from '../perception/types.js';
import { distance } from '../perception/geometry.js';
import { decideByRules, type RuleSettings } from '../reflex/rules.js';
import { HELP_TEXT, type Command } from './commands.js';

export type ModeName = 'guard' | 'hunt' | 'idle' | 'follow';

/** The modes a bot can start in. `follow` needs an owner to follow, so it is command-only. */
export type DefaultMode = 'guard' | 'hunt' | 'idle';

export interface Mode {
  name: ModeName;
  /** For `guard here`: the post to hold. */
  anchor?: Vec3Like;
}

/** A guard walks back to its post when idle and farther than this from it. */
export const GUARD_RETURN_BLOCKS = 2.5;
/** A guard stops chasing and returns once it is this far from its post. */
export const GUARD_LEASH_BLOCKS = 14;
/** A hunter with nothing in sight walks to a random spot this far away. */
export const WANDER_BLOCKS = 15;
/** ...and picks a new spot after this long, or on arrival. */
export const WANDER_RETHINK_MS = 10_000;
const ARRIVED_BLOCKS = 3;

export interface ModeOptions {
  /** The owner's Minecraft name, used to find them in the world. */
  ownerName?: string;
  defaultMode: DefaultMode;
  rules: RuleSettings;
  /** Hunters engage anything within this many blocks, rather than the usual engage radius. */
  huntRadiusBlocks: number;
  rng?: () => number;
  now?: () => number;
}

/**
 * The bot's high-level orders. Autonomous by default (it fights what comes near), and the owner's
 * chat commands switch it between following, guarding a post, hunting, and standing down. It picks
 * the intent for each reflex step; combat still follows the rules in every mode except `idle`.
 */
export class ModeController {
  private _mode: Mode;
  private wander: { target: Vec3Like; chosenAt: number } | null = null;
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: ModeOptions) {
    this._mode = { name: opts.defaultMode };
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  get mode(): Mode {
    return this._mode;
  }

  /** True while standing down: the bot should not act at all, and Jev should not be asked. */
  get standingDown(): boolean {
    return this._mode.name === 'idle';
  }

  /** Apply an owner's command and return what the bot says back. */
  apply(command: Command, position: Vec3Like, snapshot: Snapshot | null): string {
    this.wander = null;
    switch (command.name) {
      case 'follow':
        this._mode = { name: 'follow' };
        return 'following you';
      case 'guard':
        this._mode = {
          name: 'guard',
          anchor: { x: position.x, y: position.y, z: position.z },
        };
        return `guarding this spot (${fmt(position)})`;
      case 'hunt':
        this._mode = { name: 'hunt' };
        return 'hunting hostile mobs';
      case 'stop':
        this._mode = { name: 'idle' };
        return 'standing down; say auto to resume';
      case 'auto':
        this._mode = { name: this.opts.defaultMode };
        return `back to autonomous (${this.opts.defaultMode})`;
      case 'help':
        return HELP_TEXT;
      case 'status':
        return this.status(snapshot);
    }
  }

  /** A one-line report for the `status` command. */
  status(snapshot: Snapshot | null): string {
    const m = this._mode;
    const where = m.anchor ? `guard@${fmt(m.anchor)}` : m.name;
    if (!snapshot) return `mode ${where}; not in the world`;
    const hostiles = snapshot.entities.filter((e) => e.category === 'hostile');
    const nearest = hostiles[0];
    return (
      `mode ${where}; hp ${snapshot.self.hp}/20, food ${snapshot.self.food}; ` +
      (nearest
        ? `${hostiles.length} hostile${hostiles.length > 1 ? 's' : ''} near, nearest ${nearest.kind} at ${nearest.dist}m`
        : 'no hostiles near')
    );
  }

  /** Pick the intent for the current mode. `previous` feeds the rules' hysteresis. */
  decide(snapshot: Snapshot, previous: Intent): Intent {
    const { rules } = this.opts;
    switch (this._mode.name) {
      case 'idle':
        return { ...IDLE, reason: 'standing down' };
      case 'follow':
        return this.decideFollow(snapshot, previous);
      case 'guard':
        return this.decideGuard(snapshot, previous);
      case 'hunt':
        return this.decideHunt(snapshot, previous);
      default:
        return decideByRules(snapshot, rules, previous);
    }
  }

  private decideFollow(snapshot: Snapshot, previous: Intent): Intent {
    const combat = decideByRules(snapshot, this.opts.rules, previous);
    if (combat.tactic !== 'idle') return combat;
    const owner = this.findOwner(snapshot);
    if (!owner) return { ...IDLE, reason: 'cannot see my owner' };
    return { tactic: 'follow', targetId: owner.id, reason: `following ${owner.kind}` };
  }

  private decideGuard(snapshot: Snapshot, previous: Intent): Intent {
    const combat = decideByRules(snapshot, this.opts.rules, previous);
    const anchor = this._mode.anchor;
    if (!anchor) return combat;

    const away = distance(snapshot.self.position, anchor);
    const leashed = away > GUARD_LEASH_BLOCKS;
    if (combat.tactic !== 'idle' && !leashed) return combat;
    if (away > GUARD_RETURN_BLOCKS) {
      return {
        tactic: 'goto',
        position: anchor,
        reason: leashed ? 'too far from my post, returning' : 'returning to my post',
      };
    }
    return { ...IDLE, reason: 'holding my post' };
  }

  private decideHunt(snapshot: Snapshot, previous: Intent): Intent {
    const rules = { ...this.opts.rules, engageRadiusBlocks: this.opts.huntRadiusBlocks };
    const combat = decideByRules(snapshot, rules, previous);
    if (combat.tactic !== 'idle') {
      this.wander = null;
      return combat;
    }
    return this.wanderIntent(snapshot);
  }

  /** Nothing to fight in sight: stroll to a random spot nearby to find something. */
  private wanderIntent(snapshot: Snapshot): Intent {
    const here = snapshot.self.position;
    const t = this.now();
    const w = this.wander;
    const stale =
      !w || t - w.chosenAt > WANDER_RETHINK_MS || distance(here, w.target) < ARRIVED_BLOCKS;
    if (stale) {
      const angle = this.rng() * 2 * Math.PI;
      this.wander = {
        target: {
          x: Math.round(here.x + Math.cos(angle) * WANDER_BLOCKS),
          y: Math.round(here.y),
          z: Math.round(here.z + Math.sin(angle) * WANDER_BLOCKS),
        },
        chosenAt: t,
      };
    }
    return { tactic: 'goto', position: this.wander!.target, reason: 'looking for hostiles' };
  }

  private findOwner(snapshot: Snapshot) {
    const name = this.opts.ownerName?.toLowerCase();
    if (!name) return undefined;
    // Prefer the direct lookup, which reaches beyond the perception radius.
    if (snapshot.owner) return snapshot.owner;
    return snapshot.entities.find((e) => e.category === 'player' && e.kind.toLowerCase() === name);
  }
}

const fmt = (p: Vec3Like) => `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`;
