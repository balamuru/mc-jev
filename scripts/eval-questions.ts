/**
 * Evaluate the Jev question set on labeled situations, with the real API (costs a fraction of a cent).
 *
 *   npm run eval:jev
 *
 * Each case is a situation with an expectation about how a sensible judge would answer. The
 * report shows Jev's actual answers and which expectations held. Rerun it after changing a
 * question in src/strategic/questions.ts, to see whether the change helped.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import type { Snapshot } from '../src/perception/types.js';
import { JevGateway } from '../src/strategic/gateway.js';
import { createJevClient } from '../src/strategic/jev.js';
import {
  QUESTION_SET_VERSION,
  buildQuestions,
  buildState,
  parseJudgment,
  type Judgment,
} from '../src/strategic/questions.js';
import type { SwarmContext } from '../src/swarm/member.js';
import { mob, snap } from '../test/fixtures.js';

loadEnv({ quiet: true });

interface Case {
  id: string;
  description: string;
  snapshot: Snapshot;
  squad?: SwarmContext;
  /** Return null if the answer is sensible, or a reason it is not. Omit to just record the answer. */
  expect?: (j: Judgment) => string | null;
}

const BARE = { armor: [], weapon: null };
const zombies = (n: number, dist = 4) =>
  Array.from({ length: n }, (_, i) =>
    mob(i + 1, dist + i * 0.3, {
      bearing: (['ahead', 'left', 'right', 'behind'] as const)[i % 4]!,
    }),
  );
const stranger = (over = {}) =>
  mob(70, 5, {
    category: 'player',
    kind: 'Stranger',
    held: 'iron_sword',
    approaching: true,
    provoked: false,
    ...over,
  });

const CASES: Case[] = [
  {
    id: 'easy-fight',
    description: 'full HP, iron gear, one zombie',
    snapshot: snap(20, [mob(1, 6)]),
    expect: (j) =>
      j.tactic.label === 'retreat'
        ? 'wanted engage or ignore, got retreat'
        : j.threatLevel.score > 1.8
          ? `threat ${j.threatLevel.score.toFixed(1)} is too high`
          : null,
  },
  {
    id: 'hopeless-fight',
    description: '3 HP, no gear, four zombies close',
    snapshot: snap(3, zombies(4, 3), BARE),
    expect: (j) =>
      j.threatLevel.score < 2.3
        ? `threat ${j.threatLevel.score.toFixed(1)} is too low`
        : j.tactic.label !== 'retreat'
          ? `wanted retreat, got ${j.tactic.label}`
          : null,
  },
  {
    id: 'heavy-mob',
    description: 'full HP, iron gear, a ravager close',
    snapshot: snap(20, [mob(1, 5, { kind: 'ravager' })]),
    expect: (j) =>
      j.threatLevel.score < 2
        ? `threat ${j.threatLevel.score.toFixed(1)} is too low for a ravager`
        : null,
  },
  {
    id: 'distant-idle',
    description: 'full HP, iron gear, a zombie far away and not approaching',
    snapshot: snap(20, [mob(1, 15, { approaching: false })]),
    expect: (j) =>
      j.tactic.label === 'retreat'
        ? 'a far, idle zombie is no reason to flee'
        : j.threatLevel.score > 1.5
          ? `threat ${j.threatLevel.score.toFixed(1)} is too high`
          : null,
  },
  {
    id: 'low-hp-geared-single',
    description: '5 HP, iron gear, one zombie (the benchmark says fighting wins)',
    snapshot: snap(5, [mob(1, 6)]),
  },
  {
    id: 'unarmored-creeper',
    description: '8 HP, no armor, a creeper close',
    snapshot: snap(8, [mob(1, 3, { kind: 'creeper' })], BARE),
    expect: (j) =>
      j.threatLevel.score < 1.8
        ? `threat ${j.threatLevel.score.toFixed(1)} is too low for a creeper at 8 HP`
        : null,
  },
  {
    id: 'surrounded',
    description: 'full HP, iron gear, four zombies from all sides',
    snapshot: snap(20, zombies(4, 3)),
    expect: (j) => (j.ambush < 0.5 ? `ambush ${j.ambush.toFixed(2)} is too low` : null),
  },
  {
    id: 'not-surrounded',
    description: 'full HP, iron gear, one zombie ahead',
    snapshot: snap(20, [mob(1, 6)]),
    expect: (j) => (j.ambush > 0.4 ? `ambush ${j.ambush.toFixed(2)} is too high` : null),
  },
  {
    id: 'target-dangerous-near',
    description: 'a creeper close and a zombie farther away',
    snapshot: snap(20, [mob(1, 10), mob(2, 4, { kind: 'creeper' })]),
    expect: (j) =>
      j.target.id !== 2
        ? `wanted the close creeper (t2), got ${j.target.id === null ? 'none' : `t${j.target.id}`}`
        : null,
  },
  {
    id: 'target-avoids-claimed',
    description: 'two zombies, the nearer one already claimed by an ally',
    snapshot: snap(20, [mob(1, 4), mob(2, 7)]),
    squad: {
      allies: [{ name: 'Bravo', role: 'fighter', hp: 18, distance_blocks: 5 }],
      claims: [{ target: 't1', by: 'Bravo' }],
      focus: null,
    },
    expect: (j) =>
      j.target.id !== 2
        ? `wanted the unclaimed zombie (t2), got ${j.target.id === null ? 'none' : `t${j.target.id}`}`
        : null,
  },
  {
    id: 'target-follows-focus',
    description: 'two zombies, the squad focus set on the farther one',
    snapshot: snap(20, [mob(1, 4), mob(2, 7)]),
    squad: {
      allies: [{ name: 'Bravo', role: 'fighter', hp: 18, distance_blocks: 5 }],
      claims: [],
      focus: 't2',
    },
    expect: (j) =>
      j.target.id !== 2
        ? `wanted the focus target (t2), got ${j.target.id === null ? 'none' : `t${j.target.id}`}`
        : null,
  },
  {
    id: 'hostile-player',
    description: 'an armed stranger walking straight at the bot',
    snapshot: snap(20, [stranger()]),
    expect: (j) => {
      const p = j.players.find((x) => x.id === 70);
      return !p
        ? 'no answer about the player'
        : p.hostile < 0.5
          ? `hostility ${p.hostile.toFixed(2)} is too low`
          : null;
    },
  },
  {
    id: 'armed-adjacent-player',
    description: 'an armed stranger 2 blocks away, closing in',
    snapshot: snap(20, [stranger({ dist: 2, position: { x: 0, y: 64, z: -2 } })]),
  },
  {
    id: 'bow-player',
    description: 'a stranger with a bow, 10 blocks away, standing still',
    snapshot: snap(20, [stranger({ held: 'bow', dist: 10, approaching: false })]),
  },
  {
    id: 'armed-far-approaching',
    description: 'an armed stranger 12 blocks away, walking toward the bot',
    snapshot: snap(20, [stranger({ dist: 12 })]),
  },
  {
    id: 'passerby-player',
    description: 'an unarmed stranger far away, not approaching',
    snapshot: snap(20, [stranger({ held: null, dist: 14, approaching: false })]),
    expect: (j) => {
      const p = j.players.find((x) => x.id === 70);
      return !p
        ? 'no answer about the player'
        : p.hostile > 0.3
          ? `hostility ${p.hostile.toFixed(2)} is too high`
          : null;
    },
  },
  {
    id: 'tool-player',
    description: 'a stranger holding a pickaxe, passing at a distance',
    snapshot: snap(20, [stranger({ held: 'iron_pickaxe', dist: 9, approaching: false })]),
    expect: (j) => {
      const p = j.players.find((x) => x.id === 70);
      return !p
        ? 'no answer about the player'
        : p.hostile > 0.4
          ? `hostility ${p.hostile.toFixed(2)} is too high for a miner`
          : null;
    },
  },
];

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.log('No TYPESAFE_API_KEY in the environment or .env; nothing to evaluate.');
    return;
  }
  const gateway = new JevGateway({
    client: createJevClient({ apiKey, baseURL: process.env.TYPESAFE_BASE_URL || undefined }),
    limits: { maxCallsPerMinute: 60, dailyBudgetUsd: 0.05 },
  });
  const rules = { pvp: true, protectedPlayers: [] as string[] };

  console.log(`question set ${QUESTION_SET_VERSION}, ${CASES.length} cases\n`);
  const results: Array<Record<string, unknown>> = [];
  let passed = 0;
  let judged = 0;
  for (const c of CASES) {
    const out = await gateway.ask(
      'eval',
      {
        model: process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest',
        state: buildState(c.snapshot, 24, rules, c.squad),
        questions: buildQuestions(c.snapshot, 24, rules, c.squad),
      },
      { timeoutMs: 15_000, maxRetries: 1 },
    );
    if (!out.ok) {
      console.log(`${c.id}: FAILED to get an answer (${out.reason})`);
      results.push({ id: c.id, error: out.reason });
      continue;
    }
    const j = parseJudgment(out.response.answers);
    if (!j) {
      console.log(`${c.id}: unusable answer`);
      results.push({ id: c.id, error: 'unparseable' });
      continue;
    }
    const verdict = c.expect ? c.expect(j) : undefined;
    if (c.expect) {
      judged++;
      if (verdict === null) passed++;
    }
    const players = j.players.map((p) => `p${p.id} ${p.hostile.toFixed(2)}`).join(', ');
    console.log(
      `${verdict === undefined ? 'info' : verdict === null ? ' ok ' : 'FAIL'}  ${c.id.padEnd(24)} ` +
        `${j.tactic.label} ${j.tactic.confidence.toFixed(2)} | target ${j.target.id === null ? 'none' : `t${j.target.id}`} | ` +
        `threat ${j.threatLevel.score.toFixed(1)} | ambush ${j.ambush.toFixed(2)}${players ? ` | ${players}` : ''}` +
        `${verdict ? `\n      -> ${verdict}` : ''}`,
    );
    results.push({
      id: c.id,
      description: c.description,
      judgment: j,
      verdict: verdict ?? null,
      latencyMs: out.latencyMs,
    });
  }
  const stats = gateway.stats();
  console.log(
    `\n${passed}/${judged} expectations held; ${stats.calls} calls, $${stats.costUsd.toFixed(6)}`,
  );

  mkdirSync('logs', { recursive: true });
  const file = `logs/eval-${QUESTION_SET_VERSION}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(
    file,
    JSON.stringify(
      { questionSet: QUESTION_SET_VERSION, passed, judged, costUsd: stats.costUsd, results },
      null,
      2,
    ),
  );
  console.log(`saved ${file}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
