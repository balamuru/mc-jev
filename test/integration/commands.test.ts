import { createBot, type Bot } from 'mineflayer';
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
let agentName: string;
let ownerName: string;
let bot: TestAgent;
let owner: Bot;
let stranger: Bot;
const heard: string[] = [];

const agent = (): BotAgent => bot.agent;
const spawnClient = async (username: string): Promise<Bot> => {
  const client = createBot({
    host: server.host,
    port: server.port,
    username,
    auth: 'offline',
    logErrors: false,
  });
  client.on('error', () => {});
  await new Promise<void>((resolve, reject) => {
    client.once('spawn', () => resolve());
    client.once('end', () => reject(new Error(`${username} was disconnected`)));
  });
  return client;
};
const say = (client: Bot, text: string) => client.chat(text);
const distanceTo = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const ownerDistance = () => {
  const me = agent().snapshot()?.self.position;
  return me ? distanceTo(me, owner.entity.position) : Number.POSITIVE_INFINITY;
};

beforeAll(async () => {
  server = await startTestServer(25596);
  await calmNight(server);
  agentName = botName('Cmd');
  ownerName = botName('Own');
  bot = makeAgent(server, agentName, {
    owner: ownerName,
    rules: { ...botDefaults.rules, retreat: false },
  });
  agent().start();
  await waitFor(() => agent().state === 'online', 60_000, 'the agent to spawn');
  owner = await spawnClient(ownerName);
  stranger = await spawnClient(botName('Str'));
  owner.on('chat', (username, message) => {
    heard.push(`${username}: ${message}`);
  });
  await server.run(`give ${agentName} iron_sword`, 150);
}, 180_000);

afterAll(async () => {
  owner?.quit();
  stranger?.quit();
  agent()?.stop();
  await server?.stop();
});

const dump = () =>
  onTestFailed(() =>
    console.log(
      `--- agent log ---\n${bot.logs.join('\n')}\n--- chat heard ---\n${heard.join('\n')}`,
    ),
  );

describe('chat commands on a real server', () => {
  it('answers its owner in chat', async () => {
    dump();
    say(owner, 'help');
    await waitFor(
      () => heard.some((h) => h.startsWith(`${agentName}:`) && h.includes('guard here')),
      10_000,
      'the help reply',
    );
    say(owner, 'status');
    await waitFor(
      () => heard.some((h) => h.startsWith(`${agentName}: mode guard; hp`)),
      10_000,
      'the status reply',
    );
  });

  it('follows the owner across the map', async () => {
    dump();
    await server.run(`execute at ${ownerName} run tp ${ownerName} ~18 ~ ~`);
    await waitFor(() => ownerDistance() > 14, 10_000, 'the owner to be far away');
    say(owner, 'follow me');
    await waitFor(() => agent().mode.name === 'follow', 10_000, 'follow mode');
    await waitFor(() => ownerDistance() <= 5, 30_000, 'the bot to catch up with its owner');
    expect(agent().intent.tactic).toBe('follow');
  });

  it('holds a post, and walks back to it when moved away', async () => {
    dump();
    say(owner, 'guard here');
    await waitFor(() => agent().mode.name === 'guard' && !!agent().mode.anchor, 10_000, 'a post');
    const post = agent().mode.anchor!;
    await server.run(`execute at ${agentName} run tp ${agentName} ~12 ~ ~`);
    await waitFor(
      () => distanceTo(agent().snapshot()!.self.position, post) > 8,
      10_000,
      'the bot to be moved off its post',
    );
    await waitFor(
      () => distanceTo(agent().snapshot()!.self.position, post) <= 3.5,
      30_000,
      'the bot to walk back to its post',
    );
  });

  it('stands down on "stop" (ignores a zombie) and fights again on "auto"', async () => {
    dump();
    say(owner, 'stop');
    await waitFor(() => agent().mode.name === 'idle', 10_000, 'stand-down mode');
    await server.run(`execute at ${agentName} run summon zombie ~5 ~ ~`);
    await sleep(3000);
    expect(agent().intent.tactic).toBe('idle');
    expect(
      agent()
        .snapshot()
        ?.entities.some((e) => e.category === 'hostile'),
    ).toBe(true);

    say(owner, 'auto');
    await waitFor(() => agent().intent.tactic === 'engage', 10_000, 'the bot to engage again');
    await waitFor(
      () =>
        !agent()
          .snapshot()
          ?.entities.some((e) => e.category === 'hostile'),
      45_000,
      'the zombie to die',
    );
  });

  it('ignores commands from anyone but the owner', async () => {
    dump();
    say(owner, 'hunt');
    await waitFor(() => agent().mode.name === 'hunt', 10_000, 'hunt mode');
    say(stranger, 'stop');
    say(stranger, `${agentName} follow`);
    await sleep(2000);
    expect(agent().mode.name).toBe('hunt');
    say(owner, 'auto');
    await waitFor(() => agent().mode.name === 'guard', 10_000, 'the default mode');
  });
});
