import { describe, expect, it } from 'vitest';
import type { Intent } from '../src/intent.js';
import { decideByRules } from '../src/reflex/rules.js';
import { IGNORE_MIN_DISTANCE_BLOCKS, decideWithJev } from '../src/strategic/policy.js';
import { BARE, mob, rules, snap } from './fixtures.js';
import { judgment } from './jevFixtures.js';

const thresholds = { act: 0.7, cautious: 0.5 };
const decide = (
  j: ReturnType<typeof judgment>,
  snapshot: ReturnType<typeof snap>,
  previous?: Intent,
) => decideWithJev(j, decideByRules(snapshot, rules, previous), snapshot, rules, thresholds);

describe('decideWithJev: nothing to decide', () => {
  it('defers to the rules when there are no threats', () => {
    const d = decide(judgment({ tactic: 'retreat' }), snap(20, []));
    expect(d.source).toBe('rules');
    expect(d.intent.tactic).toBe('idle');
  });
});

describe('decideWithJev: the safety floor', () => {
  it('keeps the rules’ retreat at critical HP, whatever Jev says', () => {
    // Unarmed at 4 HP: the rules retreat. Jev is sure it should fight.
    const s = snap(4, [mob(1, 5)], BARE);
    expect(decideByRules(s, rules).tactic).toBe('retreat');
    const d = decide(judgment({ tactic: 'engage', tacticConfidence: 0.99 }), s);
    expect(d).toMatchObject({ source: 'rules', why: 'rules retreat at critical HP' });
    expect(d.intent.tactic).toBe('retreat');
  });
});

describe('decideWithJev: adding caution', () => {
  const s = snap(20, [mob(1, 5)]); // geared: the rules would fight

  it('retreats when Jev says retreat with at least cautious confidence', () => {
    const d = decide(judgment({ tactic: 'retreat', tacticConfidence: 0.5 }), s);
    expect(d.source).toBe('jev');
    expect(d.intent).toMatchObject({ tactic: 'retreat', targetId: 1 });
    expect(d.intent.reason).toContain('jev: retreat');
  });

  it('ignores a low-confidence retreat', () => {
    const d = decide(judgment({ tactic: 'retreat', tacticConfidence: 0.49 }), s);
    expect(d.source).toBe('rules');
    expect(d.intent.tactic).toBe('engage');
  });

  it('retreats on a confident deadly threat level', () => {
    const d = decide(judgment({ threatLevel: 2.6, threatConfidence: 0.8 }), s);
    expect(d.intent.tactic).toBe('retreat');
    expect(decide(judgment({ threatLevel: 2.4, threatConfidence: 0.8 }), s).intent.tactic).toBe(
      'engage',
    );
    expect(decide(judgment({ threatLevel: 3, threatConfidence: 0.6 }), s).intent.tactic).toBe(
      'engage',
    );
  });

  it('retreats on a likely ambush by several threats, but not by one', () => {
    const two = snap(20, [mob(1, 5), mob(2, 6)]);
    expect(decide(judgment({ ambush: 0.9 }), two).intent.tactic).toBe('retreat');
    expect(decide(judgment({ ambush: 0.8 }), two).intent.tactic).toBe('engage');
    expect(decide(judgment({ ambush: 0.95 }), s).intent.tactic).toBe('engage');
  });

  it('flees from the nearest threat', () => {
    const d = decide(judgment({ tactic: 'retreat' }), snap(20, [mob(2, 9), mob(1, 4)]));
    expect(d.intent.targetId).toBe(1);
  });

  it('agrees with the rules when they already retreat', () => {
    const bare = snap(20, [mob(1, 5), mob(2, 6), mob(3, 7)], BARE);
    const rulesIntent = decideByRules(bare, rules);
    expect(rulesIntent.tactic).toBe('retreat');
    const d = decide(judgment({ tactic: 'retreat' }), bare);
    expect(d.intent).toEqual(rulesIntent);
    expect(d.why).toContain('agrees');
  });
});

describe('decideWithJev: overruling a rules retreat', () => {
  // Unarmed against three zombies at full HP: the rules retreat, above the critical floor.
  const s = snap(20, [mob(1, 5), mob(2, 6), mob(3, 7)], BARE);

  it('lets Jev overrule only with act confidence', () => {
    expect(decideByRules(s, rules).tactic).toBe('retreat');
    const sure = decide(judgment({ tactic: 'engage', tacticConfidence: 0.7 }), s);
    expect(sure).toMatchObject({ source: 'jev' });
    expect(sure.intent.tactic).toBe('engage');
    expect(sure.why).toContain('overruled');

    const unsure = decide(judgment({ tactic: 'engage', tacticConfidence: 0.69 }), s);
    expect(unsure).toMatchObject({ source: 'rules', why: 'rules retreat stands' });
    expect(unsure.intent.tactic).toBe('retreat');
  });

  it('does not let Jev overrule a retreat through an ignore', () => {
    const d = decide(judgment({ tactic: 'ignore', tacticConfidence: 0.99 }), s);
    expect(d.intent.tactic).toBe('retreat');
  });
});

describe('decideWithJev: choosing a target', () => {
  const s = snap(20, [mob(1, 4), mob(2, 9, { kind: 'creeper' })]);

  it('attacks the threat Jev picked when it is confident', () => {
    const d = decide(judgment({ targetId: 2, targetConfidence: 0.6 }), s);
    expect(d.source).toBe('jev');
    expect(d.intent).toMatchObject({ tactic: 'engage', targetId: 2 });
    expect(d.intent.reason).toContain('creeper');
  });

  it('falls back to the nearest threat when Jev is unsure of its pick', () => {
    expect(decide(judgment({ targetId: 2, targetConfidence: 0.4 }), s).intent.targetId).toBe(1);
  });

  it('falls back to the nearest threat when the pick is not a valid threat', () => {
    expect(decide(judgment({ targetId: 99 }), s).intent.targetId).toBe(1);
    expect(decide(judgment({ targetId: null }), s).intent.targetId).toBe(1);
    const neutral = snap(20, [mob(1, 4), mob(7, 5, { kind: 'enderman' })]);
    expect(decide(judgment({ targetId: 7 }), neutral).intent.targetId).toBe(1);
  });

  it('needs at least cautious confidence in engage to act on it', () => {
    const d = decide(judgment({ tactic: 'engage', tacticConfidence: 0.4, targetId: 2 }), s);
    expect(d.source).toBe('rules');
  });
});

describe('decideWithJev: ignoring threats', () => {
  const far = (over = {}) => snap(20, [mob(1, IGNORE_MIN_DISTANCE_BLOCKS + 1, over)]);
  const ignore = judgment({ tactic: 'ignore', tacticConfidence: 0.9 });

  it('goes idle for a confident ignore of a distant, non-approaching threat', () => {
    const d = decide(ignore, far({ approaching: false }));
    expect(d).toMatchObject({ source: 'jev' });
    expect(d.intent.tactic).toBe('idle');
  });

  it('does not ignore an approaching threat', () => {
    expect(decide(ignore, far({ approaching: true })).source).toBe('rules');
  });

  it('does not ignore a threat within the ignore distance', () => {
    const near = snap(20, [mob(1, IGNORE_MIN_DISTANCE_BLOCKS, { approaching: false })]);
    expect(decide(ignore, near).source).toBe('rules');
  });

  it('needs act confidence to ignore', () => {
    const d = decide(
      judgment({ tactic: 'ignore', tacticConfidence: 0.6 }),
      far({ approaching: false }),
    );
    expect(d.source).toBe('rules');
  });
});

describe('decideWithJev with retreating off (the shipped default)', () => {
  const off = { ...rules, retreat: false };
  const decideOff = (j: ReturnType<typeof judgment>, snapshot: ReturnType<typeof snap>) =>
    decideWithJev(j, decideByRules(snapshot, off), snapshot, off, thresholds);
  const s = snap(20, [mob(1, 5), mob(2, 6)]);

  it('ignores every kind of retreat vote from Jev', () => {
    expect(
      decideOff(judgment({ tactic: 'retreat', tacticConfidence: 0.99 }), s).intent.tactic,
    ).toBe('engage');
    expect(decideOff(judgment({ threatLevel: 3, threatConfidence: 0.99 }), s).intent.tactic).toBe(
      'engage',
    );
    expect(decideOff(judgment({ ambush: 0.99 }), s).intent.tactic).toBe('engage');
  });

  it('still lets Jev choose the target', () => {
    const d = decideOff(judgment({ tactic: 'engage', targetId: 2, targetConfidence: 0.9 }), s);
    expect(d.source).toBe('jev');
    expect(d.intent).toMatchObject({ tactic: 'engage', targetId: 2 });
  });

  it('still lets Jev say to ignore a distant threat', () => {
    const far = snap(20, [mob(1, 12, { approaching: false })]);
    expect(
      decideOff(judgment({ tactic: 'ignore', tacticConfidence: 0.9 }), far).intent.tactic,
    ).toBe('idle');
  });
});
