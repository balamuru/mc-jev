import { describe, expect, it } from 'vitest';
import {
  bearingLabel,
  distance,
  isApproaching,
  normalizeAngle,
  relativeYaw,
  withinFov,
} from '../src/perception/geometry.js';

const origin = { x: 0, y: 0, z: 0 };

describe('normalizeAngle', () => {
  it('wraps into (-π, π]', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(Math.PI / 2 + 2 * Math.PI)).toBeCloseTo(Math.PI / 2);
    expect(normalizeAngle(-Math.PI)).toBe(Math.PI);
  });
});

describe('relativeYaw (Mineflayer convention: yaw 0 faces -Z, positive is left)', () => {
  it('is 0 for a target straight ahead', () => {
    expect(relativeYaw(origin, 0, { x: 0, y: 0, z: -5 })).toBeCloseTo(0);
  });

  it('is positive for a target to the left and negative to the right', () => {
    // Facing -Z (north): west (-X) is on the left, east (+X) on the right.
    expect(relativeYaw(origin, 0, { x: -5, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2);
    expect(relativeYaw(origin, 0, { x: 5, y: 0, z: 0 })).toBeCloseTo(-Math.PI / 2);
  });

  it('is π for a target directly behind', () => {
    expect(Math.abs(relativeYaw(origin, 0, { x: 0, y: 0, z: 5 }))).toBeCloseTo(Math.PI);
  });

  it('accounts for the bot turning', () => {
    // Bot turned left 90° (now facing west): a west target is now straight ahead.
    expect(relativeYaw(origin, Math.PI / 2, { x: -5, y: 0, z: 0 })).toBeCloseTo(0);
  });

  it('ignores height and returns 0 for a target directly above', () => {
    expect(relativeYaw(origin, 1.2, { x: 0, y: 10, z: 0 })).toBe(0);
  });
});

describe('bearingLabel', () => {
  it.each([
    [0, 'ahead'],
    [Math.PI / 4, 'ahead-left'],
    [Math.PI / 2, 'left'],
    [(3 * Math.PI) / 4, 'behind-left'],
    [Math.PI, 'behind'],
    [-Math.PI, 'behind'],
    [(-3 * Math.PI) / 4, 'behind-right'],
    [-Math.PI / 2, 'right'],
    [-Math.PI / 4, 'ahead-right'],
    [0.3, 'ahead'],
    [0.5, 'ahead-left'],
  ])('%f rad -> %s', (rad, label) => {
    expect(bearingLabel(rad)).toBe(label);
  });
});

describe('isApproaching', () => {
  it('is true when moving toward me and false when moving away or standing still', () => {
    const pos = { x: 10, y: 0, z: 0 };
    expect(isApproaching(pos, { x: -0.2, y: 0, z: 0 }, origin)).toBe(true);
    expect(isApproaching(pos, { x: 0.2, y: 0, z: 0 }, origin)).toBe(false);
    expect(isApproaching(pos, { x: 0, y: 0, z: 0 }, origin)).toBe(false);
  });

  it('ignores sideways motion and negligible speed', () => {
    const pos = { x: 10, y: 0, z: 0 };
    expect(isApproaching(pos, { x: 0, y: 0, z: 0.3 }, origin)).toBe(false);
    expect(isApproaching(pos, { x: -0.005, y: 0, z: 0 }, origin)).toBe(false);
  });

  it('is false at zero distance', () => {
    expect(isApproaching(origin, { x: 1, y: 0, z: 0 }, origin)).toBe(false);
  });
});

describe('withinFov', () => {
  it('always passes at 360°', () => {
    expect(withinFov(Math.PI, 360)).toBe(true);
  });

  it('checks half the field of view on each side', () => {
    expect(withinFov(0.9, 120)).toBe(true); // 120° -> ±60° = ±1.047 rad
    expect(withinFov(-1.1, 120)).toBe(false);
  });
});

describe('distance', () => {
  it('is 3D euclidean', () => {
    expect(distance(origin, { x: 3, y: 4, z: 12 })).toBe(13);
  });
});
