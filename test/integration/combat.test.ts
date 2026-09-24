import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { botName, calmNight, makeAgent, sleep, waitFor, type TestAgent } from './helpers.js';
import { type TestServer, startTestServer } from './serverHarness.js';

let server: TestServer;
let bot: TestAgent;
let name: string;
const hostilesNearby = () =>
  bot.agent.snapshot()?.entities.filter((e) => e.category === 'hostile') ?? [];

beforeAll(async () => {
  server = await startTestServer(25598);
  await calmNight(server);
  name = botName('Fgt');
  bot = makeAgent(server, name);
  bot.agent.start();
  await waitFor(() => bot.agent.state === 'online', 60_000, 'the bot to spawn');
}, 180_000);

afterAll(async () => {
  bot?.agent.stop();
  await server?.stop();
});

const dumpOnFailure = () =>
  onTestFailed(() => console.log(`--- bot log ---\n${bot.logs.join('\n')}`));

describe('reflex layer on a real server', () => {
  it('puts on armor it is given', async () => {
    dumpOnFailure();
    for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
      await server.run(`give ${name} iron_${piece}`, 150);
    }
    await waitFor(() => bot.agent.snapshot()?.self.armor.length === 4, 10_000, 'armor to be worn');
  });

  it('fights a zombie with the best weapon it has and survives', async () => {
    dumpOnFailure();
    await server.run(`give ${name} wooden_sword`, 150);
    await server.run(`give ${name} iron_sword`, 150);
    await server.run(`execute at ${name} run summon zombie ~6 ~ ~`);

    await waitFor(() => bot.agent.intent.tactic === 'engage', 10_000, 'the bot to engage');
    await waitFor(() => bot.agent.snapshot()?.self.heldItem === 'iron_sword', 10_000, 'iron sword');

    await waitFor(() => hostilesNearby().length === 0, 45_000, 'the zombie to die');
    await waitFor(() => bot.agent.intent.tactic === 'idle', 5_000, 'the bot to go idle');
    expect(bot.agent.snapshot()?.self.hp).toBeGreaterThan(0);
  });

  it('retreats instead of fighting when its HP is low', async () => {
    dumpOnFailure();
    // Wear the bot down to the retreat threshold.
    for (let i = 0; i < 10 && (bot.agent.snapshot()?.self.hp ?? 20) > 5; i++) {
      await server.run(`damage ${name} 4`, 250);
    }
    expect(bot.agent.snapshot()?.self.hp).toBeLessThanOrEqual(6);

    await server.run(`execute at ${name} run summon zombie ~8 ~ ~`);
    await waitFor(() => bot.agent.intent.tactic === 'retreat', 10_000, 'the bot to retreat');
    expect(bot.agent.intent.reason).toContain('fleeing zombie');

    await server.run('kill @e[type=zombie]');
    await waitFor(() => bot.agent.intent.tactic === 'idle', 10_000, 'the bot to calm down');
  });

  it('eats when hungry', async () => {
    dumpOnFailure();
    await server.run(`give ${name} cooked_beef 8`, 200);
    const beef = () => {
      const item = bot.agent.snapshot()?.inventory.find((i) => i.startsWith('cooked_beef'));
      return item ? Number(item.split('x')[1]) : 0;
    };
    await waitFor(() => beef() === 8, 5_000, 'the beef to arrive');

    await server.run(`effect give ${name} hunger 20 120`);
    await waitFor(() => beef() < 8, 30_000, 'the bot to eat');
    await sleep(500);
  });
});
