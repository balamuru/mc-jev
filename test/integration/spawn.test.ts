import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { botName, makeAgent, waitFor } from './helpers.js';
import { type TestServer, startTestServer } from './serverHarness.js';

let server: TestServer;
const a = () => agents[0]!.agent;
const agents: ReturnType<typeof makeAgent>[] = [];

beforeAll(async () => {
  server = await startTestServer(25599);
  const suffix = botName('');
  agents.push(makeAgent(server, `ItA${suffix}`), makeAgent(server, `ItB${suffix}`));
}, 180_000);

afterAll(async () => {
  agents.forEach((x) => x.agent.stop());
  await server?.stop();
});

describe('bots on a real server', () => {
  it('spawns and reads a snapshot', async () => {
    agents.forEach((x) => x.agent.start());
    await waitFor(
      () => agents.every((x) => x.agent.state === 'online'),
      60_000,
      'both bots to spawn',
    );
    const snap = a().snapshot();
    expect(snap?.self.hp).toBeGreaterThan(0);
    expect(snap?.self.food).toBeGreaterThan(0);
  });

  it('sees the other bot as a player entity', async () => {
    const other = agents[1]!.agent.config.username;
    const snap = await waitFor(
      () => {
        const s = a().snapshot();
        return s?.entities.some((e) => e.kind === other) ? s : null;
      },
      20_000,
      `${other} to appear in the snapshot`,
    );
    const seen = snap.entities.find((e) => e.kind === other);
    expect(seen).toMatchObject({ category: 'player', visible: true });
  });

  it('reconnects after the server drops the connection', async () => {
    const name = agents[1]!.agent.config.username;
    await server.run(`kick ${name} test kick`);
    await waitFor(() => agents[1]!.agent.state !== 'online', 10_000, 'the bot to notice the kick');
    await waitFor(() => agents[1]!.agent.state === 'online', 30_000, 'the bot to reconnect');
  });
});
