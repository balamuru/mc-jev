import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { BotAgent } from '../../src/agent/BotAgent.js';
import { parseConfig } from '../../src/config.js';
import { JevGateway } from '../../src/strategic/gateway.js';
import { JevError, type JevAnswer } from '../../src/strategic/jev.js';
import type { DecisionEntry } from '../../src/telemetry/decisionLog.js';
import { answers, scriptedClient } from '../jevFixtures.js';
import { botDefaults, botName, calmNight, waitFor } from './helpers.js';
import { type TestServer, startTestServer } from './serverHarness.js';

// Jev is scripted here (no network, no cost): the point is the wiring inside a real game, not the model.
const base = parseConfig(JSON.parse(readFileSync('config/default.json', 'utf8')));

let server: TestServer;
let name: string;
let agent: BotAgent;
let script: () => Record<string, JevAnswer> | Error = () => answers();
const entries: DecisionEntry[] = [];
const logs: string[] = [];

const hostiles = () => agent.snapshot()?.entities.filter((e) => e.category === 'hostile') ?? [];

beforeAll(async () => {
  server = await startTestServer(25597);
  await calmNight(server);
  name = botName('Jev');
  const { client } = scriptedClient(() => script());
  const gateway = new JevGateway({
    client,
    limits: { maxCallsPerMinute: 600, dailyBudgetUsd: 1 },
  });
  agent = new BotAgent(
    { ...base.bots[0]!, username: name, rules: { ...botDefaults.rules, retreat: true } },
    { host: server.host, port: server.port, version: false },
    {
      gateway,
      decisions: { write: (e) => void entries.push(e) },
      logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    },
  );
  agent.start();
  await waitFor(() => agent.state === 'online', 60_000, 'the bot to spawn');
  await server.run(`give ${name} iron_sword`, 150);
  for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
    await server.run(`give ${name} iron_${piece}`, 150);
  }
  await waitFor(() => agent.snapshot()?.self.armor.length === 4, 10_000, 'armor to be worn');
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await server?.stop();
});

const dump = () => onTestFailed(() => console.log(`--- bot log ---\n${logs.join('\n')}`));

describe('Jev decisions in a real game', () => {
  it('follows a confident Jev retreat even though the rules would fight', async () => {
    dump();
    script = () => answers({ tactic: 'retreat', tacticConfidence: 0.95 });
    entries.length = 0;
    await server.run(`execute at ${name} run summon zombie ~8 ~ ~`);

    await waitFor(() => agent.intent.tactic === 'retreat', 10_000, 'the bot to retreat');
    expect(agent.intent.reason).toContain('jev: retreat');
    expect(entries[0]).toMatchObject({ outcome: 'applied', agent: name, questionSet: 'v1' });
    expect(entries[0]!.costUsd).toBeGreaterThan(0);
    await server.run('kill @e[type=zombie]');
    await waitFor(() => agent.intent.tactic === 'idle', 15_000, 'the bot to calm down');
  });

  it('follows Jev’s choice of target', async () => {
    dump();
    await server.run(`execute at ${name} run summon zombie ~8 ~ ~`, 100);
    await server.run(`execute at ${name} run summon zombie ~-8 ~ ~`, 100);
    await waitFor(() => hostiles().length === 2, 10_000, 'both zombies to be seen');
    const farther = hostiles().at(-1)!;
    script = () => answers({ tactic: 'engage', target: `t${farther.id}`, targetConfidence: 0.95 });
    entries.length = 0;

    await waitFor(
      () => entries.some((e) => e.intent?.targetId === farther.id),
      15_000,
      'Jev to pick the farther zombie',
    );
    expect(entries.find((e) => e.intent?.targetId === farther.id)).toMatchObject({
      outcome: 'applied',
    });
    await server.run('kill @e[type=zombie]');
    await waitFor(() => agent.intent.tactic === 'idle', 15_000, 'the bot to calm down');
  });

  it('keeps fighting by the rules when Jev fails, and records why', async () => {
    dump();
    script = () => new JevError('timeout', 'simulated outage');
    entries.length = 0;
    await server.run(`execute at ${name} run summon zombie ~6 ~ ~`);

    await waitFor(() => agent.intent.tactic === 'engage', 10_000, 'the bot to engage by the rules');
    await waitFor(() => hostiles().length === 0, 45_000, 'the zombie to die');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.outcome === 'error' && e.error === 'timeout')).toBe(true);
    expect(agent.deaths).toBe(0);
    expect(logs.filter((l) => l.includes('Jev unavailable'))).toHaveLength(1);
  });
});
