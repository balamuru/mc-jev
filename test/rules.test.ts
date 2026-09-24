import { describe, expect, it } from 'vitest';
import { IDLE, intentChanged, type Intent } from '../src/intent.js';
import { TARGET_SWITCH_MARGIN_BLOCKS, decideByRules } from '../src/reflex/rules.js';
import { BARE, mob, rules, snap } from './fixtures.js';

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

  it('ignores neutral mobs such as endermen and wolves', () => {
    const entities = [mob(1, 3, { kind: 'enderman' }), mob(2, 4, { kind: 'wolf' })];
    expect(decideByRules(snap(20, entities), rules)).toEqual(IDLE);
    // ...but still fights a real hostile next to them.
    expect(decideByRules(snap(20, [...entities, mob(3, 8)]), rules).targetId).toBe(3);
  });

  it('ignores hostiles it cannot see or that are beyond the engage radius', () => {
    expect(decideByRules(snap(20, [mob(1, 5, { visible: false })]), rules)).toEqual(IDLE);
    expect(decideByRules(snap(20, [mob(1, 17)]), rules)).toEqual(IDLE);
    expect(decideByRules(snap(20, [mob(1, 16)]), rules).tactic).toBe('engage');
  });

  describe('retreating', () => {
    it('retreats at or below the retreat HP when the fight is not clearly safe', () => {
      expect(decideByRules(snap(6, [mob(1, 5)], BARE), rules)).toMatchObject({
        tactic: 'retreat',
        targetId: 1,
      });
      expect(decideByRules(snap(7, [mob(1, 5)], BARE), rules).tactic).toBe('engage');
      expect(decideByRules(snap(2, []), rules)).toEqual(IDLE);
    });

    it('fights a single zombie at low HP when geared up (the survival benchmark showed retreating there is deadly)', () => {
      expect(decideByRules(snap(6, [mob(1, 5)]), rules).tactic).toBe('engage');
      expect(decideByRules(snap(3, [mob(1, 5)]), rules).tactic).toBe('engage');
    });

    it('retreats from three zombies at low HP even when geared up', () => {
      expect(decideByRules(snap(6, [mob(1, 5), mob(2, 6), mob(3, 7)]), rules).tactic).toBe(
        'retreat',
      );
    });

    it('still fights at low HP when the fight is nearly risk-free', () => {
      const gear = {
        armor: [
          'netherite_helmet',
          'netherite_chestplate',
          'netherite_leggings',
          'netherite_boots',
        ],
        weapon: 'diamond_sword',
      };
      expect(decideByRules(snap(6, [mob(1, 5)], gear), rules).tactic).toBe('engage');
    });

    it('retreats at full HP from a fight it would lose', () => {
      const bare = { armor: [], weapon: null };
      const intent = decideByRules(snap(20, [mob(1, 5), mob(2, 6), mob(3, 7)], bare), rules);
      expect(intent.tactic).toBe('retreat');
      expect(intent.reason).toContain('expected damage');
    });

    it('takes a fight it can win when geared up', () => {
      expect(decideByRules(snap(20, [mob(1, 5), mob(2, 6)]), rules).tactic).toBe('engage');
    });

    it('is more cautious with a lower danger margin', () => {
      const wary = { ...rules, dangerMargin: 0.1 };
      expect(decideByRules(snap(20, [mob(1, 5)], BARE), rules).tactic).toBe('engage');
      expect(decideByRules(snap(20, [mob(1, 5)], BARE), wary).tactic).toBe('retreat');
    });

    it('keeps retreating until HP recovers to the resume level (hysteresis)', () => {
      const fleeing: Intent = { tactic: 'retreat', targetId: 1, reason: '' };
      expect(decideByRules(snap(10, [mob(1, 8)]), rules, fleeing).tactic).toBe('retreat');
      expect(decideByRules(snap(13, [mob(1, 8)]), rules, fleeing).tactic).toBe('retreat');
      expect(decideByRules(snap(14, [mob(1, 8)]), rules, fleeing).tactic).toBe('engage');
      // Without a prior retreat, mid HP just fights.
      expect(decideByRules(snap(10, [mob(1, 8)]), rules).tactic).toBe('engage');
    });

    it('keeps retreating from a fight that is only barely winnable', () => {
      // An unarmed bot expects about 3.5 damage from one zombie: acceptable at 5 HP (< 80%), but only just.
      const loose = { ...rules, retreatHp: 3, resumeHp: 5 };
      const one = [mob(1, 5)];
      expect(decideByRules(snap(5, one, BARE), loose).tactic).toBe('engage');
      const fleeing: Intent = { tactic: 'retreat', targetId: 1, reason: '' };
      expect(decideByRules(snap(5, one, BARE), loose, fleeing).tactic).toBe('retreat');
    });
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
    expect(decideByRules(snap(3, [mob(1, 5)], BARE), rules).reason).toContain('fleeing zombie');
  });
});

describe('decideByRules with retreating off (the shipped default)', () => {
  const off = { ...rules, retreat: false };

  it('fights on however bad the odds', () => {
    const three = [mob(1, 5), mob(2, 6), mob(3, 7)];
    expect(decideByRules(snap(2, three, BARE), off)).toMatchObject({
      tactic: 'engage',
      targetId: 1,
    });
    expect(decideByRules(snap(20, three, BARE), off).tactic).toBe('engage');
  });

  it('does not keep retreating from an earlier retreat intent', () => {
    const fleeing: Intent = { tactic: 'retreat', targetId: 1, reason: '' };
    expect(decideByRules(snap(3, [mob(1, 5)], BARE), off, fleeing).tactic).toBe('engage');
  });

  it('still idles with no threats and still targets the nearest', () => {
    expect(decideByRules(snap(3, []), off)).toEqual(IDLE);
    expect(decideByRules(snap(3, [mob(2, 9), mob(1, 4)]), off).targetId).toBe(1);
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
