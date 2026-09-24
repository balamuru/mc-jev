import { describe, expect, it } from 'vitest';
import {
  canShoot,
  ARROW_SPEED,
  FULL_DRAW_TICKS,
  arrowCount,
  arrowPath,
  bowStep,
  estimateVelocity,
  hasBow,
  leadTarget,
  shotEndangers,
  shotPath,
  solveAim,
  useBow,
} from '../src/reflex/bow.js';

const item = (name: string, count = 1) => ({ name, count });

describe('arrowPath', () => {
  it('starts at the origin at full speed and falls under gravity', () => {
    const path = arrowPath(0, 10);
    expect(path[0]).toEqual({ x: 0, y: 0, tick: 0 });
    expect(path[1]!.x).toBeCloseTo(ARROW_SPEED);
    expect(path[1]!.y).toBeCloseTo(0);
    expect(path[10]!.y).toBeLessThan(path[5]!.y); // falling
  });

  it('slows down horizontally because of drag', () => {
    const path = arrowPath(0, 20);
    const early = path[2]!.x - path[1]!.x;
    const late = path[20]!.x - path[19]!.x;
    expect(late).toBeLessThan(early);
  });
});

describe('solveAim', () => {
  it('aims a little above level for a level target, more the farther it is', () => {
    const near = solveAim(10, 0)!;
    const far = solveAim(30, 0)!;
    expect(near.pitch).toBeGreaterThan(0);
    expect(far.pitch).toBeGreaterThan(near.pitch);
    expect(far.flightTicks).toBeGreaterThan(near.flightTicks);
  });

  it('lands the arrow at the target height (checked by simulation)', () => {
    for (const [dx, dy] of [
      [12, 0],
      [20, -2],
      [15, 4],
    ] as const) {
      const s = solveAim(dx, dy)!;
      const path = arrowPath(s.pitch);
      const i = path.findIndex((p) => p.x >= dx);
      const a = path[i - 1]!;
      const b = path[i]!;
      const y = a.y + ((dx - a.x) / (b.x - a.x)) * (b.y - a.y);
      expect(y).toBeCloseTo(dy, 2);
    }
  });

  it('aims higher for a target above and lower for one below', () => {
    expect(solveAim(15, 5)!.pitch).toBeGreaterThan(solveAim(15, 0)!.pitch);
    expect(solveAim(15, -5)!.pitch).toBeLessThan(solveAim(15, 0)!.pitch);
  });

  it('refuses targets out of reach, or with no horizontal distance', () => {
    expect(solveAim(15, 200)).toBeNull();
    expect(solveAim(0, 0)).toBeNull();
    expect(solveAim(-5, 0)).toBeNull();
  });
});

describe('leadTarget', () => {
  const from = { x: 0, y: 64, z: 0 };
  it('aims at the target itself when it is still', () => {
    expect(leadTarget(from, { x: 15, y: 64, z: 0 }, { x: 0, y: 0, z: 0 })).toEqual({
      x: 15,
      y: 64,
      z: 0,
    });
  });

  it('aims ahead of a moving target, by more when it moves faster', () => {
    const slow = leadTarget(from, { x: 15, y: 64, z: 0 }, { x: 0, y: 0, z: 0.1 });
    const fast = leadTarget(from, { x: 15, y: 64, z: 0 }, { x: 0, y: 0, z: 0.3 });
    expect(slow.z).toBeGreaterThan(0);
    expect(fast.z).toBeGreaterThan(slow.z);
    expect(slow.x).toBe(15);
  });
});

describe('shotPath and shotEndangers', () => {
  const from = { x: 0, y: 65.5, z: 0 };
  const to = { x: 15, y: 65, z: 0 };
  const path = shotPath(from, to, solveAim(15, -0.5)!.pitch);

  it('runs from the shooter to the target', () => {
    expect(path[0]!.x).toBeCloseTo(0);
    expect(path.at(-1)).toEqual(to);
    expect(path.every((p) => Math.abs(p.z) < 1e-9)).toBe(true);
  });

  it('flags a player standing in the line of fire', () => {
    expect(shotEndangers(path, [{ x: 8, y: 64, z: 0 }])).toBe(true);
    expect(shotEndangers(path, [{ x: 8, y: 64, z: 1 }])).toBe(true);
  });

  it('does not flag players well to the side, behind the shooter, or none at all', () => {
    expect(shotEndangers(path, [{ x: 8, y: 64, z: 4 }])).toBe(false);
    expect(shotEndangers(path, [{ x: -3, y: 64, z: 0 }])).toBe(false);
    expect(shotEndangers(path, [])).toBe(false);
  });
});

describe('inventory checks', () => {
  it('counts every kind of arrow', () => {
    expect(
      arrowCount([
        item('arrow', 16),
        item('spectral_arrow', 4),
        item('tipped_arrow', 2),
        item('apple', 3),
      ]),
    ).toBe(22);
    expect(arrowCount([])).toBe(0);
  });

  it('knows whether there is a bow', () => {
    expect(hasBow([item('bow')])).toBe(true);
    expect(hasBow([item('crossbow')])).toBe(false);
  });
});

describe('useBow', () => {
  const range = { minBlocks: 6, maxBlocks: 20 };
  const kit = [item('bow'), item('arrow', 16)];

  it('uses the bow inside its range with a bow and arrows', () => {
    expect(useBow(6, kit, range)).toBe(true);
    expect(useBow(20, kit, range)).toBe(true);
  });

  it('uses melee up close or beyond range', () => {
    expect(useBow(5.9, kit, range)).toBe(false);
    expect(useBow(20.1, kit, range)).toBe(false);
  });

  it('cannot use a bow without arrows, or arrows without a bow', () => {
    expect(useBow(10, [item('bow')], range)).toBe(false);
    expect(useBow(10, [item('arrow', 16)], range)).toBe(false);
  });
});

describe('bowStep', () => {
  it('starts drawing, holds until full power, then releases with a clear shot', () => {
    expect(bowStep({ drawTicks: 0, clearShot: true })).toBe('draw');
    expect(bowStep({ drawTicks: FULL_DRAW_TICKS - 1, clearShot: true })).toBe('hold');
    expect(bowStep({ drawTicks: FULL_DRAW_TICKS, clearShot: true })).toBe('release');
  });

  it('keeps holding a full draw while the shot is not clear', () => {
    expect(bowStep({ drawTicks: FULL_DRAW_TICKS + 30, clearShot: false })).toBe('hold');
  });
});

describe('estimateVelocity', () => {
  it('averages movement per tick over the history', () => {
    const v = estimateVelocity([
      { x: 0, y: 64, z: 0 },
      { x: 0.2, y: 64, z: 0 },
      { x: 0.4, y: 64, z: 0.1 },
    ]);
    expect(v.x).toBeCloseTo(0.2);
    expect(v.z).toBeCloseTo(0.05);
  });

  it('is zero without enough history', () => {
    expect(estimateVelocity([])).toEqual({ x: 0, y: 0, z: 0 });
    expect(estimateVelocity([{ x: 1, y: 2, z: 3 }])).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('canShoot', () => {
  it('needs a bow and at least one arrow in the inventory summary', () => {
    expect(canShoot(['bowx1', 'arrowx3'])).toBe(true);
    expect(canShoot(['bowx1', 'tipped_arrowx1'])).toBe(true);
    expect(canShoot(['bowx1'])).toBe(false);
    expect(canShoot(['arrowx64', 'iron_swordx1'])).toBe(false);
  });
});
