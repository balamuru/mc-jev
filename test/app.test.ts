import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';
import { answers, scriptedClient } from './jevFixtures.js';
import { FakeActuator, FakeBot } from './fakeBot.js';

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 8, 24, 12, 0, 0) }));
afterEach(() => vi.useRealTimers());

const raw = () => JSON.parse(readFileSync('config/default.json', 'utf8'));
const quiet = { info() {}, warn() {}, error() {} };

function build(mutate: (r: ReturnType<typeof raw>) => void = () => {}, jevReply = () => answers()) {
  const r = raw();
  r.debug.decisionLogDir = '';
  r.debug.snapshotIntervalMs = 0;
  mutate(r);
  const config = parseConfig(r);
  const bots: Array<{ name: string; bot: FakeBot }> = [];
  const { client, requests } = scriptedClient(jevReply);
  const app = buildApp(config, {
    jevClient: client,
    log: quiet,
    createBot: (_server, botConfig) => {
      const bot = new FakeBot().equipIron();
      bots.push({ name: botConfig.username, bot });
      return { bot, actuator: new FakeActuator() };
    },
  });
  return { app, config, bots, requests };
}

const threeBots = (r: ReturnType<typeof raw>) => {
  r.bots = [{ username: 'Alpha' }, { username: 'Bravo' }, { username: 'Charlie' }];
};
const zombie = {
  id: 5,
  type: 'hostile',
  name: 'zombie',
  position: { x: 0, y: 64, z: -5 },
  velocity: { x: 0, y: 0, z: 0 },
};

describe('buildApp', () => {
  it('makes one agent per configured bot, with its own name and settings', () => {
    const { app } = build((r) => {
      r.bots = [
        { username: 'Alpha', role: 'tank' },
        { username: 'Bravo', overrides: { strategic: { intervalMs: 500 } } },
      ];
    });
    expect(app.agents.map((a) => a.config.username)).toEqual(['Alpha', 'Bravo']);
    expect(app.agents[0]!.config.role).toBe('tank');
    expect(app.agents[1]!.config.strategic.intervalMs).toBe(500);
    expect(app.agents[0]!.config.strategic.intervalMs).toBe(2000);
  });

  it('starts the bots one at a time, staggerMs apart', () => {
    const { app, bots } = build((r) => {
      threeBots(r);
      r.server.staggerMs = 1000;
    });
    app.start();
    expect(bots.map((b) => b.name)).toEqual(['Alpha']);
    vi.advanceTimersByTime(999);
    expect(bots).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(bots.map((b) => b.name)).toEqual(['Alpha', 'Bravo']);
    vi.advanceTimersByTime(1000);
    expect(bots.map((b) => b.name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    app.stop();
  });

  it('starts everyone at once with no stagger', () => {
    const { app, bots } = build((r) => {
      threeBots(r);
      r.server.staggerMs = 0;
    });
    app.start();
    expect(bots).toHaveLength(1); // the first one straight away
    vi.advanceTimersByTime(1);
    expect(bots).toHaveLength(3);
    app.stop();
  });

  it('does not start bots that had not started yet when it is stopped', () => {
    const { app, bots } = build((r) => {
      threeBots(r);
      r.server.staggerMs = 1000;
    });
    app.start();
    app.stop();
    vi.advanceTimersByTime(10_000);
    expect(bots.map((b) => b.name)).toEqual(['Alpha']);
  });

  it('shares one Jev rate limit and budget across all bots', async () => {
    const { app, bots, requests } = build((r) => {
      threeBots(r);
      r.server.staggerMs = 0;
      r.gateway.maxCallsPerMinute = 2;
      r.swarm.mode = 'independent';
    });
    app.start();
    vi.advanceTimersByTime(1);
    for (const { bot } of bots) {
      bot.emit('spawn');
      bot.entities['5'] = zombie;
      bot.emit('physicsTick');
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(requests).toHaveLength(2); // three bots asked, the shared limit let two through
    expect(app.gateway.stats().calls).toBe(2);
    app.stop();
  });

  it('lets every bot make its own decisions in independent mode', async () => {
    const { app, bots } = build((r) => {
      threeBots(r);
      r.server.staggerMs = 0;
      r.swarm.mode = 'independent';
    });
    app.start();
    vi.advanceTimersByTime(1);
    for (const { bot } of bots) {
      bot.emit('spawn');
      bot.entities['5'] = zombie;
      bot.emit('physicsTick');
      bot.emit('physicsTick');
    }
    expect(app.agents.map((a) => a.intent.targetId)).toEqual([5, 5, 5]); // independent: all pick the same
    expect(app.board.allAllies()).toEqual([]);
    app.stop();
  });

  it('puts the bots in a cooperative swarm by default', () => {
    const { app, bots } = build((r) => {
      threeBots(r);
      r.server.staggerMs = 0;
    });
    app.start();
    vi.advanceTimersByTime(1);
    for (const { bot } of bots) {
      bot.emit('spawn');
      bot.emit('physicsTick');
    }
    expect(
      app.board
        .allAllies()
        .map((a) => a.agent)
        .sort(),
    ).toEqual(['Alpha', 'Bravo', 'Charlie']);
    app.stop();
    expect(app.board.allAllies()).toEqual([]); // they left
  });

  it('has a coordinator only in coordinated mode', () => {
    expect(build().app.coordinator).toBeNull();
    expect(build((r) => (r.swarm.mode = 'cooperative')).app.coordinator).toBeNull();
    expect(build((r) => (r.swarm.mode = 'coordinated')).app.coordinator).not.toBeNull();
  });

  it('runs on rules alone when there is no Jev client', () => {
    const r = raw();
    r.debug.decisionLogDir = '';
    const app = buildApp(parseConfig(r), { jevClient: null, log: quiet });
    expect(app.gateway.available).toBe(false);
  });

  it('summarizes Jev usage', async () => {
    const { app, bots } = build((r) => {
      r.server.staggerMs = 0;
    });
    expect(app.usageSummary()).toBe('Jev: 0 calls, 0 failed, $0.00000 spent');
    app.start();
    vi.advanceTimersByTime(1);
    bots[0]!.bot.emit('spawn');
    bots[0]!.bot.entities['5'] = zombie;
    bots[0]!.bot.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(300);
    expect(app.usageSummary()).toMatch(/^Jev: 1 calls, 0 failed, \$0\.0000\d spent$/);
    app.stop();
  });
});
