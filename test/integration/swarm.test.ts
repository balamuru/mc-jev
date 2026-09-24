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
import { Blackboard } from '../../src/swarm/blackboard.js';
import { InProcessBus } from '../../src/swarm/bus.js';
import { type TestServer, startTestServer } from './serverHarness.js';

let server: TestServer;
let board: Blackboard;
const squad: TestAgent[] = [];
let names: string[] = [];

const dump = () =>
  onTestFailed(() => {
    for (const m of squad) console.log(`--- ${m.agent.config.username} ---\n${m.logs.join('\n')}`);
  });

const zombiesAlive = async () =>
  /Test passed/.test(await server.run('execute if entity @e[type=zombie]', 200));

beforeAll(async () => {
  server = await startTestServer(25594);
  await calmNight(server);
  const suffix = botName('');
  names = ['Sq1', 'Sq2', 'Sq3'].map((n) => `${n}${suffix}`);
  const bus = new InProcessBus();
  board = new Blackboard(bus, { claimTtlMs: 8000 });
  for (const name of names) {
    squad.push(
      makeAgent(
        server,
        name,
        { protectedPlayers: names, rules: { ...botDefaults.rules } },
        { swarm: { mode: 'cooperative', bus, board, helpHp: 8, helpAllies: true } },
      ),
    );
  }
  squad.forEach((m, i) => setTimeout(() => m.agent.start(), i * 300));
  await waitFor(() => squad.every((m) => m.agent.state === 'online'), 90_000, 'the squad to spawn');
  // Stand them together, and equip them.
  await server.run(`execute at ${names[0]} run tp ${names[1]} ~3 ~ ~`, 150);
  await server.run(`execute at ${names[0]} run tp ${names[2]} ~-3 ~ ~`, 150);
  for (const name of names) {
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
    () => squad.every((m) => m.agent.snapshot()?.self.armor.length === 4),
    15_000,
    'armor',
  );
}, 240_000);

afterAll(async () => {
  squad.forEach((m) => m.agent.stop());
  board?.close();
  await server?.stop();
});

describe('a cooperative squad on a real server', () => {
  it('knows each other through the blackboard', async () => {
    dump();
    await waitFor(() => board.allAllies().length === 3, 10_000, 'all three bots on the blackboard');
    expect(
      board
        .allAllies()
        .map((a) => a.agent)
        .sort(),
    ).toEqual([...names].sort());
  });

  it('spreads out over a wave of zombies, beats it, and loses nobody', async () => {
    dump();
    const targetsSeen = new Set<string>();
    let peakDistinct = 0;
    const sample = setInterval(() => {
      const claims = board.liveClaims();
      const distinct = new Set(claims.map((c) => c.targetId)).size;
      peakDistinct = Math.max(peakDistinct, distinct);
      for (const c of claims) targetsSeen.add(`${c.agent}->${c.targetId}`);
    }, 100);
    try {
      for (const [dx, dz] of [
        [8, 0],
        [-8, 0],
        [0, 8],
        [0, -8],
        [6, 6],
        [-6, -6],
      ]) {
        await server.run(`execute at ${names[0]} run summon zombie ~${dx} ~ ~${dz}`, 80);
      }
      await waitFor(
        () => squad.some((m) => m.agent.intent.tactic === 'engage'),
        15_000,
        'the squad to engage',
      );
      const start = Date.now();
      while ((await zombiesAlive()) && Date.now() - start < 90_000) await sleep(500);
    } finally {
      clearInterval(sample);
    }
    expect(await zombiesAlive()).toBe(false);
    expect(squad.map((m) => m.agent.deaths)).toEqual([0, 0, 0]);
    // While the wave lasted, bots held different targets at the same time.
    expect(peakDistinct).toBeGreaterThanOrEqual(2);
    expect(new Set([...targetsSeen].map((s) => s.split('->')[0])).size).toBeGreaterThanOrEqual(2);
  });

  it('frees its claims once the fight is over', async () => {
    dump();
    await waitFor(() => board.liveClaims().length === 0, 15_000, 'all claims to be released');
  });
});
