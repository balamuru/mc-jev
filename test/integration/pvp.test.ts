import { createBot, type Bot } from 'mineflayer';
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
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
let agentName: string;
let ownerName: string;
let rivalName: string;
let bystanderName: string;
let owner: Bot;
let rival: Bot;
let bystander: Bot;
const clients: Bot[] = [];

const spawnClient = async (username: string): Promise<Bot> => {
  const client = createBot({
    host: server.host,
    port: server.port,
    username,
    auth: 'offline',
    logErrors: false,
  });
  client.on('error', () => {});
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('spawn', () => resolve());
    client.once('end', () => reject(new Error(`${username} was disconnected`)));
  });
  return client;
};

/** A scripted opponent: run at the target, and hit it whenever the swing has recharged. */
function attack(client: Bot, targetName: string, cooldownMs = 650): () => void {
  let last = 0;
  const timer = setInterval(() => {
    const target = client.players[targetName]?.entity;
    if (!target || !client.entity) return;
    const dist = client.entity.position.distanceTo(target.position);
    void client.lookAt(target.position.offset(0, target.height * 0.9, 0), true).catch(() => {});
    if (dist > 2.8) {
      client.setControlState('forward', true);
      client.setControlState('sprint', true);
    } else {
      client.setControlState('forward', false);
      client.setControlState('sprint', false);
      if (Date.now() - last >= cooldownMs) {
        client.attack(target);
        last = Date.now();
      }
    }
  }, 50);
  return () => {
    clearInterval(timer);
    client.clearControlStates();
  };
}

const agent = () => bot.agent;
const dump = () => onTestFailed(() => console.log(`--- agent log ---\n${bot.logs.join('\n')}`));

beforeAll(async () => {
  server = await startTestServer(25595);
  await calmNight(server);
  agentName = botName('Def');
  ownerName = botName('Own');
  rivalName = botName('Rvl');
  bystanderName = botName('Bys');
  bot = makeAgent(server, agentName, { owner: ownerName, rules: { ...botDefaults.rules } });
  agent().start();
  await waitFor(() => agent().state === 'online', 60_000, 'the bot to spawn');
  owner = await spawnClient(ownerName);
  rival = await spawnClient(rivalName);
  bystander = await spawnClient(bystanderName);
  for (const item of [
    'iron_sword',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
  ]) {
    await server.run(`give ${agentName} ${item}`, 120);
  }
  await server.run(`give ${rivalName} wooden_sword`, 120);
  await server.run(`give ${ownerName} iron_sword`, 120);
  await waitFor(() => agent().snapshot()?.self.armor.length === 4, 10_000, 'armor to be worn');
  const sword = rival.inventory.items().find((i) => i.name === 'wooden_sword');
  if (sword) await rival.equip(sword, 'hand');
  const ownerSword = owner.inventory.items().find((i) => i.name === 'iron_sword');
  if (ownerSword) await owner.equip(ownerSword, 'hand');
}, 180_000);

afterAll(async () => {
  clients.forEach((c) => c.quit());
  agent()?.stop();
  await server?.stop();
});

describe('player combat on a real server', () => {
  it('does not attack players who are not attacking it', async () => {
    dump();
    await sleep(3000);
    expect(agent().intent.tactic).toBe('idle');
    expect(bystander.health).toBe(20);
    expect(rival.health).toBe(20);
  });

  it('fights back against a player who attacks it, and leaves a bystander alone', async () => {
    dump();
    let rivalDied = false;
    rival.once('death', () => {
      rivalDied = true;
    });
    // Keep the bystander well away from the fight: the scripted rival swings from the ground, and
    // its own sweeps would otherwise hit anyone standing beside the bot. (Our bot's sweep safety has
    // its own test below.)
    await server.run(`execute at ${agentName} run tp ${bystanderName} ~10 ~ ~`, 300);
    const bystanderHits: string[] = [];
    bystander.on('entityHurt', (victim, source) => {
      if (victim === bystander.entity)
        bystanderHits.push(source?.username ?? source?.name ?? 'unknown');
    });
    onTestFailed(() => console.log(`--- bystander was hit by: ${bystanderHits.join(', ')}`));
    const stop = attack(rival, agentName);
    try {
      await waitFor(
        () => agent().intent.tactic === 'engage' && agent().intent.reason.includes(rivalName),
        20_000,
        'the bot to fight back against its attacker',
      );
      await waitFor(() => rivalDied, 60_000, 'the attacker to be beaten');
    } finally {
      stop();
    }
    expect(agent().deaths).toBe(0);
    expect(bystander.health).toBe(20);
    expect(bot.logs.some((l) => l.includes(`fighting ${bystanderName}`))).toBe(false);
  });

  it('never hurts its owner with a sword sweep when the owner stands next to its target', async () => {
    dump();
    await waitFor(() => agent().intent.tactic === 'idle', 30_000, 'the bot to calm down');
    // A zombie that cannot move or attack (NoAI), right beside the owner: the only way the owner
    // can get hurt is the bot's own swing sweeping into them.
    await server.run(`execute at ${agentName} run tp ${ownerName} ~4 ~ ~`, 300);
    await server.run(`execute at ${ownerName} run summon zombie ~1 ~ ~ {NoAI:1b}`, 300);
    const before = owner.health;
    const hurt: number[] = [];
    const onHealth = () => {
      if (owner.health < before) hurt.push(owner.health);
    };
    owner.on('health', onHealth);
    try {
      await waitFor(
        () => agent().intent.tactic === 'engage',
        10_000,
        'the bot to engage the zombie',
      );
      const zombieAlive = async () =>
        /Test passed/.test(await server.run('execute if entity @e[type=zombie]', 200));
      const start = Date.now();
      while ((await zombieAlive()) && Date.now() - start < 45_000) await sleep(300);
      expect(await zombieAlive()).toBe(false);
    } finally {
      owner.removeListener('health', onHealth);
      await server.run('kill @e[type=zombie]', 150);
    }
    expect(hurt).toEqual([]);
  });

  it('never fights back against its owner, even when the owner hits it', async () => {
    dump();
    await waitFor(() => agent().intent.tactic === 'idle', 30_000, 'the bot to calm down');
    const before = owner.health;
    const botHpBefore = agent().snapshot()?.self.hp ?? 20;
    // Record every change to the owner's health, and what the bot was doing at the time.
    const ownerHurt: string[] = [];
    const onHealth = () => {
      if (owner.health < before) {
        ownerHurt.push(
          `owner hp ${owner.health}; bot intent ${agent().intent.tactic}: ${agent().intent.reason}`,
        );
      }
    };
    owner.on('health', onHealth);
    onTestFailed(() => console.log(`--- owner health ---\n${ownerHurt.join('\n')}`));
    const stop = attack(owner, agentName, 800);
    try {
      await waitFor(
        () => (agent().snapshot()?.self.hp ?? botHpBefore) < botHpBefore,
        30_000,
        'the owner to land a hit on the bot',
      );
      await sleep(4000);
    } finally {
      stop();
      owner.removeListener('health', onHealth);
    }
    expect(ownerHurt).toEqual([]);
    expect(bot.logs.some((l) => l.includes(`fighting ${ownerName}`))).toBe(false);
    // It may still be dealing with the earlier rival, but never with its owner.
    expect(agent().intent.reason).not.toContain(ownerName);
  });
});
