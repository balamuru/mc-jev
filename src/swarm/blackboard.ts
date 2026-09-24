import type { Bus } from './bus.js';
import type { Position, SeenThreat, SwarmEvent } from './events.js';

export interface BlackboardOptions {
  /** A target claim lapses after this long without being refreshed. */
  claimTtlMs: number;
  /** A threat nobody has seen for this long is forgotten. */
  threatTtlMs?: number;
  /** A bot silent for this long is assumed gone. */
  allyTtlMs?: number;
  /** HP loss within this long counts as "recently hit". */
  recentDamageMs?: number;
  now?: () => number;
}

export interface AllyInfo {
  agent: string;
  role: string;
  position: Position;
  hp: number;
  lastHeartbeat: number;
  lastDamagedAt: number | null;
  armorPoints: number;
  canShoot: boolean;
}

export interface ThreatInfo {
  id: number;
  kind: string;
  position: Position;
  lastSeen: number;
  seenBy: string[];
}

export interface ClaimInfo {
  targetId: number;
  agent: string;
  kind: string;
  claimedAt: number;
}

export interface HelpRequest {
  agent: string;
  position: Position;
  hp: number;
}

const dist = (a: Position, b: Position) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * The squad's shared picture of the world, built from bus events: who is where and how healthy,
 * which hostiles anyone has seen, and who has claimed which target. First claim wins, so two bots
 * do not both commit to the same target when another is available.
 */
export class Blackboard {
  private readonly allies = new Map<string, AllyInfo>();
  private readonly threats = new Map<number, { info: ThreatInfo; seenBy: Map<string, number> }>();
  private readonly claims = new Map<number, ClaimInfo>();
  private directive: { focusTargetId: number; expiresAt: number } | null = null;
  private readonly roles = new Map<string, { role: string; expiresAt: number }>();
  private readonly now: () => number;
  private readonly threatTtlMs: number;
  private readonly allyTtlMs: number;
  private readonly recentDamageMs: number;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly bus: Bus,
    private readonly opts: BlackboardOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.threatTtlMs = opts.threatTtlMs ?? 5000;
    this.allyTtlMs = opts.allyTtlMs ?? 10_000;
    this.recentDamageMs = opts.recentDamageMs ?? 5000;
    this.unsubscribe = bus.subscribe('*', (e) => this.handle(e));
  }

  /** Stop listening to the bus. */
  close(): void {
    this.unsubscribe();
  }

  // --- reading -------------------------------------------------------------------------------

  /** Every other live bot. */
  alliesOf(agent: string): AllyInfo[] {
    this.prune();
    return [...this.allies.values()].filter((a) => a.agent !== agent);
  }

  /** Every live bot, including the caller. */
  allAllies(): AllyInfo[] {
    this.prune();
    return [...this.allies.values()];
  }

  knownThreats(): ThreatInfo[] {
    this.prune();
    return [...this.threats.values()].map(({ info, seenBy }) => ({
      ...info,
      seenBy: [...seenBy.keys()],
    }));
  }

  liveClaims(): ClaimInfo[] {
    this.prune();
    return [...this.claims.values()];
  }

  /** Targets that some other bot has claimed. */
  claimedByOthers(agent: string): Set<number> {
    return new Set(
      this.liveClaims()
        .filter((c) => c.agent !== agent)
        .map((c) => c.targetId),
    );
  }

  /** The squad's current focus target, if the coordinator has set one. */
  focusTarget(): number | null {
    this.prune();
    return this.directive?.focusTargetId ?? null;
  }

  /** The role the coordinator assigned to this bot, if an assignment is still in force. */
  assignedRole(agent: string): string | null {
    this.prune();
    return this.roles.get(agent)?.role ?? null;
  }

  /** The nearest ally that is hurt and was hit recently, if any is at or below `helpHp`. */
  helpNeededBy(
    agent: string,
    from: Position,
    helpHp: number,
    maxDistance = 40,
  ): HelpRequest | null {
    const t = this.now();
    let best: HelpRequest | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const ally of this.alliesOf(agent)) {
      const hit = ally.lastDamagedAt !== null && t - ally.lastDamagedAt <= this.recentDamageMs;
      if (!hit || ally.hp > helpHp) continue;
      const d = dist(from, ally.position);
      if (d <= maxDistance && d < bestDist) {
        best = { agent: ally.agent, position: ally.position, hp: ally.hp };
        bestDist = d;
      }
    }
    return best;
  }

  // --- claiming ------------------------------------------------------------------------------

  /**
   * Claim a target. Succeeds if it is free, already yours, or its claim has lapsed; fails if
   * another bot holds it. Refreshing your own claim keeps it alive.
   */
  tryClaim(agent: string, targetId: number, kind: string): boolean {
    this.prune();
    const existing = this.claims.get(targetId);
    if (existing && existing.agent !== agent) return false;
    const t = this.now();
    const isNew = !existing;
    this.claims.set(targetId, { targetId, agent, kind, claimedAt: t });
    if (isNew) this.bus.publish({ type: 'claim', agent, at: t, targetId, kind });
    return true;
  }

  release(agent: string, targetId: number): void {
    const existing = this.claims.get(targetId);
    if (existing?.agent !== agent) return;
    this.claims.delete(targetId);
    this.bus.publish({ type: 'release', agent, at: this.now(), targetId });
  }

  // --- events --------------------------------------------------------------------------------

  private handle(e: SwarmEvent): void {
    switch (e.type) {
      case 'heartbeat': {
        const prev = this.allies.get(e.agent);
        this.allies.set(e.agent, {
          agent: e.agent,
          role: e.role,
          position: e.position,
          hp: e.hp,
          lastHeartbeat: e.at,
          lastDamagedAt: prev?.lastDamagedAt ?? null,
          armorPoints: e.armorPoints ?? 0,
          canShoot: e.canShoot ?? false,
        });
        break;
      }
      case 'damaged': {
        const ally = this.allies.get(e.agent);
        if (ally) {
          ally.hp = e.hp;
          ally.lastDamagedAt = e.at;
        }
        break;
      }
      case 'threats':
        for (const threat of e.threats) this.noteThreat(e.agent, threat, e.at);
        break;
      case 'died':
      case 'left':
        this.allies.delete(e.agent);
        if (e.type === 'left') this.roles.delete(e.agent);
        for (const [id, claim] of this.claims) if (claim.agent === e.agent) this.claims.delete(id);
        break;
      case 'directive':
        this.directive = { focusTargetId: e.focusTargetId, expiresAt: e.at + e.ttlMs };
        break;
      case 'roles':
        for (const [agent, role] of Object.entries(e.roles))
          this.roles.set(agent, { role, expiresAt: e.at + e.ttlMs });
        break;
      default:
        break; // claim / release events are records; the maps are updated by tryClaim / release
    }
  }

  private noteThreat(agent: string, threat: SeenThreat, at: number): void {
    const entry = this.threats.get(threat.id) ?? {
      info: {
        id: threat.id,
        kind: threat.kind,
        position: threat.position,
        lastSeen: at,
        seenBy: [],
      },
      seenBy: new Map<string, number>(),
    };
    entry.info.position = threat.position;
    entry.info.lastSeen = Math.max(entry.info.lastSeen, at);
    entry.seenBy.set(agent, at);
    this.threats.set(threat.id, entry);
  }

  private prune(): void {
    const t = this.now();
    for (const [id, claim] of this.claims) {
      const owner = this.allies.get(claim.agent);
      if (t - claim.claimedAt > this.opts.claimTtlMs || !owner) this.claims.delete(id);
    }
    for (const [name, ally] of this.allies) {
      if (t - ally.lastHeartbeat > this.allyTtlMs) this.allies.delete(name);
    }
    for (const [id, entry] of this.threats) {
      if (t - entry.info.lastSeen > this.threatTtlMs) this.threats.delete(id);
      else
        for (const [agent, seen] of entry.seenBy)
          if (t - seen > this.threatTtlMs) entry.seenBy.delete(agent);
    }
    if (this.directive && t >= this.directive.expiresAt) this.directive = null;
    for (const [agent, r] of this.roles) if (t >= r.expiresAt) this.roles.delete(agent);
  }
}
