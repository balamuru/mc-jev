/** Minimal shapes the perception code needs. Mineflayer objects satisfy these structurally. */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface ItemLike {
  name: string;
  count: number;
}

export interface EntityLike {
  id: number;
  /** Mineflayer entity type: 'player', 'hostile', 'mob', 'animal', 'passive', 'object', … */
  type: string;
  name?: string;
  username?: string;
  position: Vec3Like;
  velocity: Vec3Like;
  /** Held item first, per Mineflayer's `equipment` layout. */
  heldItem?: ItemLike | null;
}

export interface SelfLike {
  position: Vec3Like;
  /** Radians, Mineflayer convention: 0 faces -Z, positive turns left. */
  yaw: number;
  health: number;
  food: number;
  onGround: boolean;
  inWater: boolean;
  heldItem: ItemLike | null;
  /** Names of worn armor pieces. */
  armor: string[];
  /** The item in the off-hand, e.g. a shield. */
  offhand?: ItemLike | null;
  inventory: ItemLike[];
}

export interface ObserveInput {
  now: number;
  self: SelfLike;
  entities: EntityLike[];
  /** The owner's entity, if known. */
  owner?: EntityLike | null;
  /** Lower-case names of players currently considered hostile (they attacked, or Jev judged them a threat). */
  hostilePlayers?: ReadonlySet<string>;
  /** Returns true when nothing solid blocks the line between two points. */
  hasLineOfSight?: (from: Vec3Like, to: Vec3Like) => boolean;
}

export interface PerceptionOptions {
  /** Entities farther than this are ignored. */
  radiusBlocks: number;
  /** Keep at most this many entities (nearest first). */
  maxEntities: number;
  /** Horizontal field of view in degrees; 360 disables the FOV filter. */
  fovDegrees: number;
  /** Drop entities the bot has no line of sight to. */
  requireLineOfSight: boolean;
}

export type EntityCategory = 'hostile' | 'player' | 'passive' | 'other';

export type Bearing =
  | 'ahead'
  | 'ahead-left'
  | 'left'
  | 'behind-left'
  | 'behind'
  | 'behind-right'
  | 'right'
  | 'ahead-right';

export interface EntitySummary {
  id: number;
  kind: string;
  category: EntityCategory;
  /** Blocks, one decimal. */
  dist: number;
  /** Where it is in the world, one decimal. Lets bots share what they see. */
  position: Vec3Like;
  bearing: Bearing;
  approaching: boolean;
  held: string | null;
  /** For a player: whether they have attacked the bot, or were judged a threat, recently. */
  provoked?: boolean;
  /** Whether it is inside the field of view and (if checked) in line of sight. */
  visible: boolean;
}

export interface Snapshot {
  t: number;
  self: {
    position: Vec3Like;
    hp: number;
    food: number;
    heldItem: string | null;
    armor: string[];
    /** The off-hand item, e.g. `shield`, or null. */
    offhand?: string | null;
    onGround: boolean;
    inWater: boolean;
  };
  entities: EntitySummary[];
  /**
   * The bot's owner, if the server is tracking them, even when they are beyond the perception
   * radius (a player is tracked out to about 48 blocks). Used to follow them.
   */
  owner?: EntitySummary | null;
  inventory: string[];
}
