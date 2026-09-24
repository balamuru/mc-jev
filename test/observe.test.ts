import { describe, expect, it } from 'vitest';
import { buildSnapshot, categorize } from '../src/perception/observe.js';
import type { EntityLike, ObserveInput, SelfLike } from '../src/perception/types.js';

const self: SelfLike = {
  position: { x: 0, y: 64, z: 0 },
  yaw: 0, // facing -Z
  health: 18,
  food: 15,
  onGround: true,
  inWater: false,
  heldItem: { name: 'iron_sword', count: 1 },
  armor: ['iron_chestplate'],
  inventory: [
    { name: 'iron_sword', count: 1 },
    { name: 'cooked_beef', count: 12 },
  ],
};

let nextId = 1;
const entity = (over: Partial<EntityLike> & { x?: number; z?: number }): EntityLike => {
  const { x = 0, z = -5, ...rest } = over;
  return {
    id: nextId++,
    type: 'hostile',
    name: 'zombie',
    position: { x, y: 64, z },
    velocity: { x: 0, y: 0, z: 0 },
    ...rest,
  };
};

const input = (entities: EntityLike[], extra: Partial<ObserveInput> = {}): ObserveInput => ({
  now: 1234,
  self,
  entities,
  ...extra,
});

describe('categorize', () => {
  it('maps Mineflayer types and drops non-creatures', () => {
    expect(categorize('player')).toBe('player');
    expect(categorize('hostile')).toBe('hostile');
    expect(categorize('animal')).toBe('passive');
    expect(categorize('passive')).toBe('passive');
    expect(categorize('mob')).toBe('other');
    expect(categorize('object')).toBeNull();
    expect(categorize('orb')).toBeNull();
    expect(categorize('projectile')).toBeNull();
  });
});

describe('buildSnapshot', () => {
  it('summarizes the bot itself', () => {
    const snap = buildSnapshot(input([]));
    expect(snap).toMatchObject({
      t: 1234,
      self: {
        position: { x: 0, y: 64, z: 0 },
        hp: 18,
        food: 15,
        heldItem: 'iron_sword',
        armor: ['iron_chestplate'],
        onGround: true,
        inWater: false,
      },
      inventory: ['iron_swordx1', 'cooked_beefx12'],
    });
  });

  it('describes an entity: kind, distance, bearing, approach and held item', () => {
    const zombie = entity({
      z: -3.26,
      velocity: { x: 0, y: 0, z: 0.1 },
      heldItem: { name: 'wooden_sword', count: 1 },
    });
    const [e] = buildSnapshot(input([zombie])).entities;
    expect(e).toEqual({
      id: zombie.id,
      kind: 'zombie',
      category: 'hostile',
      dist: 3.3,
      bearing: 'ahead',
      approaching: true,
      held: 'wooden_sword',
      visible: true,
    });
  });

  it('uses a player username as the kind', () => {
    const p = entity({ type: 'player', name: undefined, username: 'Steve', x: 4, z: 0 });
    const [e] = buildSnapshot(input([p])).entities;
    expect(e).toMatchObject({ kind: 'Steve', category: 'player', bearing: 'right' });
  });

  it('sorts nearest first, breaking ties by id, and caps the list', () => {
    const far = entity({ z: -20 });
    const near = entity({ z: -2 });
    const mid = entity({ z: -8 });
    const snap = buildSnapshot(input([far, near, mid]), { maxEntities: 2 });
    expect(snap.entities.map((e) => e.id)).toEqual([near.id, mid.id]);
  });

  it('ignores entities beyond the radius and non-creature entities', () => {
    const tooFar = entity({ z: -30 });
    const arrow = entity({ type: 'projectile', z: -3 });
    const item = entity({ type: 'object', z: -3 });
    expect(buildSnapshot(input([tooFar, arrow, item])).entities).toEqual([]);
    expect(buildSnapshot(input([tooFar]), { radiusBlocks: 40 }).entities).toHaveLength(1);
  });

  it('filters entities outside the field of view', () => {
    const ahead = entity({ z: -5 });
    const behind = entity({ z: 5 });
    const snap = buildSnapshot(input([ahead, behind]), { fovDegrees: 120 });
    expect(snap.entities.map((e) => e.id)).toEqual([ahead.id]);
  });

  it('keeps everything, all visible, when no filter is active', () => {
    const behind = entity({ z: 5 });
    const [e] = buildSnapshot(input([behind])).entities;
    expect(e?.visible).toBe(true);
    expect(e?.bearing).toBe('behind');
  });

  it('drops entities without line of sight when required, measured eye to eye', () => {
    const seen = entity({ z: -5 });
    const hidden = entity({ z: -6 });
    const calls: Array<[number, number]> = [];
    const snap = buildSnapshot(
      input([seen, hidden], {
        hasLineOfSight: (from, to) => {
          calls.push([from.y, to.y]);
          return to.z !== -6;
        },
      }),
      { requireLineOfSight: true },
    );
    expect(snap.entities.map((e) => e.id)).toEqual([seen.id]);
    expect(calls[0]).toEqual([65.62, 65.62]);
  });

  it('does not check line of sight for entities already outside the field of view', () => {
    let called = 0;
    const behind = entity({ z: 5 });
    buildSnapshot(
      input([behind], {
        hasLineOfSight: () => {
          called++;
          return true;
        },
      }),
      { fovDegrees: 90, requireLineOfSight: true },
    );
    expect(called).toBe(0);
  });

  it('ignores line-of-sight settings when no checker is supplied', () => {
    const e = entity({ z: -5 });
    expect(buildSnapshot(input([e]), { requireLineOfSight: true }).entities).toHaveLength(1);
  });

  it('reports an empty hand as null', () => {
    const bare = { ...self, heldItem: null };
    expect(buildSnapshot({ ...input([]), self: bare }).self.heldItem).toBeNull();
  });
});
