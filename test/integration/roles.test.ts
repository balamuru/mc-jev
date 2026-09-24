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
import { JevGateway } from '../../src/strategic/gateway.js';
import { Blackboard } from '../../src/swarm/blackboard.js';
import { InProcessBus } from '../../src/swarm/bus.js';
import { Coordinator } from '../../src/swarm/coordinator.js';
import { type TestServer, startTestServer } from './serverHarness.js';

let server: TestServer;
let board: Blackboard;
let coordinator: Coordinator;
const squad: TestAgent[] = [];
let tank = '';
let fighter = '';
let archer = '';

const dump = () =>
  onTestFailed(() => {
    for (const m of squad) console.log(`--- ${m.agent.config.username} ---\n${m.logs.join('\n')}`);
  });
const member = (name: string) => squad.find((m) => m.agent.config.username === name)!.agent;

const give = async (name: string, items: string[]) => {
  for (const item of items) await server.run(`give ${name} ${item}`, 100);
};
const clearMobs = () => server.run('kill @e[type=!player]', 300);

beforeAll(async () => {
  server = await startTestServer(25588);
  await calmNight(server);
  const suffix = botName('');
  tank = `Tnk${suffix}`;
  fighter = `Fgt${suffix}`;
  archer = `Arc${suffix}`;
  const names = [tank, fighter, archer];
  const bus = new InProcessBus();
  board = new Blackboard(bus, { claimTtlMs: 8000 });
  for (const name of names) {
    squad.push(
      makeAgent(
        server,
        name,
        { protectedPlayers: names, rules: { ...botDefaults.rules } },
        { swarm: { mode: 'coordinated', bus, board, helpHp: 8, helpAllies: true } },
      ),
    );
  }
  // No Jev client: the coordinator assigns roles by gear.
  coordinator = new Coordinator({
    gateway: new JevGateway({ client: null, limits: { maxCallsPerMinute: 60, dailyBudgetUsd: 0 } }),
    board,
    bus,
    settings: {
      intervalMs: 1000,
      directiveTtlMs: 6000,
      model: 'jev-latest',
      timeoutMs: 1000,
      assignRoles: true,
    },
    thresholds: botDefaults.jev.thresholds,
    log: { info() {}, warn() {}, error() {} },
  });
  squad.forEach((m, i) => setTimeout(() => m.agent.start(), i * 300));
  await waitFor(() => squad.every((m) => m.agent.state === 'online'), 90_000, 'the squad to spawn');
  coordinator.start();

  // The most armor makes the tank; a bow and arrows make the archer ranged.
  await give(tank, [
    'iron_sword',
    'diamond_helmet',
    'diamond_chestplate',
    'diamond_leggings',
    'diamond_boots',
  ]);
  await give(fighter, [
    'iron_sword',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
  ]);
  await give(archer, ['iron_sword', 'leather_helmet', 'leather_chestplate', 'bow', 'arrow 64']);
  await waitFor(
    () =>
      member(tank).snapshot()?.self.armor.length === 4 &&
      member(fighter).snapshot()?.self.armor.length === 4 &&
      member(archer).snapshot()?.self.armor.length === 2,
    15_000,
    'armor',
  );
}, 240_000);

afterAll(async () => {
  coordinator?.stop();
  squad.forEach((m) => m.agent.stop());
  board?.close();
  await server?.stop();
});

describe('a coordinated squad with roles on a real server', () => {
  it('assigns roles by gear once there is something to fight', async () => {
    dump();
    await server.run(`execute at ${tank} run tp ${fighter} ~3 ~ ~`, 150);
    await server.run(`execute at ${tank} run tp ${archer} ~-3 ~ ~`, 150);
    await server.run(
      `execute at ${tank} run summon zombie ~12 ~ ~ {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b}`,
    );
    await waitFor(
      () =>
        board.assignedRole(tank) === 'tank' &&
        board.assignedRole(archer) === 'ranged' &&
        board.assignedRole(fighter) === 'fighter',
      15_000,
      'roles by gear',
    );
    // Each bot takes up its role and reports it in its heartbeat.
    await waitFor(
      () => board.allAllies().find((a) => a.agent === tank)?.role === 'tank',
      5000,
      'the tank to report its role',
    );
    await clearMobs();
  });

  it('the tank covers a hurt ally instead of fighting what is nearest to itself', async () => {
    dump();
    // The fighter stands 10 blocks away, hurt, with a zombie beside it; another zombie is next to the tank.
    await server.run(`execute at ${tank} run tp ${fighter} ~10 ~ ~`, 150);
    await server.run(`execute at ${tank} run tp ${archer} ~-30 ~ ~`, 150);
    await server.run(`damage ${fighter} 9 minecraft:magic`, 300);
    await waitFor(
      () => (board.allAllies().find((a) => a.agent === fighter)?.hp ?? 20) <= 14,
      5000,
      'the fighter to be hurt',
    );
    await server.run(
      `execute at ${tank} run summon zombie ~2 ~ ~ {NoAI:1b,PersistenceRequired:1b}`,
    );
    await server.run(
      `execute at ${fighter} run summon zombie ~2 ~ ~ {NoAI:1b,PersistenceRequired:1b}`,
    );
    await waitFor(
      () => member(tank).intent.reason.startsWith(`covering ${fighter}`),
      10_000,
      'the tank to cover the fighter',
    );
    await clearMobs();
    await server.run(`effect give ${fighter} minecraft:instant_health 1 10 true`, 300);
  });

  it('the ranged bot backs away from a zombie that comes close, and shoots', async () => {
    dump();
    await server.run(`execute at ${tank} run tp ${archer} ~-30 ~ ~`, 150);
    await sleep(500);
    const shotsBefore = member(archer).bowStats?.shots ?? 0;
    await server.run(`execute at ${archer} run summon zombie ~6 ~ ~ {PersistenceRequired:1b}`);
    await waitFor(
      () => member(archer).intent.reason.startsWith('keeping my distance'),
      10_000,
      'the archer to back away',
    );
    await waitFor(
      () => (member(archer).bowStats?.shots ?? 0) > shotsBefore,
      20_000,
      'the archer to shoot',
    );
    expect(member(archer).deaths).toBe(0);
    await clearMobs();
  });
});
