import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../src/strategic/jev.js';
import {
  MAX_THREATS_IN_STATE,
  NO_TARGET,
  QUESTION_SET_VERSION,
  buildQuestions,
  buildState,
  parseJudgment,
  relevantThreats,
} from '../src/strategic/questions.js';
import { mob, snap } from './fixtures.js';

describe('buildState', () => {
  const state = buildState(
    snap(12, [mob(5, 4.2), mob(9, 10, { kind: 'skeleton', held: 'bow' })]),
    16,
  ) as {
    self: Record<string, unknown>;
    threats: Array<Record<string, unknown>>;
  };

  it('describes the bot with named fields', () => {
    expect(state.self).toEqual({
      hp: 12,
      max_hp: 20,
      food: 20,
      weapon: 'iron_sword',
      armor_points: 15,
      in_water: false,
    });
  });

  it('describes each threat with a stable id, distance, direction and what it holds', () => {
    expect(state.threats[0]).toMatchObject({
      id: 't5',
      kind: 'zombie',
      distance_blocks: 4.2,
      direction: 'ahead',
      approaching: true,
      holding: null,
      visible: true,
    });
    expect(state.threats[1]).toMatchObject({ id: 't9', kind: 'skeleton', holding: 'bow' });
  });

  it('says bare hands for no weapon', () => {
    const s = buildState(snap(20, [], { weapon: null }), 16) as { self: { weapon: string } };
    expect(s.self.weapon).toBe('bare hands');
  });

  it('flags neutral mobs and leaves out non-hostiles and far threats', () => {
    const s = buildState(
      snap(20, [
        mob(1, 3, { kind: 'enderman' }),
        mob(2, 3, { category: 'passive', kind: 'cow' }),
        mob(3, 40),
      ]),
      16,
    ) as { threats: Array<Record<string, unknown>> };
    expect(s.threats).toHaveLength(1);
    expect(s.threats[0]).toMatchObject({ kind: 'enderman', neutral_until_attacked: true });
  });

  it('describes at most a handful of threats, nearest first', () => {
    const many = Array.from({ length: 12 }, (_, i) => mob(i + 1, 2 + i));
    const threats = relevantThreats(snap(20, many), 30);
    expect(threats).toHaveLength(MAX_THREATS_IN_STATE);
    expect(threats.map((t) => t.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

interface ChoiceShape {
  type: string;
  instructions: string;
  criteria: Record<string, string>;
}
interface ScoreShape {
  type: string;
  instructions: string;
  criteria: string[];
}
interface NoulShape {
  type: string;
  instructions: string;
}

describe('buildQuestions', () => {
  const q = buildQuestions(
    snap(20, [mob(5, 4), mob(9, 8, { kind: 'creeper' })]),
    16,
  ) as unknown as {
    tactic: ChoiceShape;
    target: ChoiceShape;
    threat_level: ScoreShape;
    ambush: NoulShape;
  };

  it('asks the four questions of the plan', () => {
    expect(Object.keys(q)).toEqual(['tactic', 'target', 'threat_level', 'ambush']);
    expect(q.tactic.type).toBe('choice');
    expect(q.target.type).toBe('choice');
    expect(q.threat_level.type).toBe('score');
    expect(q.ambush.type).toBe('noul');
  });

  it('offers only tactics the bot can carry out', () => {
    expect(Object.keys(q.tactic.criteria)).toEqual(['engage', 'retreat', 'ignore']);
  });

  it('lets Jev pick among the described threats, or none', () => {
    expect(Object.keys(q.target.criteria)).toEqual([NO_TARGET, 't5', 't9']);
    expect(q.target.criteria.t9).toBe('creeper, 8 blocks ahead');
  });

  it('has a four-level danger rubric', () => {
    expect(q.threat_level.criteria).toHaveLength(4);
  });

  it('gives every question complete instructions that refer to the state', () => {
    for (const question of Object.values(q)) {
      expect(question.instructions.length).toBeGreaterThan(30);
    }
  });

  it('has a version to record with every decision', () => {
    expect(QUESTION_SET_VERSION).toMatch(/^v\d+$/);
  });
});

describe('parseJudgment', () => {
  const good = (): Record<string, JevAnswer> => ({
    tactic: {
      type: 'choice',
      choice: 'engage',
      confidence: 0.8,
      probabilities: { engage: 0.8, retreat: 0.15, ignore: 0.05 },
    } as JevAnswer,
    target: {
      type: 'choice',
      choice: 't5',
      confidence: 0.7,
      probabilities: { none: 0.1, t5: 0.7, t9: 0.2 },
    } as JevAnswer,
    threat_level: {
      type: 'score',
      score: 1.4,
      confidence: 0.6,
      legend: {},
      probabilities: {},
    } as JevAnswer,
    ambush: { type: 'noul', noul: 0.2 },
  });

  it('reads a complete answer set', () => {
    expect(parseJudgment(good())).toEqual({
      tactic: { label: 'engage', confidence: 0.8 },
      target: { id: 5, confidence: 0.7 },
      threatLevel: { score: 1.4, confidence: 0.6 },
      ambush: 0.2,
    });
  });

  it('reads "none" as no target', () => {
    const a = good();
    (a.target as unknown as { choice: string }).choice = NO_TARGET;
    expect(parseJudgment(a)?.target.id).toBeNull();
  });

  type Rec = Record<string, unknown>;
  type Loose = { tactic: Rec; target: Rec; threat_level: Rec; ambush?: Rec };
  it.each([
    ['a missing answer', (a: Loose) => delete a.ambush],
    ['an answer of the wrong type', (a: Loose) => (a.tactic = { type: 'noul', noul: 0.5 })],
    ['a tactic that was not offered', (a: Loose) => (a.tactic.choice = 'dance')],
    ['a malformed target label', (a: Loose) => (a.target.choice = 'zombie-5')],
    ['a NaN confidence', (a: Loose) => (a.tactic.confidence = Number.NaN)],
    ['a non-numeric score', (a: Loose) => (a.threat_level.score = 'high')],
    ['an infinite noul', (a: Loose) => (a.ambush!.noul = Infinity)],
  ])('rejects %s', (_name, damage) => {
    const a = good();
    damage(a as unknown as Loose);
    expect(parseJudgment(a)).toBeNull();
  });
});
