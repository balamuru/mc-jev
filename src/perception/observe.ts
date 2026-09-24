import { bearingLabel, distance, isApproaching, relativeYaw, withinFov } from './geometry.js';
import type {
  EntityCategory,
  EntityLike,
  EntitySummary,
  ItemLike,
  ObserveInput,
  PerceptionOptions,
  Snapshot,
} from './types.js';

/** Eye height above the entity's feet, used for line-of-sight checks. */
const EYE_HEIGHT = 1.62;

export const DEFAULT_PERCEPTION: PerceptionOptions = {
  radiusBlocks: 24,
  maxEntities: 8,
  fovDegrees: 360,
  requireLineOfSight: false,
};

/** Map a Mineflayer entity type to a category, or null for things we don't perceive (items, arrows…). */
export function categorize(type: string): EntityCategory | null {
  switch (type) {
    case 'player':
      return 'player';
    case 'hostile':
      return 'hostile';
    case 'animal':
    case 'passive':
      return 'passive';
    case 'mob':
      return 'other';
    default:
      return null;
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const itemName = (i: ItemLike | null | undefined) => i?.name ?? null;

function summarize(
  e: EntityLike,
  category: EntityCategory,
  input: ObserveInput,
  opts: PerceptionOptions,
  /** Skip the radius, so the owner is described however far away they are. */
  ignoreRadius = false,
): EntitySummary | null {
  const { self } = input;
  const dist = distance(self.position, e.position);
  if (!ignoreRadius && dist > opts.radiusBlocks) return null;

  const rel = relativeYaw(self.position, self.yaw, e.position);
  let visible = withinFov(rel, opts.fovDegrees);
  if (visible && opts.requireLineOfSight && input.hasLineOfSight) {
    const from = { ...self.position, y: self.position.y + EYE_HEIGHT };
    const to = { ...e.position, y: e.position.y + EYE_HEIGHT };
    visible = input.hasLineOfSight(from, to);
  }

  const kind = e.username ?? e.name ?? e.type;
  return {
    id: e.id,
    kind,
    category,
    ...(category === 'player'
      ? { provoked: input.hostilePlayers?.has(kind.toLowerCase()) ?? false }
      : {}),
    dist: round1(dist),
    position: { x: round1(e.position.x), y: round1(e.position.y), z: round1(e.position.z) },
    bearing: bearingLabel(rel),
    approaching: isApproaching(e.position, e.velocity, self.position),
    held: itemName(e.heldItem),
    visible,
  };
}

/**
 * Turn raw bot and entity data into the compact snapshot the strategic layer reasons about.
 * Pure: no I/O, so it is unit-testable with fake entities.
 */
export function buildSnapshot(
  input: ObserveInput,
  options: Partial<PerceptionOptions> = {},
): Snapshot {
  const opts = { ...DEFAULT_PERCEPTION, ...options };
  const { self } = input;

  const seen: EntitySummary[] = [];
  for (const e of input.entities) {
    const category = categorize(e.type);
    if (!category) continue;
    const s = summarize(e, category, input, opts);
    if (!s) continue;
    // Unseen entities are dropped when a visibility filter is active, so the bot cannot "see" through walls.
    if (!s.visible && (opts.fovDegrees < 360 || opts.requireLineOfSight)) continue;
    seen.push(s);
  }
  seen.sort((a, b) => a.dist - b.dist || a.id - b.id);

  return {
    t: input.now,
    self: {
      position: {
        x: round1(self.position.x),
        y: round1(self.position.y),
        z: round1(self.position.z),
      },
      hp: self.health,
      food: self.food,
      heldItem: itemName(self.heldItem),
      armor: self.armor,
      onGround: self.onGround,
      inWater: self.inWater,
    },
    entities: seen.slice(0, opts.maxEntities),
    owner: input.owner ? summarize(input.owner, 'player', input, opts, true) : null,
    inventory: self.inventory.map((i) => `${i.name}x${i.count}`),
  };
}
