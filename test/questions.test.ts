import { describe, expect, it } from 'vitest';
import type { JevAnswer } from '../src/strategic/jev.js';
import {
  MAX_PLAYERS_IN_STATE,
  MAX_THREATS_IN_STATE,
  NO_TARGET,
  QUESTION_SET_VERSION,
  buildQuestions,
  buildState,
  parseJudgment,
  relevantThreats,
} from '../src/strategic/questions.js';
import { mob, snap } from './fixtures.js';
import { answers } from './jevFixtures.js';

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
      shield: false,
      bow: false,
      arrows: 0,
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
      players: [],
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

describe('players in the state and questions', () => {
  const playerRules = { pvp: true, protectedPlayers: ['Boss'] };
  const player = (id: number, name: string, dist: number, over = {}) =>
    mob(id, dist, { category: 'player', kind: name, held: 'iron_sword', provoked: false, ...over });
  const s = snap(20, [
    player(11, 'Stranger', 6, { approaching: true }),
    player(12, 'Boss', 4),
    player(13, 'Rival', 5, { provoked: true }),
    mob(1, 9),
  ]);
  const state = buildState(s, 16, playerRules) as {
    players: Array<Record<string, unknown>>;
    threats: Array<Record<string, unknown>>;
  };

  it('describes strangers to Jev, but not protected or already-hostile players', () => {
    expect(state.players).toEqual([
      {
        id: 'p11',
        name: 'Stranger',
        distance_blocks: 6,
        direction: 'ahead',
        approaching: true,
        holding: 'iron_sword',
      },
    ]);
  });

  it('counts a player who attacked the bot as a threat, and never a protected one', () => {
    expect(state.threats.map((t) => t.id)).toEqual(['t13', 't1']); // nearest first
  });

  it('asks one hostility question per stranger, and none when pvp is off', () => {
    const q = buildQuestions(s, 16, playerRules);
    expect(Object.keys(q)).toContain('hostile_p11');
    expect(Object.keys(q)).not.toContain('hostile_p12');
    expect(Object.keys(q)).not.toContain('hostile_p13');
    expect(q.hostile_p11).toMatchObject({ type: 'noul' });
    const off = buildQuestions(s, 16, { pvp: false });
    expect(Object.keys(off)).toEqual(['tactic', 'target', 'threat_level', 'ambush']);
    expect((buildState(s, 16, { pvp: false }) as { players: unknown[] }).players).toEqual([]);
  });

  it('describes at most a few strangers', () => {
    const crowd = Array.from({ length: 8 }, (_, i) => player(20 + i, `P${i}`, 3 + i));
    const st = buildState(snap(20, crowd), 30, playerRules) as { players: unknown[] };
    expect(st.players).toHaveLength(MAX_PLAYERS_IN_STATE);
  });

  it('reads the hostility answers, ignoring malformed ones', () => {
    const a = {
      ...answers({ players: { 11: 0.9 } }),
      hostile_pabc: { type: 'noul', noul: 0.9 },
      hostile_p12: { type: 'choice', choice: 'x', confidence: 1, probabilities: {} },
      hostile_p13: { type: 'noul', noul: Number.NaN },
    } as unknown as Record<string, JevAnswer>;
    expect(parseJudgment(a)?.players).toEqual([{ id: 11, hostile: 0.9 }]);
  });
});

describe('squad in the state and questions', () => {
  const squad = {
    allies: [{ name: 'Bravo', role: 'fighter', hp: 12, distance_blocks: 6.5 }],
    claims: [{ target: 't5', by: 'Bravo' }],
    focus: 't6',
  };
  const s = snap(20, [mob(5, 4), mob(6, 8)]);

  it('adds the squad to the state only when the bot is in one', () => {
    expect(buildState(s, 16, undefined, squad)).toMatchObject({ squad });
    expect(buildState(s, 16)).not.toHaveProperty('squad');
    expect(buildState(s, 16, undefined, null)).not.toHaveProperty('squad');
  });

  it('tells Jev to spread out and follow the focus, but only for squad members', () => {
    const withSquad = buildQuestions(s, 16, undefined, squad) as unknown as {
      target: { instructions: string };
    };
    expect(withSquad.target.instructions).toContain('squad.claims');
    expect(withSquad.target.instructions).toContain('squad.focus');
    const alone = buildQuestions(s, 16) as unknown as { target: { instructions: string } };
    expect(alone.target.instructions).not.toContain('squad');
  });

  it('is version v5', () => {
    expect(QUESTION_SET_VERSION).toBe('v5');
  });
});

describe('plain facts about each threat', () => {
  const state = buildState(
    snap(20, [
      mob(1, 4, { kind: 'zombie' }),
      mob(2, 5, { kind: 'skeleton' }),
      mob(3, 6, { kind: 'creeper' }),
      mob(4, 7, { kind: 'ravager' }),
      mob(5, 8, { kind: 'never_heard_of_it' }),
    ]),
    16,
  ) as { threats: Array<{ id: string; max_health: number; attack_style: string }> };
  const byId = Object.fromEntries(state.threats.map((t) => [t.id, t]));

  it('gives Jev each mob’s health and how it attacks, for mobs it may not know well', () => {
    expect(byId.t1).toMatchObject({ max_health: 20, attack_style: 'melee' });
    expect(byId.t2).toMatchObject({ max_health: 20, attack_style: 'ranged' });
    expect(byId.t3).toMatchObject({ max_health: 20, attack_style: 'explodes' });
    expect(byId.t4).toMatchObject({ max_health: 100, attack_style: 'melee' });
  });

  it('falls back to a zombie-like default for a mob it has no numbers for', () => {
    expect(byId.t5).toMatchObject({ max_health: 20, attack_style: 'melee' });
  });

  it('describes a player as 20 HP and melee', () => {
    const s = buildState(
      snap(20, [mob(9, 5, { category: 'player', kind: 'Rival', provoked: true })]),
      16,
      {
        pvp: true,
      },
    ) as { threats: Array<{ max_health: number; attack_style: string }> };
    expect(s.threats[0]).toMatchObject({ max_health: 20, attack_style: 'melee' });
  });
});

describe('bow in the state', () => {
  it('tells Jev whether the bot has a bow and how many arrows', () => {
    const s = snap(20, []);
    const armed = { ...s, inventory: ['bowx1', 'arrowx12', 'spectral_arrowx3', 'iron_swordx1'] };
    expect(buildState(armed, 16)).toMatchObject({ self: { bow: true, arrows: 15 } });
    expect(buildState(s, 16)).toMatchObject({ self: { bow: false, arrows: 0 } });
  });
});
