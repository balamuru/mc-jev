/**
 * Survival benchmark: runs fights on a throwaway flat-world server and reports survival rate.
 *
 *   npm run benchmark:survival -- --trials 8 --label baseline
 *
 * Options: --trials N (default 8), --scenarios a,b,c (default all), --label NAME,
 *          --timeout SECONDS per trial (default 30), --port N (default 25597),
 *          --trace to print what the bot sees and intends every second of each trial,
 *          --jev to let the bot ask Jev (needs TYPESAFE_API_KEY; costs a few cents in total),
 *          --rules JSON to override rule settings (e.g. '{"retreatHp":0,"dangerMargin":1000}'
 *          makes the bot never retreat, for comparing policies).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { JevGateway } from '../src/strategic/gateway.js';
import { createJevClient } from '../src/strategic/jev.js';
import { formatSummary, summarize } from '../src/telemetry/analyze.js';
import { formatSnapshot } from '../src/perception/format.js';
import { JsonlDecisionLog, type DecisionEntry } from '../src/telemetry/decisionLog.js';
import { makeAgent, sleep, waitFor, type TestAgent } from '../test/integration/helpers.js';
import { startTestServer, type TestServer } from '../test/integration/serverHarness.js';

type Gear = 'iron' | 'wood' | 'none' | 'iron-shield' | 'wood-shield' | 'iron-bow' | 'wood-bow';

interface Scenario {
  id: string;
  description: string;
  mobs: Array<{ type: string; count: number; nbt?: string }>;
  startHp: number;
  gear: Gear;
  /** How far away the mobs are summoned (default 8 blocks). */
  spawnDistance?: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'zombie-lowhp',
    description: '1 zombie, bot at 6 HP, iron gear',
    mobs: [{ type: 'zombie', count: 1 }],
    startHp: 6,
    gear: 'iron',
  },
  {
    id: 'zombie-x3',
    description: '3 zombies, full HP, iron gear',
    mobs: [{ type: 'zombie', count: 3 }],
    startHp: 20,
    gear: 'iron',
  },
  {
    id: 'zombie-x2-weak',
    description: '2 zombies, full HP, wooden sword, no armor',
    mobs: [{ type: 'zombie', count: 2 }],
    startHp: 20,
    gear: 'wood',
  },
  {
    id: 'zombie-x3-lowhp',
    description: '3 zombies, bot at 6 HP, iron gear',
    mobs: [{ type: 'zombie', count: 3 }],
    startHp: 6,
    gear: 'iron',
  },
  {
    id: 'skeleton-lowhp',
    description: '1 skeleton, bot at 6 HP, iron gear',
    mobs: [{ type: 'skeleton', count: 1 }],
    startHp: 6,
    gear: 'iron',
  },
  {
    id: 'skeleton-shield',
    description: '1 skeleton, bot at 10 HP, iron gear and a shield',
    mobs: [{ type: 'skeleton', count: 1 }],
    startHp: 10,
    gear: 'iron-shield',
  },
  {
    id: 'zombie-x3-lowhp-shield',
    description: '3 zombies, bot at 6 HP, iron gear and a shield',
    mobs: [{ type: 'zombie', count: 3 }],
    startHp: 6,
    gear: 'iron-shield',
  },
  {
    id: 'creeper-shield',
    description: '1 creeper, full HP, wooden sword and a shield, no armor',
    mobs: [{ type: 'creeper', count: 1 }],
    startHp: 20,
    gear: 'wood-shield',
  },
  {
    id: 'creeper-far',
    description: '1 creeper 16 blocks away, full HP, wooden sword, no armor',
    mobs: [{ type: 'creeper', count: 1 }],
    startHp: 20,
    gear: 'wood',
    spawnDistance: 16,
  },
  {
    id: 'creeper-bow',
    description: '1 creeper 16 blocks away, full HP, wooden sword and a bow, no armor',
    mobs: [{ type: 'creeper', count: 1 }],
    startHp: 20,
    gear: 'wood-bow',
    spawnDistance: 16,
  },
  {
    id: 'skeleton-bow',
    description: '1 skeleton 16 blocks away, bot at 10 HP, iron gear and a bow',
    mobs: [{ type: 'skeleton', count: 1 }],
    startHp: 10,
    gear: 'iron-bow',
    spawnDistance: 16,
  },
  {
    id: 'zombie-x3-bow',
    description: '3 zombies 16 blocks away, bot at 6 HP, iron gear and a bow',
    mobs: [{ type: 'zombie', count: 3 }],
    startHp: 6,
    gear: 'iron-bow',
    spawnDistance: 16,
  },
  {
    id: 'baby-zombie',
    description: '1 baby zombie, bot at 10 HP, iron gear',
    mobs: [{ type: 'zombie', count: 1, nbt: '{IsBaby:1b}' }],
    startHp: 10,
    gear: 'iron',
  },
  {
    id: 'spider',
    description: '1 spider, bot at 10 HP, iron gear',
    mobs: [{ type: 'spider', count: 1 }],
    startHp: 10,
    gear: 'iron',
  },
  {
    id: 'skeleton',
    description: '1 skeleton, bot at 10 HP, iron gear',
    mobs: [{ type: 'skeleton', count: 1 }],
    startHp: 10,
    gear: 'iron',
  },
  {
    id: 'creeper',
    description: '1 creeper, full HP, no armor',
    mobs: [{ type: 'creeper', count: 1 }],
    startHp: 20,
    gear: 'wood',
  },
];

const GEAR: Record<Gear, string[]> = {
  iron: ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'],
  wood: ['wooden_sword'],
  none: [],
  'iron-shield': [
    'iron_sword',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
    'shield',
  ],
  'wood-shield': ['wooden_sword', 'shield'],
  'iron-bow': [
    'iron_sword',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
    'bow',
    'arrow 64',
  ],
  'wood-bow': ['wooden_sword', 'bow', 'arrow 64'],
};

interface TrialResult {
  outcome: 'won' | 'timeout' | 'died';
  seconds: number;
  endHp: number;
  /** Arrows shot and hits that followed, when the bot used a bow. */
  shots?: number;
  hits?: number;
}

function parseArgs(argv: string[]) {
  const get = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    trials: Number(get('trials', '8')),
    scenarios: get('scenarios', '').split(',').filter(Boolean),
    label: get('label', 'run'),
    timeoutMs: Number(get('timeout', '30')) * 1000,
    port: Number(get('port', '25597')),
    rules: JSON.parse(get('rules', '{}')) as Record<string, number | boolean>,
    jev: argv.includes('--jev'),
    trace: argv.includes('--trace'),
  };
}

async function resetBot(server: TestServer, bot: TestAgent, sc: Scenario, name: string) {
  const { agent } = bot;
  await waitFor(() => agent.state === 'online' && agent.snapshot(), 30_000, 'the bot to be online');
  await server.run('kill @e[type=!player]', 150);
  await server.run(`clear ${name}`, 150);
  await server.run(`effect clear ${name}`, 100);
  await server.run(`tp ${name} 0 -60 0`, 200);
  const armorCount = GEAR[sc.gear].filter((g) =>
    /_(helmet|chestplate|leggings|boots)$/.test(g),
  ).length;
  const wantsShield = GEAR[sc.gear].includes('shield');
  for (const item of GEAR[sc.gear]) await server.run(`give ${name} ${item}`, 100);
  await waitFor(
    () =>
      agent.snapshot()?.self.armor.length === armorCount &&
      (!wantsShield || agent.snapshot()?.self.offhand === 'shield'),
    8_000,
    'armor to be worn',
  );
  await server.run(`effect give ${name} minecraft:instant_health 1 10 true`, 150);
  await server.run(`effect give ${name} minecraft:saturation 5 10 true`, 150);
  await waitFor(() => (agent.snapshot()?.self.hp ?? 0) >= 20, 8_000, 'full HP');
  for (let i = 0; i < 20 && (agent.snapshot()?.self.hp ?? 0) > sc.startHp; i++) {
    await server.run(`damage ${name} 2 minecraft:magic`, 200);
  }
  await waitFor(() => agent.intent.tactic === 'idle', 5_000, 'an idle bot');
}

async function anyAlive(server: TestServer, types: string[]): Promise<boolean> {
  for (const t of types) {
    const out = await server.run(`execute if entity @e[type=${t}]`, 200);
    if (/Test passed/.test(out)) return true;
  }
  return false;
}

async function runTrial(
  server: TestServer,
  bot: TestAgent,
  sc: Scenario,
  name: string,
  timeoutMs: number,
  trace = false,
): Promise<TrialResult> {
  await resetBot(server, bot, sc, name);
  const { agent } = bot;
  const deathsBefore = agent.deaths;
  const bowBefore = agent.bowStats;
  const withBow = (r: TrialResult): TrialResult => {
    const b = agent.bowStats;
    const shots = b.shots - bowBefore.shots;
    return shots > 0 ? { ...r, shots, hits: b.hits - bowBefore.hits } : r;
  };
  const total = sc.mobs.reduce((n, m) => n + m.count, 0);
  let k = 0;
  for (const m of sc.mobs) {
    for (let i = 0; i < m.count; i++, k++) {
      const angle = (2 * Math.PI * k) / total;
      const r = sc.spawnDistance ?? 8;
      const dx = Math.round(r * Math.cos(angle));
      const dz = Math.round(r * Math.sin(angle));
      await server.run(
        `execute at ${name} run summon ${m.type} ~${dx} ~ ~${dz} ${m.nbt ?? ''}`,
        100,
      );
    }
  }
  const types = [...new Set(sc.mobs.map((m) => m.type))];
  const start = Date.now();
  let lastCheck = 0;
  for (;;) {
    const seconds = (Date.now() - start) / 1000;
    if (agent.deaths > deathsBefore) return withBow({ outcome: 'died', seconds, endHp: 0 });
    if (Date.now() - start > timeoutMs) {
      return withBow({ outcome: 'timeout', seconds, endHp: agent.snapshot()?.self.hp ?? 0 });
    }
    if (Date.now() - lastCheck > 1000) {
      lastCheck = Date.now();
      if (trace) {
        const snap = agent.snapshot();
        console.log(
          `    ${seconds.toFixed(0)}s ${agent.intent.tactic} (${agent.intent.reason}) | ${snap ? formatSnapshot(snap) : 'no snapshot'}`,
        );
      }
      if (!(await anyAlive(server, types))) {
        return withBow({ outcome: 'won', seconds, endHp: agent.snapshot()?.self.hp ?? 0 });
      }
    }
    await sleep(100);
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (n: number, d = 1) => (Number.isNaN(n) ? '-' : n.toFixed(d));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chosen = args.scenarios.length
    ? SCENARIOS.filter((s) => args.scenarios.includes(s.id))
    : SCENARIOS;
  if (!chosen.length)
    throw new Error(`No matching scenarios. Available: ${SCENARIOS.map((s) => s.id).join(', ')}`);

  console.log(
    `survival benchmark "${args.label}": ${chosen.length} scenarios x ${args.trials} trials`,
  );
  const server = await startTestServer(args.port);
  const name = `Bench${Math.random().toString(36).slice(2, 6)}`;
  const template = makeAgent(server, name).agent.config;

  // With --jev the bot asks the real API; every decision is kept so it can be analysed afterwards.
  loadEnv({ quiet: true });
  const collected: DecisionEntry[] = [];
  let gateway: JevGateway | undefined;
  if (args.jev) {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error('--jev needs TYPESAFE_API_KEY (in .env or the environment)');
    gateway = new JevGateway({
      client: createJevClient({ apiKey, baseURL: process.env.TYPESAFE_BASE_URL || undefined }),
      limits: { maxCallsPerMinute: 600, dailyBudgetUsd: 0.5 },
    });
  }
  const decisionFile = new JsonlDecisionLog(`logs/bench-${args.label}`);
  const bot = makeAgent(
    server,
    name,
    { rules: { ...template.rules, ...args.rules } },
    {
      gateway,
      decisions: {
        write: (e) => {
          collected.push(e);
          decisionFile.write(e);
        },
      },
    },
  );
  const results: Record<string, TrialResult[]> = {};
  try {
    await server.run('gamerule advance_time false');
    await server.run('time set night');
    await server.run('gamerule keep_inventory true');
    // Make starting HP a controlled variable: no natural healing while a trial runs.
    console.log(
      (await server.run('gamerule natural_health_regeneration false')).trim().split('\n').pop(),
    );
    // No craters: explosions over many trials would otherwise trap the bot or the mob in a pit.
    await server.run('gamerule mob_griefing false');
    // No natural spawns (slimes appeared mid-trial on the flat world without this).
    await server.run('gamerule spawn_mobs false');
    bot.agent.start();
    await waitFor(() => bot.agent.state === 'online', 60_000, 'the bot to spawn');

    for (const sc of chosen) {
      results[sc.id] = [];
      for (let t = 0; t < args.trials; t++) {
        try {
          const r = await runTrial(server, bot, sc, name, args.timeoutMs, args.trace);
          results[sc.id]!.push(r);
          console.log(`  ${sc.id} #${t + 1}: ${r.outcome} in ${fmt(r.seconds)}s, HP ${r.endHp}`);
        } catch (err) {
          console.log(`  ${sc.id} #${t + 1}: trial error (${(err as Error).message}), skipped`);
        }
      }
    }
  } finally {
    bot.agent.stop();
    await server.stop();
  }

  const rows = chosen.map((sc) => {
    const rs = results[sc.id] ?? [];
    const died = rs.filter((r) => r.outcome === 'died');
    const alive = rs.filter((r) => r.outcome !== 'died');
    return {
      id: sc.id,
      description: sc.description,
      trials: rs.length,
      survived: alive.length,
      won: rs.filter((r) => r.outcome === 'won').length,
      survivalRate: rs.length ? alive.length / rs.length : NaN,
      meanSecondsToDeath: mean(died.map((r) => r.seconds)),
      meanEndHp: mean(alive.map((r) => r.endHp)),
      shots: rs.reduce((n, r) => n + (r.shots ?? 0), 0),
      hits: rs.reduce((n, r) => n + (r.hits ?? 0), 0),
    };
  });

  console.log(
    '\n| Scenario | Trials | Survived | Won | Survival | Mean s to death | Mean end HP | Arrow hits |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    console.log(
      `| ${r.id} | ${r.trials} | ${r.survived} | ${r.won} | ${fmt(r.survivalRate * 100, 0)}% | ${fmt(r.meanSecondsToDeath)} | ${fmt(r.meanEndHp)} | ${r.shots ? `${r.hits}/${r.shots}` : '-'} |`,
    );
  }

  mkdirSync('logs', { recursive: true });
  const file = `logs/survival-${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(file, JSON.stringify({ label: args.label, args, rows, results }, null, 2));
  console.log(`\nfull results: ${file}`);
  if (gateway) {
    const g = gateway.stats();
    console.log(
      `\nJev: ${g.calls} calls, ${g.failures} failed, $${g.costUsd.toFixed(5)}\n${formatSummary(summarize(collected))}`,
    );
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
