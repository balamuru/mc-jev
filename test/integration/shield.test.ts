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
const hostiles = () => bot.agent.snapshot()?.entities.filter((e) => e.category === 'hostile') ?? [];

beforeAll(async () => {
  server = await startTestServer(25591);
  await calmNight(server);
  name = botName('Shd');
  bot = makeAgent(server, name, { rules: { ...botDefaults.rules, shield: true } });
  bot.agent.start();
  await waitFor(() => bot.agent.state === 'online', 60_000, 'the bot to spawn');
}, 180_000);

afterAll(async () => {
  bot?.agent.stop();
  await server?.stop();
});

afterEach(async () => {
  await server.run('kill @e[type=!player]', 150);
});

const dump = () => onTestFailed(() => console.log(`--- bot log ---\n${bot.logs.join('\n')}`));

describe('shield on a real server', () => {
  it('puts a shield it is given in its off-hand', async () => {
    dump();
    await server.run(`give ${name} iron_sword`, 150);
    await server.run(`give ${name} shield`, 150);
    await waitFor(
      () => bot.agent.snapshot()?.self.offhand === 'shield',
      10_000,
      'the shield in the off-hand',
    );
  });

  it('raises the shield between swings against a zombie, and still kills it', async () => {
    dump();
    let raised = false;
    const watch = setInterval(() => {
      raised ||= bot.agent.blocking;
    }, 20);
    try {
      await server.run(`execute at ${name} run summon zombie ~4 ~ ~`);
      await waitFor(() => bot.agent.intent.tactic === 'engage', 10_000, 'the bot to engage');
      await waitFor(() => hostiles().length === 0, 45_000, 'the zombie to die');
    } finally {
      clearInterval(watch);
    }
    expect(raised).toBe(true);
    // Lowered on the actuator's next tick after the target is gone.
    await waitFor(() => !bot.agent.blocking, 2_000, 'the shield to be lowered');
  });

  it('keeps its shield down when switched off', async () => {
    dump();
    const plain = makeAgent(server, botName('NoS'), {
      rules: { ...botDefaults.rules, shield: false },
    });
    plain.agent.start();
    try {
      await waitFor(() => plain.agent.state === 'online', 60_000, 'the second bot to spawn');
      const n = plain.agent.config.username;
      await server.run(`give ${n} iron_sword`, 150);
      await server.run(`give ${n} shield`, 150);
      await waitFor(() => plain.agent.snapshot()?.self.offhand === 'shield', 10_000, 'the shield');
      let raised = false;
      const watch = setInterval(() => {
        raised ||= plain.agent.blocking;
      }, 20);
      await server.run(`execute at ${n} run summon zombie ~4 ~ ~`);
      await sleep(5000);
      clearInterval(watch);
      expect(raised).toBe(false);
    } finally {
      plain.agent.stop();
    }
  });
});
