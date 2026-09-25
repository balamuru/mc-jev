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
import { formatSnapshot } from '../../src/perception/format.js';
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
  // Retreating is off by default; this file tests the retreat machinery, so switch it on here.
  bot = makeAgent(server, name, { rules: { ...botDefaults.rules, retreat: true } });
  bot.agent.start();
  await waitFor(() => bot.agent.state === 'online', 60_000, 'the bot to spawn');
}, 180_000);

afterAll(async () => {
  bot?.agent.stop();
  await server?.stop();
});

// On failure, print what the bot was doing and seeing, not just its log: this test has failed
// intermittently under full-suite load, and the state at the moment of failure is the clue.
const dumpOnFailure = () =>
  onTestFailed(() => {
    const snap = bot.agent.snapshot();
    console.log(
      `--- bot log ---\n${bot.logs.join('\n')}\n` +
        `--- at failure ---\nintent: ${JSON.stringify(bot.agent.intent)}\n` +
        `deaths: ${bot.agent.deaths}\nsnapshot: ${snap ? formatSnapshot(snap) : 'none'}`,
    );
  });

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

  it('does not eat while hostiles are close, and eats once they are gone', async () => {
    dumpOnFailure();
    const beef = () => {
      const item = bot.agent.snapshot()?.inventory.find((i) => i.startsWith('cooked_beef'));
      return item ? Number(item.split('x')[1]) : 0;
    };

    // Get hungry with no food in the inventory, so nothing can start eating yet.
    await server.run(`effect give ${name} hunger 30 120`, 200);
    await waitFor(() => (bot.agent.snapshot()?.self.food ?? 20) < 12, 20_000, 'hunger');
    await server.run(`effect clear ${name}`, 150);

    // Two zombies show up, and only then does food appear.
    await server.run(`execute at ${name} run summon zombie ~5 ~ ~`, 100);
    await server.run(`execute at ${name} run summon zombie ~-5 ~ ~`, 100);
    await server.run(`give ${name} cooked_beef 8`, 100);
    await waitFor(() => beef() === 8, 5_000, 'the beef to arrive');

    await waitFor(() => hostilesNearby().length === 0, 45_000, 'both zombies to die');
    expect(beef()).toBe(8); // it never stopped to eat mid-fight

    await waitFor(() => beef() < 8, 30_000, 'the bot to eat once it was safe');
  });

  it('fights one zombie at low HP, but retreats from a group', async () => {
    dumpOnFailure();
    // Set HP to exactly 6: heal fully, then take 14 magic damage (which armor does not reduce).
    // Starting from whatever the earlier tests left made this flaky: at 1-2 HP the rules rightly
    // retreat even from a single zombie.
    await server.run(`effect give ${name} minecraft:instant_health 1 10 true`, 300);
    await waitFor(() => (bot.agent.snapshot()?.self.hp ?? 0) >= 20, 5_000, 'full HP');
    await server.run(`damage ${name} 14 minecraft:magic`, 300);
    await waitFor(() => Math.round(bot.agent.snapshot()?.self.hp ?? 0) === 6, 5_000, 'HP 6');

    // One zombie against a geared bot is a fight it should take, even at 6 HP.
    await server.run(`execute at ${name} run summon zombie ~8 ~ ~`);
    await waitFor(() => bot.agent.intent.tactic === 'engage', 10_000, 'the bot to engage');
    await waitFor(() => hostilesNearby().length === 0, 45_000, 'the zombie to die');
    expect(bot.agent.deaths).toBe(0);

    // Three at once at low HP is not (natural regeneration is off, so it is still hurt).
    expect(bot.agent.snapshot()?.self.hp).toBeLessThanOrEqual(6);
    for (const dx of [8, -8, 10]) {
      await server.run(`execute at ${name} run summon zombie ~${dx} ~ ~`, 100);
    }
    await waitFor(() => bot.agent.intent.tactic === 'retreat', 10_000, 'the bot to retreat');
    expect(bot.agent.intent.reason).toContain('fleeing zombie');

    await server.run('kill @e[type=zombie]');
    await waitFor(() => bot.agent.intent.tactic === 'idle', 10_000, 'the bot to calm down');
  });
});

describe('default settings', () => {
  it('fights on at low HP against a group instead of running', async () => {
    const fighterName = botName('Def');
    const fighter = makeAgent(server, fighterName); // shipped defaults: retreating off
    fighter.agent.start();
    try {
      await waitFor(() => fighter.agent.state === 'online', 60_000, 'the default bot to spawn');
      await server.run('kill @e[type=zombie]');
      for (const item of [
        'iron_sword',
        'iron_helmet',
        'iron_chestplate',
        'iron_leggings',
        'iron_boots',
      ]) {
        await server.run(`give ${fighterName} ${item}`, 120);
      }
      await waitFor(() => fighter.agent.snapshot()?.self.armor.length === 4, 10_000, 'armor');
      for (let i = 0; i < 10 && (fighter.agent.snapshot()?.self.hp ?? 20) > 5; i++) {
        await server.run(`damage ${fighterName} 4 minecraft:magic`, 250);
      }
      for (const dx of [8, -8, 10]) {
        await server.run(`execute at ${fighterName} run summon zombie ~${dx} ~ ~`, 100);
      }
      await waitFor(() => fighter.agent.intent.tactic === 'engage', 10_000, 'the bot to engage');
      await sleep(3000);
      expect(fighter.logs.some((l) => l.includes('-> retreat'))).toBe(false);
    } finally {
      fighter.agent.stop();
      await server.run('kill @e[type=zombie]');
    }
  });
});
