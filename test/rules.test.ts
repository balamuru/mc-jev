import { describe, expect, it } from 'vitest';
import { IDLE, intentChanged, type Intent } from '../src/intent.js';
import type { EntitySummary, Snapshot } from '../src/perception/types.js';
import { TARGET_SWITCH_MARGIN_BLOCKS, decideByRules } from '../src/reflex/rules.js';

const rules = { retreatHp: 6, resumeHp: 14, engageRadiusBlocks: 16 };

const mob = (id: number, dist: number, over: Partial<EntitySummary> = {}): EntitySummary => ({
  id,
  kind: 'zombie',
  category: 'hostile',
  dist,
  bearing: 'ahead',
  approaching: true,
  held: null,
  visible: true,
  ...over,
});

const snap = (hp: number, entities: EntitySummary[]): Snapshot => ({
  t: 0,
  self: {
    position: { x: 0, y: 64, z: 0 },
    hp,
    food: 20,
    heldItem: null,
    armor: [],
    onGround: true,
    inWater: false,
  },
  entities: [...entities].sort((a, b) => a.dist - b.dist),
  inventory: [],
});

describe('decideByRules', () => {
  it('idles with no threats', () => {
    expect(decideByRules(snap(20, []), rules)).toEqual(IDLE);
  });

  it('engages the nearest hostile', () => {
    const intent = decideByRules(snap(20, [mob(2, 9), mob(1, 5)]), rules);
    expect(intent).toMatchObject({ tactic: 'engage', targetId: 1 });
  });

  it('ignores passive animals, other mobs and players', () => {
    const entities = [
      mob(1, 3, { category: 'passive', kind: 'cow' }),
      mob(2, 4, { category: 'other', kind: 'villager' }),
      mob(3, 5, { category: 'player', kind: 'Steve' }),
    ];
    expect(decideByRules(snap(20, entities), rules)).toEqual(IDLE);
  });

  it('ignores hostiles it cannot see or that are beyond the engage radius', () => {
    expect(decideByRules(snap(20, [mob(1, 5, { visible: false })]), rules)).toEqual(IDLE);
    expect(decideByRules(snap(20, [mob(1, 17)]), rules)).toEqual(IDLE);
    expect(decideByRules(snap(20, [mob(1, 16)]), rules).tactic).toBe('engage');
  });

  it('retreats at or below the retreat HP, but only when a threat is in range', () => {
    expect(decideByRules(snap(6, [mob(1, 5)]), rules)).toMatchObject({
      tactic: 'retreat',
      targetId: 1,
    });
    expect(decideByRules(snap(7, [mob(1, 5)]), rules).tactic).toBe('engage');
    expect(decideByRules(snap(2, []), rules)).toEqual(IDLE);
  });

  it('keeps retreating until HP recovers to the resume level (hysteresis)', () => {
    const fleeing: Intent = { tactic: 'retreat', targetId: 1, reason: '' };
    expect(decideByRules(snap(10, [mob(1, 8)]), rules, fleeing).tactic).toBe('retreat');
    expect(decideByRules(snap(13, [mob(1, 8)]), rules, fleeing).tactic).toBe('retreat');
    expect(decideByRules(snap(14, [mob(1, 8)]), rules, fleeing).tactic).toBe('engage');
    // Without a prior retreat, mid HP just fights.
    expect(decideByRules(snap(10, [mob(1, 8)]), rules).tactic).toBe('engage');
  });

  it('sticks with the current target unless another is clearly closer', () => {
    const fighting: Intent = { tactic: 'engage', targetId: 1, reason: '' };
    const close = TARGET_SWITCH_MARGIN_BLOCKS - 0.5;
    expect(decideByRules(snap(20, [mob(1, 8), mob(2, 8 - close)]), rules, fighting).targetId).toBe(
      1,
    );
    expect(decideByRules(snap(20, [mob(1, 8), mob(2, 4)]), rules, fighting).targetId).toBe(2);
  });

  it('switches target when the current one is gone', () => {
    const fighting: Intent = { tactic: 'engage', targetId: 1, reason: '' };
    expect(decideByRules(snap(20, [mob(2, 9)]), rules, fighting).targetId).toBe(2);
  });

  it('explains itself', () => {
    expect(decideByRules(snap(20, [mob(1, 5)]), rules).reason).toBe('fighting zombie');
    expect(decideByRules(snap(3, [mob(1, 5)]), rules).reason).toContain('fleeing zombie');
  });
});

describe('intentChanged', () => {
  it('compares tactic and target, not the reason', () => {
    const a: Intent = { tactic: 'engage', targetId: 1, reason: 'x' };
    expect(intentChanged(a, { ...a, reason: 'y' })).toBe(false);
    expect(intentChanged(a, { ...a, targetId: 2 })).toBe(true);
    expect(intentChanged(a, { tactic: 'retreat', targetId: 1, reason: 'x' })).toBe(true);
    expect(intentChanged(a, IDLE)).toBe(true);
  });
});
