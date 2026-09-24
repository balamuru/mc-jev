import type { ItemLike, Vec3Like } from '../perception/types.js';

/**
 * Bow combat, as pure functions. Arrows fly on an arc, so aiming means solving for the pitch that
 * lands the arrow on the target, and leading a moving target by where it will be when the arrow
 * arrives. The constants are Java Edition arrow physics; `test/integration/bow.test.ts` checks the
 * aim on a real server.
 */

/** Arrow speed at full draw, in blocks per tick. */
export const ARROW_SPEED = 3.0;
/** Downward acceleration per tick. */
export const ARROW_GRAVITY = 0.05;
/** Velocity is multiplied by this every tick (air drag). */
export const ARROW_DRAG = 0.99;
/** Arrows leave from just below the eyes. */
export const ARROW_LAUNCH_OFFSET = -0.1;
/** Ticks of drawing before the bow is at full power. */
export const FULL_DRAW_TICKS = 20;
/** Give up on a shot that would take longer than this to arrive. */
export const MAX_FLIGHT_TICKS = 60;

export interface ArrowPoint {
  /** Horizontal distance travelled. */
  x: number;
  /** Height relative to the launch point. */
  y: number;
  tick: number;
}

/** The arrow's path in the vertical plane, for a given pitch (radians, positive is up). */
export function arrowPath(
  pitch: number,
  maxTicks = MAX_FLIGHT_TICKS,
  speed = ARROW_SPEED,
): ArrowPoint[] {
  let vx = Math.cos(pitch) * speed;
  let vy = Math.sin(pitch) * speed;
  let x = 0;
  let y = 0;
  const points: ArrowPoint[] = [{ x, y, tick: 0 }];
  for (let tick = 1; tick <= maxTicks; tick++) {
    x += vx;
    y += vy;
    vx *= ARROW_DRAG;
    vy = vy * ARROW_DRAG - ARROW_GRAVITY;
    points.push({ x, y, tick });
  }
  return points;
}

/** Height of the arrow when it has travelled `distance` horizontally, and the tick it gets there. */
function heightAt(pitch: number, distance: number): { y: number; ticks: number } | null {
  const path = arrowPath(pitch);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (b.x >= distance) {
      const f = (distance - a.x) / (b.x - a.x);
      return { y: a.y + f * (b.y - a.y), ticks: a.tick + f };
    }
  }
  return null;
}

export interface AimSolution {
  /** Radians, positive is up (Mineflayer's convention). */
  pitch: number;
  /** Ticks until the arrow arrives. */
  flightTicks: number;
}

/**
 * The flattest pitch that lands an arrow `dy` blocks above the launch point at horizontal
 * distance `dx`, or null if the target is out of range.
 */
export function solveAim(dx: number, dy: number): AimSolution | null {
  if (dx <= 0) return null;
  // Height reached at dx rises with pitch up to the pitch of maximum range, so bisect below that.
  let lo = -Math.PI / 3;
  let hi = Math.PI / 4;
  const top = heightAt(hi, dx);
  if (!top || top.y < dy) return null;
  const bottom = heightAt(lo, dx);
  if (bottom && bottom.y > dy) return null; // would need to aim lower than we allow
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const at = heightAt(mid, dx);
    if (!at || at.y < dy) lo = mid;
    else hi = mid;
  }
  const at = heightAt(hi, dx);
  return at ? { pitch: hi, flightTicks: at.ticks } : null;
}

/**
 * Where to aim at a moving target: its position after the arrow's flight time. Refined a few
 * times, since the flight time depends on the distance. `velocity` is in blocks per tick.
 */
export function leadTarget(from: Vec3Like, target: Vec3Like, velocity: Vec3Like): Vec3Like {
  let aim = { ...target };
  for (let i = 0; i < 3; i++) {
    const dx = Math.hypot(aim.x - from.x, aim.z - from.z);
    const solution = solveAim(dx, aim.y - from.y);
    if (!solution) return aim;
    const t = solution.flightTicks;
    aim = { x: target.x + velocity.x * t, y: target.y, z: target.z + velocity.z * t };
  }
  return aim;
}

/** Points along the shot, in world coordinates, for safety and line-of-sight checks. */
export function shotPath(from: Vec3Like, to: Vec3Like, pitch: number): Vec3Like[] {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  if (horizontal === 0) return [from];
  const ux = dx / horizontal;
  const uz = dz / horizontal;
  const out: Vec3Like[] = [];
  for (const p of arrowPath(pitch)) {
    if (p.x > horizontal) break;
    out.push({ x: from.x + ux * p.x, y: from.y + p.y, z: from.z + uz * p.x });
  }
  out.push({ x: to.x, y: to.y, z: to.z });
  return out;
}

/** Players must stay at least this far from every point of the arrow's path. */
export const SHOT_CLEARANCE_BLOCKS = 1.5;

/**
 * True when the arrow's path passes near any of `players` (their feet positions). The path is
 * checked from 1 block out, so the shooter's own position does not count.
 */
export function shotEndangers(path: Vec3Like[], players: Vec3Like[]): boolean {
  const start = path[0];
  if (!start) return false;
  for (const point of path) {
    if (Math.hypot(point.x - start.x, point.z - start.z) < 1) continue;
    for (const p of players) {
      // Compare against the player's middle, not their feet.
      const dist = Math.hypot(point.x - p.x, point.y - (p.y + 0.9), point.z - p.z);
      if (dist <= SHOT_CLEARANCE_BLOCKS) return true;
    }
  }
  return false;
}

/** How many arrows are in the inventory, of any kind. */
export function arrowCount(items: ItemLike[]): number {
  return items
    .filter((i) => i.name === 'arrow' || i.name === 'spectral_arrow' || i.name === 'tipped_arrow')
    .reduce((n, i) => n + i.count, 0);
}

export function hasBow(items: ItemLike[]): boolean {
  return items.some((i) => i.name === 'bow');
}

/** Parses the snapshot's inventory summary ("namexcount" strings) into items. */
export function itemsFromSummary(inventory: string[]): ItemLike[] {
  return inventory.map((i) => {
    const m = /^(.*)x(\d+)$/.exec(i);
    return { name: m?.[1] ?? i, count: Number(m?.[2] ?? 0) };
  });
}

/** Whether the inventory summary holds a bow and at least one arrow. */
export function canShoot(inventory: string[]): boolean {
  const items = itemsFromSummary(inventory);
  return hasBow(items) && arrowCount(items) > 0;
}

export interface BowRange {
  minBlocks: number;
  maxBlocks: number;
}

/** Whether to fight this target with the bow rather than a melee weapon. */
export function useBow(dist: number, items: ItemLike[], range: BowRange): boolean {
  return (
    dist >= range.minBlocks && dist <= range.maxBlocks && hasBow(items) && arrowCount(items) > 0
  );
}

export type BowStep = 'draw' | 'hold' | 'release';

export interface BowStepInput {
  /** Ticks since the draw started; 0 when not drawing. */
  drawTicks: number;
  /** A solution exists and the path is clear of blocks and players. */
  clearShot: boolean;
}

/** One tick of the draw: start drawing, keep holding, or let go at full power with a clear shot. */
export function bowStep(input: BowStepInput): BowStep {
  if (input.drawTicks === 0) return 'draw';
  if (input.drawTicks >= FULL_DRAW_TICKS && input.clearShot) return 'release';
  return 'hold';
}

/** Estimate a velocity in blocks per tick from recent positions (oldest first), one per tick. */
export function estimateVelocity(history: Vec3Like[]): Vec3Like {
  if (history.length < 2) return { x: 0, y: 0, z: 0 };
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const n = history.length - 1;
  return { x: (last.x - first.x) / n, y: (last.y - first.y) / n, z: (last.z - first.z) / n };
}
