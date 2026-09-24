import type { Bearing, Vec3Like } from './types.js';

const TWO_PI = Math.PI * 2;

/** Wrap an angle to (-π, π]. */
export function normalizeAngle(a: number): number {
  const r = ((((a + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  return r === -Math.PI ? Math.PI : r;
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Horizontal angle from the bot's facing direction to a target, in radians.
 * 0 = straight ahead, positive = to the left, negative = to the right (Mineflayer yaw convention).
 */
export function relativeYaw(from: Vec3Like, botYaw: number, to: Vec3Like): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (dx === 0 && dz === 0) return 0;
  return normalizeAngle(Math.atan2(-dx, -dz) - botYaw);
}

const SECTORS: Bearing[] = [
  'ahead',
  'ahead-left',
  'left',
  'behind-left',
  'behind',
  'behind-right',
  'right',
  'ahead-right',
];

/** Map a relative yaw to one of eight 45° sectors centred on the compass points. */
export function bearingLabel(relYaw: number): Bearing {
  const sector = Math.round(normalizeAngle(relYaw) / (Math.PI / 4));
  return SECTORS[((sector % 8) + 8) % 8] as Bearing;
}

/** True when the target's velocity has a component pointing at `me`. */
export function isApproaching(
  pos: Vec3Like,
  vel: Vec3Like,
  me: Vec3Like,
  minSpeed = 0.01,
): boolean {
  const dx = me.x - pos.x;
  const dy = me.y - pos.y;
  const dz = me.z - pos.z;
  const d = Math.hypot(dx, dy, dz);
  if (d === 0) return false;
  return (vel.x * dx + vel.y * dy + vel.z * dz) / d > minSpeed;
}

export function withinFov(relYaw: number, fovDegrees: number): boolean {
  if (fovDegrees >= 360) return true;
  return Math.abs(relYaw) <= (fovDegrees * Math.PI) / 360;
}
