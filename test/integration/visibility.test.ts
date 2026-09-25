import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import type { BotAgent } from '../../src/agent/BotAgent.js';
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
const bots: TestAgent[] = [];
let sight = ''; // requireLineOfSight on
let blind = ''; // no visibility filter
let narrow = ''; // a 90-degree field of view

const agent = (name: string): BotAgent => bots.find((b) => b.agent.config.username === name)!.agent;
const seesZombie = (name: string) =>
  agent(name)
    .snapshot()
    ?.entities.some((e) => e.kind === 'zombie') ?? false;
const dump = () =>
  onTestFailed(() => {
    for (const name of [sight, blind, narrow]) {
      console.log(`--- ${name} ---\n${JSON.stringify(agent(name).snapshot()?.entities)}`);
    }
  });

/** Observe-only bots: the reflex layer is off, so nobody fights or moves. */
const observer = (name: string, perception: Partial<typeof botDefaults.perception>) =>
  makeAgent(server, name, {
    perception: { ...botDefaults.perception, ...perception },
    reflex: { ...botDefaults.reflex, enabled: false },
    strategic: { ...botDefaults.strategic, enabled: false },
  });

beforeAll(async () => {
  server = await startTestServer(25587);
  await calmNight(server);
  const suffix = botName('');
  sight = `Los${suffix}`;
  blind = `All${suffix}`;
  narrow = `Fov${suffix}`;
  bots.push(
    observer(sight, { requireLineOfSight: true }),
    observer(blind, { requireLineOfSight: false }),
    observer(narrow, { fovDegrees: 90 }),
  );
  bots.forEach((b, i) => setTimeout(() => b.agent.start(), i * 300));
  await waitFor(() => bots.every((b) => b.agent.state === 'online'), 90_000, 'the bots to spawn');
  // A row of bots two blocks apart along z, all facing east (+x), with a zombie that cannot move
  // 8 blocks east of the middle one.
  await server.run(`execute at ${sight} run tp ${blind} ~ ~ ~2 -90 0`, 150);
  await server.run(`execute at ${sight} run tp ${narrow} ~ ~ ~4 -90 0`, 150);
  await server.run(`execute at ${sight} run tp ${sight} ~ ~ ~ -90 0`, 150);
  await server.run(
    `execute at ${blind} run summon zombie ~8 ~ ~ {NoAI:1b,PersistenceRequired:1b,Invulnerable:1b}`,
  );
  await waitFor(
    () => [sight, blind, narrow].every(seesZombie),
    10_000,
    'every bot to see the zombie in the open',
  );
}, 240_000);

afterAll(async () => {
  bots.forEach((b) => b.agent.stop());
  await server?.stop();
});

describe('line of sight and field of view on a real server', () => {
  it('a bot that needs line of sight loses the zombie behind a wall, and sees it again once the wall is gone', async () => {
    dump();
    // A stone wall 4 blocks east of the row, 4 high, covering every bot's view of the zombie.
    await server.run(`execute at ${blind} run fill ~4 ~ ~-6 ~4 ~3 ~6 minecraft:stone`, 300);
    await waitFor(() => !seesZombie(sight), 10_000, 'the zombie to be hidden behind the wall');
    // Without the filter the wall makes no difference.
    expect(seesZombie(blind)).toBe(true);
    await sleep(1000);
    expect(seesZombie(sight)).toBe(false);

    await server.run(`execute at ${blind} run fill ~4 ~ ~-6 ~4 ~3 ~6 minecraft:air`, 300);
    await waitFor(() => seesZombie(sight), 10_000, 'the zombie to be visible again');
    expect(seesZombie(blind)).toBe(true);
  });

  it('a bot with a narrow field of view loses the zombie when it turns away', async () => {
    dump();
    expect(seesZombie(narrow)).toBe(true);
    // Face west, with the zombie behind.
    await server.run(`execute at ${narrow} run tp ${narrow} ~ ~ ~ 90 0`, 300);
    await waitFor(() => !seesZombie(narrow), 10_000, 'the zombie to leave the field of view');
    // A bot with the full circle still sees it, whichever way it faces.
    await server.run(`execute at ${blind} run tp ${blind} ~ ~ ~ 90 0`, 300);
    await sleep(500);
    expect(seesZombie(blind)).toBe(true);
    // Facing east again brings it back.
    await server.run(`execute at ${narrow} run tp ${narrow} ~ ~ ~ -90 0`, 300);
    await waitFor(() => seesZombie(narrow), 10_000, 'the zombie to be back in view');
  });
});
