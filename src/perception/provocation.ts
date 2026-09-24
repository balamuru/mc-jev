/**
 * Works out which players are attacking the bot, from what it can observe: its HP dropped, and a
 * player was seen swinging an arm close by at the same moment. A player who attacks is
 * "provoked", and stays that way for `memoryMs` after their last hit, so the bot can defend
 * itself. Jev's judgment about a player can also mark them as hostile for a while.
 *
 * Deliberately conservative: nothing here makes the bot attack a player who has not either hit it
 * or been judged a threat, and the owner and allies are never fought whatever this says.
 */
export interface ProvocationOptions {
  /** A swing this recent (ms) counts as the cause of an HP drop. */
  swingWindowMs: number;
  /** Only players this close (blocks) can have hit the bot. */
  reachBlocks: number;
  /** How long an attacker stays hostile after their last hit (ms). */
  memoryMs: number;
  /** HP drops smaller than this are ignored (regeneration jitter). */
  minDrop: number;
}

export const DEFAULT_PROVOCATION: ProvocationOptions = {
  swingWindowMs: 600,
  reachBlocks: 6.5,
  memoryMs: 20_000,
  minDrop: 0.4,
};

export interface HpDrop {
  amount: number;
  /** A hostile mob was right next to the bot, so it is the likelier culprit. */
  mobNearby: boolean;
}

export class ProvocationTracker {
  private readonly swings = new Map<string, { at: number; dist: number }>();
  private readonly hostileUntil = new Map<string, number>();

  constructor(private readonly opts: ProvocationOptions = DEFAULT_PROVOCATION) {}

  /** A player was seen swinging an arm `dist` blocks from the bot. */
  noteSwing(username: string, dist: number, now: number): void {
    this.swings.set(username.toLowerCase(), { at: now, dist });
  }

  /** The server said this player hit the bot (Mineflayer's `entityHurt` names the source). */
  noteHit(username: string, now: number): void {
    this.hostileUntil.set(username.toLowerCase(), now + this.opts.memoryMs);
  }

  /** The bot lost HP. Players who just swung within reach are marked as attackers. */
  noteHpDrop(drop: HpDrop, now: number): string[] {
    if (drop.amount < this.opts.minDrop || drop.mobNearby) return [];
    const attackers: string[] = [];
    for (const [name, swing] of this.swings) {
      if (now - swing.at > this.opts.swingWindowMs) continue;
      if (swing.dist > this.opts.reachBlocks) continue;
      this.hostileUntil.set(name, now + this.opts.memoryMs);
      attackers.push(name);
    }
    return attackers;
  }

  /** Jev judged this player a threat; treat them as hostile for `ttlMs`. */
  markHostile(username: string, now: number, ttlMs: number): void {
    const key = username.toLowerCase();
    this.hostileUntil.set(key, Math.max(this.hostileUntil.get(key) ?? 0, now + ttlMs));
  }

  /** Lower-case names of players currently considered hostile. */
  hostileNames(now: number): Set<string> {
    const names = new Set<string>();
    for (const [name, until] of this.hostileUntil) {
      if (until > now) names.add(name);
      else this.hostileUntil.delete(name);
    }
    for (const [name, swing] of this.swings) {
      if (now - swing.at > this.opts.swingWindowMs * 4) this.swings.delete(name);
    }
    return names;
  }

  /** Forget everything, e.g. after dying or reconnecting. */
  reset(): void {
    this.swings.clear();
    this.hostileUntil.clear();
  }
}
