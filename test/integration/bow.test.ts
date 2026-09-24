import { createBot, type Bot } from 'mineflayer';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import {
  botDefaults,
  botName,
  calmNight,
  makeAgent,
  sleep,
  waitFor,
  type TestAgent,
} from './helpers.js';
import { type TestServer, startTestServer } from './serverHarness.js';

let server: TestServer;
let bot: TestAgent;
let name: string;
let ownerName: string;
let owner: Bot;

const alive = async (type: string) =>
  /Test passed/.test(await server.run(`execute if entity @e[type=${type}]`, 200));

async function killWithArrows(type: string, spawn: string, timeoutMs = 45_000) {
  const before = bot.agent.bowStats;
  await server.run(`execute at ${name} run summon ${type} ${spawn}`, 300);
  const start = Date.now();
  while ((await alive(type)) && Date.now() - start < timeoutMs) await sleep(300);
  const after = bot.agent.bowStats;
  return {
    killed: !(await alive(type)),
    shots: after.shots - before.shots,
    hits: after.hits - before.hits,
  };
}

beforeAll(async () => {
  server = await startTestServer(25590);
  await calmNight(server);
  name = botName('Arc');
  ownerName = botName('Own');
  // Targets are placed up to 20 blocks away, beyond the default engage radius of 16.
  bot = makeAgent(server, name, {
    owner: ownerName,
    rules: {
      ...botDefaults.rules,
      bow: true,
      bowMinBlocks: 6,
      bowMaxBlocks: 22,
      engageRadiusBlocks: 24,
    },
  });
  bot.agent.start();
  await waitFor(() => bot.agent.state === 'online', 60_000, 'the bot to spawn');
  for (const item of [
    'bow',
    'arrow 64',
    'iron_sword',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
  ]) {
    await server.run(`give ${name} ${item}`, 120);
  }
  await waitFor(() => bot.agent.snapshot()?.self.armor.length === 4, 10_000, 'armor');
}, 180_000);

afterEach(async () => {
  await server.run('kill @e[type=!player]', 200);
  await sleep(500);
});

afterAll(async () => {
  owner?.quit();
  bot?.agent.stop();
  await server?.stop();
});

const dump = () =>
  onTestFailed(() =>
    console.log(
      `--- bot log ---\n${bot.logs.join('\n')}\nstats ${JSON.stringify(bot.agent.bowStats)}`,
    ),
  );

describe('bow combat on a real server', () => {
  it('kills a stationary target 12 blocks away with arrows', async () => {
    dump();
    const r = await killWithArrows('zombie', '~12 ~ ~ {NoAI:1b}');
    expect(r.killed).toBe(true);
    expect(r.shots).toBeGreaterThan(0);
    expect(r.hits).toBeGreaterThan(0);
  });

  it('kills a stationary target 20 blocks away with arrows', async () => {
    dump();
    const r = await killWithArrows('zombie', '~20 ~ ~ {NoAI:1b}');
    expect(r.killed).toBe(true);
    expect(r.hits).toBeGreaterThan(0);
    expect(r.hits / r.shots).toBeGreaterThan(0.5);
  });

  it('kills a skeleton at range', async () => {
    dump();
    const r = await killWithArrows('skeleton', '~14 ~ ~');
    expect(r.killed).toBe(true);
    expect(r.shots).toBeGreaterThan(0);
  });

  it('never shoots while its owner stands in the line of fire', async () => {
    dump();
    owner = createBot({
      host: server.host,
      port: server.port,
      username: ownerName,
      auth: 'offline',
      logErrors: false,
    });
    owner.on('error', () => {});
    await new Promise<void>((resolve) => owner.once('spawn', () => resolve()));
    const ownerHp = owner.health;
    await server.run(`execute at ${name} run tp ${ownerName} ~6 ~ ~`, 400);
    const before = bot.agent.bowStats.shots;
    await server.run(`execute at ${name} run summon zombie ~12 ~ ~ {NoAI:1b}`, 300);
    await waitFor(() => bot.agent.intent.tactic === 'engage', 10_000, 'the bot to take aim');
    await sleep(5000);
    expect(bot.agent.bowStats.shots - before).toBe(0);
    expect(owner.health).toBe(ownerHp);

    // Step aside: now it may shoot.
    await server.run(`execute at ${name} run tp ${ownerName} ~6 ~ ~8`, 400);
    await waitFor(() => bot.agent.bowStats.shots > before, 10_000, 'a shot once the way is clear');
  });
});
