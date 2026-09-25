/**
 * Squad benchmark: three bots against a wave of mobs, in each swarm mode.
 *
 *   npm run benchmark:squad -- --trials 5 --label mine
 *
 * Options: --trials N (default 5), --modes independent,cooperative,coordinated (default all),
 *          --wave KIND:N,... (default zombie:8,skeleton:2; a plain number means that many
 *          zombies), --bows N (how many bots also get a bow and 64 arrows, default 1),
 *          --no-roles (the coordinator picks focus targets only), --jev (bots and coordinator ask
 *          the real API; needs TYPESAFE_API_KEY), --label NAME, --timeout SECONDS (default 60),
 *          --port N (default 25592).
 *
 * For each trial it reports how long the wave took to clear, how much health the squad lost in
 * total, and whether anyone died. Natural regeneration is off so damage is not healed away.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';
import { buildApp, type App } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { createJevClient } from '../src/strategic/jev.js';
import { formatSummary, summarize } from '../src/telemetry/analyze.js';
import type { DecisionEntry } from '../src/telemetry/decisionLog.js';
import { calmNight, sleep, waitFor } from '../test/integration/helpers.js';
import { startTestServer, type TestServer } from '../test/integration/serverHarness.js';

type Mode = 'independent' | 'cooperative' | 'coordinated';
const ALL_MODES: Mode[] = ['independent', 'cooperative', 'coordinated'];
const GEAR = ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];

function parseArgs(argv: string[]) {
  const get = (name: string, fallback: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  return {
    trials: Number(get('trials', '5')),
    modes: get('modes', ALL_MODES.join(',')).split(',').filter(Boolean) as Mode[],
    wave: parseWave(get('wave', 'zombie:8,skeleton:2')),
    bows: Number(get('bows', '1')),
    roles: !argv.includes('--no-roles'),
    label: get('label', 'run'),
    timeoutMs: Number(get('timeout', '60')) * 1000,
    port: Number(get('port', '25592')),
    jev: argv.includes('--jev'),
  };
}

type Wave = Array<{ kind: string; count: number }>;

function parseWave(spec: string): Wave {
  if (/^\d+$/.test(spec)) return [{ kind: 'zombie', count: Number(spec) }];
  return spec.split(',').map((part) => {
    const [kind, count] = part.split(':');
    if (!kind || !/^[a-z_]+$/.test(kind) || !/^\d+$/.test(count ?? ''))
      throw new Error(`bad --wave part "${part}": use kind:count, e.g. zombie:8`);
    return { kind, count: Number(count) };
  });
}

const describeWave = (wave: Wave) => wave.map((w) => `${w.count} ${w.kind}`).join(' + ');

interface TrialResult {
  clearSeconds: number | null;
  damageTaken: number;
  deaths: number;
  peakDistinctClaims: number;
  /** The roles in force when the wave arrived and when it ended, e.g. `A tank, B fighter`. */
  roles: string;
  /** For a wave not cleared in time: what each bot was doing and what it could see. */
  stuck?: string[];
}

/** What each bot is doing and which hostiles it sees, for explaining a wave that was not cleared. */
async function explainStuck(server: TestServer, app: App, wave: Wave): Promise<string[]> {
  const lines = app.agents.map((a) => {
    const s = a.snapshot();
    const seen = (s?.entities ?? [])
      .filter((e) => e.category === 'hostile')
      .map((e) => `${e.kind} ${e.dist}m${e.visible ? '' : ' (hidden)'}`)
      .join(', ');
    const p = s?.self.position;
    const at = p ? `at ${Math.round(p.x)}, ${Math.round(p.z)}` : 'offline';
    return `${a.config.username.slice(3, 4)} ${at}: ${a.intent.tactic} (${a.intent.reason}), hp ${s?.self.hp ?? '?'}, sees ${seen || 'nothing'}`;
  });
  for (const { kind } of wave) {
    // `data get` takes one entity at a time: read the nearest unread one, then tag it as read.
    const next = `@e[type=${kind},tag=!mcjev_seen,sort=nearest,limit=1]`;
    for (let i = 0; i < 20; i++) {
      // The console colors NBT values; strip the color codes before reading the numbers.
      const raw = await server.run(`data get entity ${next} Pos`, 200);
      // eslint-disable-next-line no-control-regex
      const out = raw.replace(/\u001b\[[\d;]*m/g, '');
      const m = /entity data: \[([-\d.]+)d, [-\d.]+d, ([-\d.]+)d\]/.exec(out);
      if (!m) break;
      lines.push(`${kind} still alive at ${Math.round(Number(m[1]))}, ${Math.round(Number(m[2]))}`);
      await server.run(`tag ${next} add mcjev_seen`, 100);
    }
  }
  return lines;
}

async function waveAlive(server: TestServer, wave: Wave): Promise<boolean> {
  for (const { kind } of wave)
    if (/Test passed/.test(await server.run(`execute if entity @e[type=${kind}]`, 200)))
      return true;
  return false;
}

const currentRoles = (app: App) =>
  app.agents
    .map(
      (a) =>
        `${a.config.username.slice(3, 4)} ${app.board.assignedRole(a.config.username) ?? a.config.role}`,
    )
    .join(', ');

async function runTrial(
  server: TestServer,
  app: App,
  wave: Wave,
  bows: number,
  timeoutMs: number,
): Promise<TrialResult> {
  const names = app.agents.map((a) => a.config.username);
  await server.run('kill @e[type=!player]', 150);
  for (const n of names) {
    await server.run(`clear ${n}`, 100);
    await server.run(`effect give ${n} minecraft:instant_health 1 10 true`, 100);
  }
  await server.run(`execute at ${names[0]} run tp ${names[1]} ~3 ~ ~`, 150);
  await server.run(`execute at ${names[0]} run tp ${names[2]} ~-3 ~ ~`, 150);
  for (const n of names) for (const item of GEAR) await server.run(`give ${n} ${item}`, 60);
  // The last bots get the bows, so the first bot (the one the wave is summoned around) fights in melee.
  for (const n of names.slice(names.length - bows)) {
    await server.run(`give ${n} bow`, 60);
    await server.run(`give ${n} arrow 64`, 60);
  }
  await waitFor(
    () => app.agents.every((a) => a.snapshot()?.self.armor.length === 4),
    15_000,
    'armor',
  );
  await waitFor(
    () => app.agents.every((a) => (a.snapshot()?.self.hp ?? 0) >= 20),
    10_000,
    'full HP',
  );
  await waitFor(() => app.agents.every((a) => a.intent.tactic === 'idle'), 10_000, 'idle bots');

  const deathsBefore = app.agents.map((a) => a.deaths);
  const hpBefore = app.agents.reduce((n, a) => n + (a.snapshot()?.self.hp ?? 0), 0);
  let peak = 0;
  const sampler = setInterval(() => {
    peak = Math.max(peak, new Set(app.board.liveClaims().map((c) => c.targetId)).size);
  }, 100);

  const kinds = wave.flatMap((w) => Array<string>(w.count).fill(w.kind));
  for (let i = 0; i < kinds.length; i++) {
    const angle = (2 * Math.PI * i) / kinds.length;
    await server.run(
      `execute at ${names[0]} run summon ${kinds[i]} ~${Math.round(8 * Math.cos(angle))} ~ ~${Math.round(8 * Math.sin(angle))}`,
      60,
    );
  }
  const start = Date.now();
  let clear: number | null = null;
  let roles = '';
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    if (!roles && Date.now() - start > 1500) roles = currentRoles(app);
    if (!(await waveAlive(server, wave))) {
      clear = (Date.now() - start) / 1000;
      break;
    }
  }
  clearInterval(sampler);
  const stuck = clear === null ? await explainStuck(server, app, wave) : undefined;
  await sleep(500);
  const deaths = app.agents.reduce((n, a, i) => n + (a.deaths - deathsBefore[i]!), 0);
  const hpAfter = app.agents.reduce((n, a) => n + (a.snapshot()?.self.hp ?? 0), 0);
  // A bot that died respawned at full health, so count a death as a full 20 HP lost.
  return {
    clearSeconds: clear,
    damageTaken: Math.max(0, hpBefore - hpAfter) + deaths * 20,
    deaths,
    peakDistinctClaims: peak,
    roles: `${roles || currentRoles(app)} -> ${currentRoles(app)}`,
    ...(stuck ? { stuck } : {}),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const fmt = (n: number, d = 1) => (Number.isNaN(n) ? '-' : n.toFixed(d));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnv({ quiet: true });
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (args.jev && !apiKey)
    throw new Error('--jev needs TYPESAFE_API_KEY (in .env or the environment)');

  console.log(
    `squad benchmark "${args.label}": ${args.modes.join(', ')} x ${args.trials} trials, wave of ${describeWave(args.wave)}, ${args.bows} bow(s)${args.roles ? '' : ', no roles'}${args.jev ? ', with Jev' : ', rules only'}`,
  );
  const server = await startTestServer(args.port);
  const results: Record<string, TrialResult[]> = {};
  const collected: DecisionEntry[] = [];
  let spent = 0;
  try {
    await calmNight(server);
    await server.run('gamerule keep_inventory true');
    for (const mode of args.modes) {
      const suffix = Math.random().toString(36).slice(2, 5);
      const raw = JSON.parse(readFileSync('config/default.json', 'utf8'));
      raw.server = { host: server.host, port: server.port, version: false, staggerMs: 300 };
      raw.swarm.mode = mode;
      raw.swarm.coordinator.assignRoles = args.roles;
      raw.debug = { snapshotIntervalMs: 0, decisionLogDir: '' };
      // Explicit, so results do not depend on the shipped defaults: three bots in a fight ask Jev
      // several times a second, and a low shared limit would starve them.
      raw.gateway.maxCallsPerMinute = 600;
      raw.gateway.dailyBudgetUsd = args.jev ? 0.5 : 0;
      raw.bots = ['A', 'B', 'C'].map((n) => ({ username: `${mode.slice(0, 3)}${n}${suffix}` }));
      const app = buildApp(parseConfig(raw, {}), {
        jevClient: args.jev
          ? createJevClient({
              apiKey: apiKey!,
              baseURL: process.env.TYPESAFE_BASE_URL || undefined,
            })
          : null,
        decisions: { write: (e) => void collected.push(e) },
        log: { info() {}, warn: (m) => console.log(`  ${m}`), error: (m) => console.log(`  ${m}`) },
      });
      app.start();
      results[mode] = [];
      try {
        await waitFor(
          () => app.agents.every((a) => a.state === 'online'),
          90_000,
          'the squad to spawn',
        );
        for (let t = 0; t < args.trials; t++) {
          const r = await runTrial(server, app, args.wave, args.bows, args.timeoutMs);
          results[mode]!.push(r);
          console.log(
            `  ${mode} #${t + 1}: ${r.clearSeconds === null ? 'NOT CLEARED' : `cleared in ${fmt(r.clearSeconds)}s`}, damage ${fmt(r.damageTaken)}, deaths ${r.deaths}, peak targets ${r.peakDistinctClaims}${mode === 'coordinated' ? `, roles ${r.roles}` : ''}`,
          );
          for (const line of r.stuck ?? []) console.log(`      ${line}`);
        }
      } finally {
        spent += app.gateway.stats().costUsd;
        app.stop();
        await sleep(1500);
      }
    }
  } finally {
    await server.stop();
  }

  console.log(
    '\n| Mode | Trials | Cleared | Mean s to clear | Mean squad damage | Deaths | Peak distinct targets |',
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  const rows = args.modes.map((mode) => {
    const rs = results[mode] ?? [];
    const cleared = rs.filter((r) => r.clearSeconds !== null);
    const row = {
      mode,
      trials: rs.length,
      cleared: cleared.length,
      meanClear: mean(cleared.map((r) => r.clearSeconds!)),
      meanDamage: mean(rs.map((r) => r.damageTaken)),
      deaths: rs.reduce((n, r) => n + r.deaths, 0),
      meanPeak: mean(rs.map((r) => r.peakDistinctClaims)),
    };
    console.log(
      `| ${mode} | ${row.trials} | ${row.cleared} | ${fmt(row.meanClear)} | ${fmt(row.meanDamage)} | ${row.deaths} | ${fmt(row.meanPeak)} |`,
    );
    return row;
  });
  if (args.jev)
    console.log(`\nJev spent $${spent.toFixed(5)}\n${formatSummary(summarize(collected))}`);

  mkdirSync('logs', { recursive: true });
  const file = `logs/squad-${args.label}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(
    file,
    JSON.stringify({ label: args.label, args, rows, results, spentUsd: spent }, null, 2),
  );
  console.log(`\nfull results: ${file}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
