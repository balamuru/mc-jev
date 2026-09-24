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
  inventory: ItemLike[];
}

export interface ObserveInput {
  now: number;
  self: SelfLike;
  entities: EntityLike[];
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
  bearing: Bearing;
  approaching: boolean;
  held: string | null;
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
    onGround: boolean;
    inWater: boolean;
  };
  entities: EntitySummary[];
  inventory: string[];
}
