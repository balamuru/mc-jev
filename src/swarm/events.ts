/**
 * Everything bots tell each other. Events are plain JSON (no classes, no callbacks), so the
 * in-process bus can later be replaced by a network transport such as NATS without changing them.
 */
export interface Position {
  x: number;
  y: number;
  z: number;
}

export interface SeenThreat {
  id: number;
  kind: string;
  position: Position;
}

export type SwarmEvent =
  /** A bot's periodic "here I am", with what the coordinator needs to assign roles. */
  | {
      type: 'heartbeat';
      agent: string;
      at: number;
      role: string;
      position: Position;
      hp: number;
      /** Armor points worn (0-20). */
      armorPoints?: number;
      /** Has a bow and arrows. */
      canShoot?: boolean;
    }
  /** Hostiles a bot can see right now, with where they are. */
  | { type: 'threats'; agent: string; at: number; threats: SeenThreat[] }
  /** A bot lost HP. */
  | { type: 'damaged'; agent: string; at: number; hp: number }
  /** A bot took a target. Sent for the record; who wins a contested claim is decided by the blackboard. */
  | { type: 'claim'; agent: string; at: number; targetId: number; kind: string }
  | { type: 'release'; agent: string; at: number; targetId: number }
  | { type: 'died'; agent: string; at: number }
  | { type: 'left'; agent: string; at: number }
  /** The coordinator's order: the whole squad should focus on this target for a while. */
  | { type: 'directive'; at: number; ttlMs: number; focusTargetId: number }
  /** The coordinator's role assignments, by bot name. Each lapses after `ttlMs`. */
  | { type: 'roles'; at: number; ttlMs: number; roles: Record<string, string> }
  /** A player attacked a squad bot, the owner, or an ally. */
  | { type: 'provoked'; agent: string; attacker: string; victim: string; at: number };

export type SwarmEventType = SwarmEvent['type'];
