/**
 * Squad benchmark: three bots against a wave of zombies, in each swarm mode.
 *
 *   npm run benchmark:squad -- --trials 5 --label mine
 *
 * Options: --trials N (default 5), --modes independent,cooperative,coordinated (default all),
 *          --wave N zombies (default 6), --jev (bots and coordinator ask the real API; needs
 *          TYPESAFE_API_KEY), --label NAME, --timeout SECONDS (default 60), --port N (default 25592).
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
    wave: Number(get('wave', '6')),
    label: get('label', 'run'),
    timeoutMs: Number(get('timeout', '60')) * 1000,
    port: Number(get('port', '25592')),
    jev: argv.includes('--jev'),
  };
}

interface TrialResult {
  clearSeconds: number | null;
  damageTaken: number;
  deaths: number;
  peakDistinctClaims: number;
}

const zombiesAlive = async (server: TestServer) =>
  /Test passed/.test(await server.run('execute if entity @e[type=zombie]', 200));

async function runTrial(
  server: TestServer,
  app: App,
  wave: number,
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

  for (let i = 0; i < wave; i++) {
    const angle = (2 * Math.PI * i) / wave;
    await server.run(
      `execute at ${names[0]} run summon zombie ~${Math.round(8 * Math.cos(angle))} ~ ~${Math.round(8 * Math.sin(angle))}`,
      60,
    );
  }
  const start = Date.now();
  let clear: number | null = null;
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    if (!(await zombiesAlive(server))) {
      clear = (Date.now() - start) / 1000;
      break;
    }
  }
  clearInterval(sampler);
  await sleep(500);
  const deaths = app.agents.reduce((n, a, i) => n + (a.deaths - deathsBefore[i]!), 0);
  const hpAfter = app.agents.reduce((n, a) => n + (a.snapshot()?.self.hp ?? 0), 0);
  // A bot that died respawned at full health, so count a death as a full 20 HP lost.
  return {
    clearSeconds: clear,
    damageTaken: Math.max(0, hpBefore - hpAfter) + deaths * 20,
    deaths,
    peakDistinctClaims: peak,
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
    `squad benchmark "${args.label}": ${args.modes.join(', ')} x ${args.trials} trials, wave of ${args.wave}${args.jev ? ', with Jev' : ', rules only'}`,
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
          const r = await runTrial(server, app, args.wave, args.timeoutMs);
          results[mode]!.push(r);
          console.log(
            `  ${mode} #${t + 1}: ${r.clearSeconds === null ? 'NOT CLEARED' : `cleared in ${fmt(r.clearSeconds)}s`}, damage ${fmt(r.damageTaken)}, deaths ${r.deaths}, peak targets ${r.peakDistinctClaims}`,
          );
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
