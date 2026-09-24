import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BotAgent, type Logger } from '../../src/agent/BotAgent.js';
import { parseConfig } from '../../src/config.js';

// Needs a running local server: ./scripts/server.sh  (see docs/setup.md)
const config = parseConfig(JSON.parse(readFileSync('config/default.json', 'utf8')), process.env);
const quiet: Logger = { info() {}, warn() {}, error: (m) => console.error(m) };

function serverReachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2000 });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
  });
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs: number, what: string) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const suffix = Math.random().toString(36).slice(2, 6);
const template = config.bots[0]!;
const agents = ['A', 'B'].map(
  (n) =>
    new BotAgent({ ...template, username: `It${n}_${suffix}` }, config.server, {
      logger: quiet,
    }),
);

beforeAll(async () => {
  if (!(await serverReachable(config.server.host, config.server.port))) {
    throw new Error(
      `No Minecraft server at ${config.server.host}:${config.server.port}. Start it with ./scripts/server.sh`,
    );
  }
});

afterAll(() => agents.forEach((a) => a.stop()));

describe('bots on a real server', () => {
  it('spawns and reads a snapshot', async () => {
    agents.forEach((a) => a.start());
    await waitFor(() => agents.every((a) => a.state === 'online'), 60_000, 'both bots to spawn');
    const snap = agents[0]!.snapshot();
    expect(snap?.self.hp).toBeGreaterThan(0);
    expect(snap?.self.food).toBeGreaterThan(0);
  });

  it('sees the other bot as a player entity', async () => {
    const other = agents[1]!.config.username;
    const snap = await waitFor(
      () => {
        const s = agents[0]!.snapshot();
        return s?.entities.some((e) => e.kind === other) ? s : null;
      },
      20_000,
      `${other} to appear in the snapshot`,
    );
    const seen = snap.entities.find((e) => e.kind === other);
    expect(seen).toMatchObject({ category: 'player', visible: true });
    expect(seen?.dist).toBeGreaterThanOrEqual(0);
  });
});
