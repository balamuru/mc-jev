import { readFileSync } from 'node:fs';
import { createBot, type Bot } from 'mineflayer';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import type { BotAgent } from '../../src/agent/BotAgent.js';
import { buildApp, type App } from '../../src/app.js';
import { parseConfig } from '../../src/config.js';
import { botName, calmNight, sleep, waitFor } from './helpers.js';
import { type TestServer, startTestServer } from './serverHarness.js';

/**
 * Two bots from two separate apps, as if two people each ran their own: neither protects the
 * other. Each has an owner standing nearby, who must never be hurt.
 */
let server: TestServer;
const apps: App[] = [];
const owners: Bot[] = [];
const logs: string[] = [];
let nameA = '';
let nameB = '';
let ownerA = '';
let ownerB = '';

const agentA = (): BotAgent => apps[0]!.agents[0]!;
const agentB = (): BotAgent => apps[1]!.agents[0]!;
const targetName = (agent: BotAgent) => {
  const intent = agent.intent;
  if (intent.tactic !== 'engage') return null;
  return agent.snapshot()?.entities.find((e) => e.id === intent.targetId)?.kind ?? null;
};

function app(username: string, owner: string): App {
  const raw = JSON.parse(readFileSync('config/default.json', 'utf8'));
  raw.server = { host: server.host, port: server.port, version: false, staggerMs: 0 };
  raw.swarm.mode = 'independent';
  raw.debug = { snapshotIntervalMs: 0, decisionLogDir: '' };
  raw.gateway.dailyBudgetUsd = 0;
  raw.bots = [{ username, owner }];
  return buildApp(parseConfig(raw, {}), {
    jevClient: null,
    log: {
      info: (m) => logs.push(`[${username}] ${m}`),
      warn: (m) => logs.push(`[${username}] ${m}`),
      error: (m) => logs.push(`[${username}] ${m}`),
    },
  });
}

const spawnClient = async (username: string): Promise<Bot> => {
  const client = createBot({
    host: server.host,
    port: server.port,
    username,
    auth: 'offline',
    logErrors: false,
  });
  client.on('error', () => {});
  owners.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('spawn', () => resolve());
    client.once('end', () => reject(new Error(`${username} was disconnected`)));
  });
  return client;
};

const dump = () => onTestFailed(() => console.log(logs.join('\n')));

beforeAll(async () => {
  server = await startTestServer(25586);
  await calmNight(server);
  const suffix = botName('');
  nameA = `DuA${suffix}`;
  nameB = `DuB${suffix}`;
  ownerA = `OwA${suffix}`;
  ownerB = `OwB${suffix}`;
  apps.push(app(nameA, ownerA), app(nameB, ownerB));
  apps[0]!.start();
  await sleep(500);
  apps[1]!.start();
  await waitFor(
    () => agentA().state === 'online' && agentB().state === 'online',
    90_000,
    'both bots to spawn',
  );
  await spawnClient(ownerA);
  await spawnClient(ownerB);
  for (const name of [nameA, nameB]) {
    for (const item of [
      'iron_sword',
      'iron_helmet',
      'iron_chestplate',
      'iron_leggings',
      'iron_boots',
    ]) {
      await server.run(`give ${name} ${item}`, 100);
    }
  }
  await waitFor(
    () =>
      agentA().snapshot()?.self.armor.length === 4 && agentB().snapshot()?.self.armor.length === 4,
    15_000,
    'armor',
  );
  // The duellists 4 blocks apart, each owner 6 blocks behind their own bot.
  await server.run(`execute at ${nameA} run tp ${nameB} ~4 ~ ~`, 150);
  await server.run(`execute at ${nameA} run tp ${ownerA} ~-6 ~ ~`, 150);
  await server.run(`execute at ${nameB} run tp ${ownerB} ~6 ~ ~`, 150);
}, 240_000);

afterAll(async () => {
  owners.forEach((o) => o.quit());
  apps.forEach((a) => a.stop());
  await server?.stop();
});

describe('a bot against another bot on a real server', () => {
  it('leaves an unprovoked bot alone', async () => {
    dump();
    await sleep(3000);
    expect(agentA().intent.tactic).toBe('idle');
    expect(agentB().intent.tactic).toBe('idle');
  });

  it('fights back once provoked, both ways, until one of them dies', async () => {
    dump();
    // B "hits" A: the server names B as the attacker, as for a real blow.
    await server.run(`damage ${nameA} 1 minecraft:player_attack by ${nameB}`, 300);
    await waitFor(() => targetName(agentA()) === nameB, 10_000, 'A to fight B');
    // A's blows provoke B, which fights back.
    await waitFor(() => targetName(agentB()) === nameA, 15_000, 'B to fight back');
    await waitFor(
      () => agentA().deaths + agentB().deaths > 0,
      90_000,
      'the duel to end with a death',
    );
  });

  it('stops once the loser is gone, and never hurts either owner', async () => {
    dump();
    const [winner, loser] = agentA().deaths > 0 ? [agentB(), agentA()] : [agentA(), agentB()];
    // Keep the respawned loser out of the winner's way.
    await waitFor(() => loser.state === 'online', 30_000, 'the loser to respawn');
    await server.run(
      `execute at ${winner.config.username} run tp ${loser.config.username} ~100 ~ ~`,
      300,
    );
    await waitFor(() => winner.intent.tactic !== 'engage', 10_000, 'the winner to stop fighting');
    for (const owner of owners) expect(owner.health).toBe(20);
  });
});
