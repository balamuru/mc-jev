import { readFileSync } from 'node:fs';
import { BotAgent, type AgentOptions, type Logger } from '../../src/agent/BotAgent.js';
import { type BotConfig, parseConfig } from '../../src/config.js';
import type { TestServer } from './serverHarness.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

const baseConfig = parseConfig(JSON.parse(readFileSync('config/default.json', 'utf8')));

/** The default settings of the first bot in config/default.json. */
export const botDefaults = baseConfig.bots[0]!;

/** A unique bot name so reruns never collide with a lingering session. */
export function botName(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 7)}`;
}

export interface TestAgent {
  agent: BotAgent;
  logs: string[];
}

export function makeAgent(
  server: TestServer,
  username: string,
  overrides: Partial<BotConfig> = {},
  extra: Partial<AgentOptions> = {},
): TestAgent {
  const logs: string[] = [];
  const logger: Logger = {
    info: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    error: (m) => logs.push(m),
  };
  const template = baseConfig.bots[0]!;
  const agent = new BotAgent(
    { ...template, ...overrides, username },
    { host: server.host, port: server.port, version: false, staggerMs: 0 },
    { logger, ...extra },
  );
  return { agent, logs };
}

/**
 * Prepare a flat night-time world with no natural mob spawns and no natural healing, so fights
 * are deterministic and a wounded bot stays wounded. Mob griefing is off so creeper explosions
 * don't leave craters that pile up over many trials and trap the bot or the mob in a pit.
 */
export async function calmNight(server: TestServer): Promise<void> {
  await server.run('gamerule advance_time false');
  await server.run('time set night');
  await server.run('gamerule natural_health_regeneration false');
  await server.run('gamerule mob_griefing false');
  // `spawn-monsters=false` in server.properties is not honored on this version (slimes appeared
  // mid-trial on the flat world); the gamerule is.
  await server.run('gamerule spawn_mobs false');
}
