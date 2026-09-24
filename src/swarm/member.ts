import type { Intent } from '../intent.js';
import type { Snapshot } from '../perception/types.js';
import { distance } from '../perception/geometry.js';
import { isRole, type AllyView, type Role } from '../control/roles.js';
import { canShoot } from '../reflex/bow.js';
import { NEUTRAL_MOBS, armorPoints } from '../reflex/danger.js';
import type { Blackboard, HelpRequest } from './blackboard.js';
import type { Bus } from './bus.js';
import type { Position } from './events.js';

export type SwarmMode = 'independent' | 'cooperative' | 'coordinated';

/** What a bot's decision-making can ask of the swarm. */
export interface SwarmView {
  /** Targets another bot has claimed. */
  claimedByOthers(): ReadonlySet<number>;
  /** The squad's focus target, if the coordinator set one. */
  focusTarget(): number | null;
  /** An ally in trouble that this bot could go and help, at `helpHp` plus `extraHp`. */
  helpNeeded(from: Position, extraHp?: number): HelpRequest | null;
  /** The bot's role: the coordinator's assignment while one is in force, else its configured role. */
  role(): Role;
  /** The other bots in the squad. */
  allies(): AllyView[];
}

/** What Jev is told about the squad. */
// A type alias, not an interface, so it can be sent to Jev as JSON state.
export type SwarmContext = {
  allies: Array<{ name: string; role: string; hp: number; distance_blocks: number }>;
  claims: Array<{ target: string; by: string }>;
  focus: string | null;
};

export interface SwarmMemberOptions {
  agent: string;
  role: Role;
  mode: SwarmMode;
  bus: Bus;
  board: Blackboard;
  helpHp: number;
  helpAllies: boolean;
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * One bot's link to the swarm. Each reflex step it reports what the bot sees and does (position,
 * hostiles, damage, the target it has committed to) and, in return, tells the bot's decision
 * logic which targets are taken, whether the coordinator set a focus, and who needs help. In
 * `independent` mode it does nothing at all.
 */
export class SwarmMember implements SwarmView {
  private lastBeat = Number.NEGATIVE_INFINITY;
  private lastHp: number | null = null;
  private claimed: number | null = null;
  private position: Position = { x: 0, y: 0, z: 0 };
  /** Threats already reported, so a scout can report new ones straight away. */
  private reported = new Set<number>();
  private readonly now: () => number;
  private readonly heartbeatMs: number;

  constructor(private readonly opts: SwarmMemberOptions) {
    this.now = opts.now ?? Date.now;
    this.heartbeatMs = opts.heartbeatMs ?? 1000;
  }

  get active(): boolean {
    return this.opts.mode !== 'independent';
  }

  /** Report the bot's situation. Call every reflex step with the bot's current intent. */
  observe(snapshot: Snapshot, intent: Intent): void {
    if (!this.active) return;
    const { agent, bus } = this.opts;
    const t = this.now();
    this.position = snapshot.self.position;

    const threats = snapshot.entities
      .filter((e) => e.category === 'hostile' && !NEUTRAL_MOBS.has(e.kind))
      .map((e) => ({ id: e.id, kind: e.kind, position: e.position }));
    const beat = t - this.lastBeat >= this.heartbeatMs;
    // A scout's job is to spot: it reports a new threat at once instead of on the next heartbeat.
    const spotted = this.role() === 'scout' && threats.some((e) => !this.reported.has(e.id));
    if (beat) {
      this.lastBeat = t;
      bus.publish({
        type: 'heartbeat',
        agent,
        at: t,
        role: this.role(),
        position: snapshot.self.position,
        hp: snapshot.self.hp,
        armorPoints: armorPoints(snapshot.self.armor),
        canShoot: canShoot(snapshot.inventory),
      });
    }
    if ((beat || spotted) && threats.length) {
      bus.publish({ type: 'threats', agent, at: t, threats });
    }
    if (beat || spotted) this.reported = new Set(threats.map((e) => e.id));

    const hp = snapshot.self.hp;
    if (this.lastHp !== null && hp < this.lastHp - 0.4) {
      bus.publish({ type: 'damaged', agent, at: t, hp });
    }
    this.lastHp = hp;

    this.updateClaim(snapshot, intent);
  }

  private updateClaim(snapshot: Snapshot, intent: Intent): void {
    const { agent, board } = this.opts;
    const wanted = intent.tactic === 'engage' ? (intent.targetId ?? null) : null;
    if (this.claimed !== null && this.claimed !== wanted) {
      board.release(agent, this.claimed);
      this.claimed = null;
    }
    if (wanted === null) return;
    const kind = snapshot.entities.find((e) => e.id === wanted)?.kind ?? 'unknown';
    this.claimed = board.tryClaim(agent, wanted, kind) ? wanted : null;
  }

  claimedByOthers(): ReadonlySet<number> {
    return this.active ? this.opts.board.claimedByOthers(this.opts.agent) : new Set();
  }

  focusTarget(): number | null {
    return this.opts.mode === 'coordinated' ? this.opts.board.focusTarget() : null;
  }

  helpNeeded(from: Position, extraHp = 0): HelpRequest | null {
    if (!this.active || !this.opts.helpAllies) return null;
    return this.opts.board.helpNeededBy(this.opts.agent, from, this.opts.helpHp + extraHp);
  }

  role(): Role {
    if (this.opts.mode !== 'coordinated') return this.opts.role;
    const assigned = this.opts.board.assignedRole(this.opts.agent);
    return isRole(assigned) ? assigned : this.opts.role;
  }

  allies(): AllyView[] {
    if (!this.active) return [];
    return this.opts.board
      .alliesOf(this.opts.agent)
      .map((a) => ({ agent: a.agent, position: a.position, hp: a.hp }));
  }

  /** The squad as Jev should see it, or null when the bot works alone. */
  context(): SwarmContext | null {
    if (!this.active) return null;
    const { agent, board } = this.opts;
    const focus = this.focusTarget();
    return {
      allies: board.alliesOf(agent).map((a) => ({
        name: a.agent,
        role: a.role,
        hp: a.hp,
        distance_blocks: Math.round(distance(this.position, a.position) * 10) / 10,
      })),
      claims: board
        .liveClaims()
        .filter((c) => c.agent !== agent)
        .map((c) => ({ target: `t${c.targetId}`, by: c.agent })),
      focus: focus === null ? null : `t${focus}`,
    };
  }

  /** The bot died: tell the swarm and give up any claim. */
  died(): void {
    if (!this.active) return;
    this.claimed = null;
    this.reported = new Set();
    this.lastHp = null;
    this.opts.bus.publish({ type: 'died', agent: this.opts.agent, at: this.now() });
  }

  /** The bot is leaving the swarm (disconnected or stopped). */
  dispose(): void {
    if (!this.active) return;
    this.claimed = null;
    this.lastHp = null;
    this.lastBeat = Number.NEGATIVE_INFINITY;
    this.opts.bus.publish({ type: 'left', agent: this.opts.agent, at: this.now() });
  }
}
