import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotAgent, type Logger } from '../src/agent/BotAgent.js';
import { parseConfig } from '../src/config.js';
import { JevGateway } from '../src/strategic/gateway.js';
import type { DecisionEntry } from '../src/telemetry/decisionLog.js';
import { answers, scriptedClient } from './jevFixtures.js';
import { FakeActuator, FakeBot } from './fakeBot.js';

const config = parseConfig(JSON.parse(readFileSync('config/default.json', 'utf8')));
const botConfig = config.bots[0]!;

function setup(
  extra: { snapshotIntervalMs?: number; onSnapshot?: () => void } = {},
  cfg = botConfig,
) {
  const bots: FakeBot[] = [];
  const actuators: FakeActuator[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  };
  const agent = new BotAgent(cfg, config.server, {
    logger,
    reconnect: { baseMs: 1000, maxMs: 4000 },
    createBot: () => {
      const b = new FakeBot();
      bots.push(b);
      const actuator = new FakeActuator();
      actuators.push(actuator);
      return { bot: b, actuator };
    },
    ...extra,
  });
  return { agent, bots, actuators, logs };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('BotAgent connection', () => {
  it('connects on start and goes online on spawn', () => {
    const { agent, bots } = setup();
    expect(agent.state).toBe('idle');
    agent.start();
    expect(agent.state).toBe('connecting');
    expect(bots).toHaveLength(1);
    bots[0]!.emit('spawn');
    expect(agent.state).toBe('online');
  });

  it('ignores a second start while running', () => {
    const { agent, bots } = setup();
    agent.start();
    agent.start();
    expect(bots).toHaveLength(1);
  });

  it('reconnects with exponential backoff, capped, and resets after a spawn', () => {
    const { agent, bots, logs } = setup();
    agent.start();

    bots[0]!.emit('end', 'socketClosed');
    expect(agent.state).toBe('reconnecting');
    vi.advanceTimersByTime(999);
    expect(bots).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(bots).toHaveLength(2);

    bots[1]!.emit('end'); // 2nd failure: 2000ms
    vi.advanceTimersByTime(1999);
    expect(bots).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(bots).toHaveLength(3);

    bots[2]!.emit('end'); // 3rd failure: 4000ms (cap)
    vi.advanceTimersByTime(4000);
    expect(bots).toHaveLength(4);
    bots[3]!.emit('end'); // 4th failure: still capped at 4000ms
    vi.advanceTimersByTime(4000);
    expect(bots).toHaveLength(5);

    bots[4]!.emit('spawn');
    bots[4]!.emit('end'); // after a successful spawn the delay resets to 1000ms
    vi.advanceTimersByTime(1000);
    expect(bots).toHaveLength(6);
    expect(logs).toContain('info [JevBot] reconnecting in 1000ms');
  });

  it('schedules only one reconnect when error and end both fire', () => {
    const { agent, bots } = setup();
    agent.start();
    bots[0]!.emit('error', new Error('ECONNREFUSED'));
    bots[0]!.emit('end');
    bots[0]!.emit('end');
    vi.advanceTimersByTime(60_000);
    expect(bots).toHaveLength(2);
  });

  it('logs kicks and errors without throwing', () => {
    const { agent, bots, logs } = setup();
    agent.start();
    expect(() => bots[0]!.emit('error', new Error('boom'))).not.toThrow();
    bots[0]!.emit('kicked', 'You are banned');
    expect(logs).toContain('error [JevBot] boom');
    expect(logs).toContain('warn [JevBot] kicked: You are banned');
  });

  it('retries when the bot cannot be created', () => {
    let calls = 0;
    const agent = new BotAgent(botConfig, config.server, {
      logger: { info() {}, warn() {}, error() {} },
      reconnect: { baseMs: 500, maxMs: 500 },
      createBot: () => {
        calls++;
        if (calls === 1) throw new Error('bad options');
        return { bot: new FakeBot(), actuator: new FakeActuator() };
      },
    });
    agent.start();
    expect(agent.state).toBe('reconnecting');
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
  });

  it('stops cleanly: quits the bot, cancels reconnects, and ignores late events', () => {
    const { agent, bots } = setup();
    agent.start();
    bots[0]!.emit('spawn');
    agent.stop();
    expect(agent.state).toBe('stopped');
    expect(bots[0]!.quit).toHaveBeenCalledTimes(1);
    expect(() => bots[0]!.emit('error', new Error('late'))).not.toThrow();
    vi.advanceTimersByTime(60_000);
    expect(bots).toHaveLength(1);
  });

  it('cancels a pending reconnect on stop', () => {
    const { agent, bots } = setup();
    agent.start();
    bots[0]!.emit('end');
    agent.stop();
    vi.advanceTimersByTime(60_000);
    expect(bots).toHaveLength(1);
  });

  it('can be started again after stop', () => {
    const { agent, bots } = setup();
    agent.start();
    agent.stop();
    agent.start();
    expect(bots).toHaveLength(2);
  });
});

describe('BotAgent snapshots', () => {
  it('returns null until spawned, then a snapshot', () => {
    const { agent, bots } = setup();
    expect(agent.snapshot()).toBeNull();
    agent.start();
    expect(agent.snapshot()).toBeNull();
    bots[0]!.emit('spawn');
    expect(agent.snapshot()?.self.hp).toBe(20);
  });

  it('publishes snapshots at the configured interval, only while online', () => {
    const onSnapshot = vi.fn();
    const { agent, bots } = setup({ snapshotIntervalMs: 1000, onSnapshot });
    agent.start();
    vi.advanceTimersByTime(3000);
    expect(onSnapshot).not.toHaveBeenCalled();

    bots[0]!.emit('spawn');
    vi.advanceTimersByTime(3000);
    expect(onSnapshot).toHaveBeenCalledTimes(3);
    expect(onSnapshot.mock.calls[0]![1]).toBe(agent);

    bots[0]!.emit('end');
    vi.advanceTimersByTime(500); // still reconnecting
    onSnapshot.mockClear();
    vi.advanceTimersByTime(400);
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('does not publish when the interval is 0', () => {
    const onSnapshot = vi.fn();
    const { agent, bots } = setup({ snapshotIntervalMs: 0, onSnapshot });
    agent.start();
    bots[0]!.emit('spawn');
    vi.advanceTimersByTime(10_000);
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('survives a throwing snapshot handler', () => {
    const onSnapshot = vi.fn(() => {
      throw new Error('handler bug');
    });
    const { agent, bots, logs } = setup({ snapshotIntervalMs: 1000, onSnapshot });
    agent.start();
    bots[0]!.emit('spawn');
    vi.advanceTimersByTime(2000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(logs).toContain('error [JevBot] snapshot handler failed: handler bug');
    expect(agent.state).toBe('online');
  });

  it('stops publishing after stop', () => {
    const onSnapshot = vi.fn();
    const { agent, bots } = setup({ snapshotIntervalMs: 1000, onSnapshot });
    agent.start();
    bots[0]!.emit('spawn');
    agent.stop();
    vi.advanceTimersByTime(5000);
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

const zombieAt = (id: number, z: number) => ({
  id,
  type: 'hostile',
  name: 'zombie',
  position: { x: 0, y: 64, z },
  velocity: { x: 0, y: 0, z: 0 },
});

describe('BotAgent reflex', () => {
  it('starts idle and engages a hostile on the next game tick', () => {
    const { agent, bots, actuators, logs } = setup();
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    expect(agent.intent.tactic).toBe('idle');

    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    expect(agent.intent).toMatchObject({ tactic: 'engage', targetId: 5 });
    expect(actuators[0]!.calls).toEqual(['engage 5']);
    expect(logs).toContain('info [JevBot] intent idle -> engage: fighting zombie');
  });

  it('runs at the configured tick rate', () => {
    const cfg = { ...botConfig, reflex: { ...botConfig.reflex, everyTicks: 5 } };
    const { agent, bots, actuators } = setup({}, cfg);
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    for (let i = 0; i < 4; i++) bots[0]!.emit('physicsTick');
    expect(actuators[0]!.calls).toEqual([]);
    bots[0]!.emit('physicsTick');
    expect(actuators[0]!.calls).toEqual(['engage 5']);
  });

  it('retreats when HP is low, if retreating is switched on', () => {
    const cfg = { ...botConfig, rules: { ...botConfig.rules, retreat: true } };
    const { agent, bots, actuators } = setup({}, cfg);
    agent.start();
    bots[0]!.emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.health = 4;
    bots[0]!.emit('physicsTick');
    expect(agent.intent.tactic).toBe('retreat');
    expect(actuators[0]!.calls).toEqual(['retreat 5']);
  });

  it('does nothing when the reflex layer is disabled', () => {
    const cfg = { ...botConfig, reflex: { ...botConfig.reflex, enabled: false } };
    const { agent, bots, actuators } = setup({}, cfg);
    agent.start();
    bots[0]!.emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    expect(actuators[0]!.calls).toEqual([]);
    expect(agent.intent.tactic).toBe('idle');
  });

  it('stops acting on death and resets its intent', () => {
    const { agent, bots, actuators } = setup();
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    bots[0]!.emit('death');
    expect(actuators[0]!.calls).toEqual(['engage 5', 'stop']);
    expect(agent.intent.tactic).toBe('idle');
  });

  it('stops acting on disconnect and starts fresh on the new connection', () => {
    const { agent, bots, actuators } = setup();
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    bots[0]!.emit('end');
    expect(actuators[0]!.calls).toEqual(['engage 5', 'stop']);
    expect(agent.intent.tactic).toBe('idle');

    vi.advanceTimersByTime(1000);
    bots[1]!.emit('spawn');
    bots[1]!.emit('physicsTick');
    expect(actuators[1]!.calls).toEqual([]);
  });

  it('stops the actuator when the agent stops', () => {
    const { agent, bots, actuators } = setup();
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    agent.stop();
    expect(actuators[0]!.calls).toEqual(['engage 5', 'stop']);
  });
});

describe('BotAgent deaths', () => {
  it('counts deaths, with or without the reflex layer', () => {
    for (const enabled of [true, false]) {
      const cfg = { ...botConfig, reflex: { ...botConfig.reflex, enabled } };
      const { agent, bots } = setup({}, cfg);
      agent.start();
      bots[0]!.emit('spawn');
      expect(agent.deaths).toBe(0);
      bots[0]!.emit('death');
      bots[0]!.emit('spawn');
      bots[0]!.emit('death');
      expect(agent.deaths).toBe(2);
    }
  });
});

describe('BotAgent with Jev', () => {
  function withJev(reply: Parameters<typeof scriptedClient>[0], cfg = botConfig, gatewayOn = true) {
    const { client, requests } = scriptedClient(reply);
    const gateway = new JevGateway({
      client,
      limits: { maxCallsPerMinute: 1000, dailyBudgetUsd: 1 },
    });
    const entries: DecisionEntry[] = [];
    const bots: FakeBot[] = [];
    const actuators: FakeActuator[] = [];
    const agent = new BotAgent(cfg, config.server, {
      logger: { info() {}, warn() {}, error() {} },
      gateway: gatewayOn ? gateway : undefined,
      decisions: { write: (e) => void entries.push(e) },
      createBot: () => {
        const b = new FakeBot();
        bots.push(b);
        const actuator = new FakeActuator();
        actuators.push(actuator);
        return { bot: b, actuator };
      },
    });
    return { agent, bots, actuators, requests, entries };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('lets Jev turn a fight into a retreat, then lets the rules resume when it expires', async () => {
    const cfg = { ...botConfig, rules: { ...botConfig.rules, retreat: true } };
    const { agent, bots, actuators, requests, entries } = withJev(
      () => answers({ tactic: 'retreat', tacticConfidence: 0.9 }),
      cfg,
    );
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);

    bots[0]!.emit('physicsTick'); // the rules alone would engage here
    expect(actuators[0]!.calls).toEqual(['engage 5']);
    await flush(); // Jev's answer arrives
    expect(requests).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'applied', agent: 'JevBot' });

    bots[0]!.emit('physicsTick');
    expect(agent.intent).toMatchObject({ tactic: 'retreat', targetId: 5 });
    expect(agent.intent.reason).toContain('jev: retreat');
    expect(actuators[0]!.calls).toEqual(['engage 5', 'retreat 5']);

    // The override lasts 1.5 intervals (3000ms = 60 ticks); after that the rules take over again.
    for (let i = 0; i < 65; i++) bots[0]!.emit('physicsTick');
    expect(agent.intent.tactic).toBe('engage');
  });

  it('ignores Jev’s advice to retreat with the shipped default of retreating off', async () => {
    const { agent, bots, requests, entries } = withJev(() =>
      answers({ tactic: 'retreat', tacticConfidence: 0.99 }),
    );
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    await flush();
    bots[0]!.emit('physicsTick');
    expect(requests).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'rules' });
    expect(agent.intent.tactic).toBe('engage');
  });

  it('runs on rules alone with no gateway, or with the strategic layer switched off', async () => {
    for (const [cfg, gateway] of [
      [botConfig, false],
      [{ ...botConfig, strategic: { ...botConfig.strategic, enabled: false } }, true],
    ] as const) {
      const { agent, bots, requests } = withJev(() => answers(), cfg, gateway);
      agent.start();
      bots[0]!.equipIron().emit('spawn');
      bots[0]!.entities['5'] = zombieAt(5, -6);
      bots[0]!.emit('physicsTick');
      await vi.advanceTimersByTimeAsync(5000);
      expect(requests).toHaveLength(0);
      expect(agent.intent.tactic).toBe('engage');
    }
  });

  it('keeps fighting by the rules when Jev is down', async () => {
    const { agent, bots, requests, entries } = withJev(() => new Error('network down'));
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    await flush();
    bots[0]!.emit('physicsTick');
    expect(requests).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'error' });
    expect(agent.intent.tactic).toBe('engage');
  });

  it('stops asking Jev when the connection drops or the agent stops', async () => {
    const { agent, bots, requests } = withJev(() => answers());
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    await flush();
    expect(requests).toHaveLength(1);
    bots[0]!.emit('end');
    await vi.advanceTimersByTimeAsync(1500);
    expect(requests).toHaveLength(1);
    agent.stop();
  });
});

describe('BotAgent chat commands', () => {
  const ownerCfg = { ...botConfig, owner: 'Boss' };
  const playerAt = (id: number, name: string, z: number) => ({
    id,
    type: 'player',
    username: name,
    position: { x: 0, y: 64, z },
    velocity: { x: 0, y: 0, z: 0 },
  });

  function online(cfg: typeof botConfig = ownerCfg) {
    const s = setup({}, cfg);
    s.agent.start();
    s.bots[0]!.equipIron().emit('spawn');
    s.bots[0]!.entities['90'] = playerAt(90, 'Boss', -8);
    return s;
  }

  it('starts in its configured default mode', () => {
    expect(online().agent.mode).toEqual({ name: 'guard' });
    expect(online({ ...ownerCfg, mode: 'hunt' }).agent.mode).toEqual({ name: 'hunt' });
  });

  it('follows the owner on command and confirms in chat', () => {
    const { agent, bots, actuators } = online();
    bots[0]!.emit('chat', 'Boss', 'follow me');
    expect(agent.mode.name).toBe('follow');
    expect(bots[0]!.chat).toHaveBeenCalledWith('following you');
    bots[0]!.emit('physicsTick');
    expect(actuators[0]!.calls).toEqual(['follow 90']);
    expect(agent.intent).toMatchObject({ tactic: 'follow', targetId: 90 });
  });

  it('accepts commands sent by whisper, and commands that name it', () => {
    const { agent, bots } = online();
    bots[0]!.emit('whisper', 'Boss', 'hunt');
    expect(agent.mode.name).toBe('hunt');
    bots[0]!.emit('chat', 'Boss', 'JevBot: follow');
    expect(agent.mode.name).toBe('follow');
  });

  it('holds a post at its current position', () => {
    const { agent, bots } = online();
    bots[0]!.entity.position = { x: 5, y: 64, z: 6 };
    bots[0]!.emit('chat', 'Boss', 'guard here');
    expect(agent.mode).toEqual({ name: 'guard', anchor: { x: 5, y: 64, z: 6 } });
    expect(bots[0]!.chat).toHaveBeenCalledWith('guarding this spot (5, 64, 6)');
  });

  it('stands down: stops fighting and stops asking Jev, until told to resume', async () => {
    const { client, requests } = scriptedClient(() => answers());
    const gateway = new JevGateway({
      client,
      limits: { maxCallsPerMinute: 1000, dailyBudgetUsd: 1 },
    });
    const bots: FakeBot[] = [];
    const actuators: FakeActuator[] = [];
    const agent = new BotAgent(ownerCfg, config.server, {
      logger: { info() {}, warn() {}, error() {} },
      gateway,
      createBot: () => {
        const b = new FakeBot();
        bots.push(b);
        const actuator = new FakeActuator();
        actuators.push(actuator);
        return { bot: b, actuator };
      },
    });
    agent.start();
    bots[0]!.equipIron().emit('spawn');
    bots[0]!.emit('chat', 'Boss', 'stop');
    bots[0]!.entities['5'] = zombieAt(5, -3);
    for (let i = 0; i < 3; i++) bots[0]!.emit('physicsTick');
    await vi.advanceTimersByTimeAsync(5000);
    expect(actuators[0]!.calls).toEqual([]);
    expect(agent.intent.tactic).toBe('idle');
    expect(requests).toHaveLength(0);

    bots[0]!.emit('chat', 'Boss', 'auto');
    bots[0]!.emit('physicsTick');
    expect(agent.intent).toMatchObject({ tactic: 'engage', targetId: 5 });
    await vi.advanceTimersByTimeAsync(300);
    expect(requests.length).toBeGreaterThan(0);
  });

  it('reports its status and lists its commands', () => {
    const { bots } = online();
    bots[0]!.emit('chat', 'Boss', 'status');
    expect(bots[0]!.chat).toHaveBeenLastCalledWith(
      expect.stringMatching(/^mode guard; hp 20\/20, food 20; no hostiles near$/),
    );
    bots[0]!.emit('chat', 'Boss', 'help');
    expect(bots[0]!.chat).toHaveBeenLastCalledWith(expect.stringContaining('guard here'));
  });

  it('obeys only its owner', () => {
    const { agent, bots } = online();
    bots[0]!.emit('chat', 'Stranger', 'follow me');
    bots[0]!.emit('chat', 'Stranger', 'stop');
    bots[0]!.emit('whisper', 'Stranger', 'hunt');
    expect(agent.mode.name).toBe('guard');
    expect(bots[0]!.chat).not.toHaveBeenCalled();
  });

  it('accepts the owner’s name in any case', () => {
    const { agent, bots } = online();
    bots[0]!.emit('chat', 'BOSS', 'hunt');
    expect(agent.mode.name).toBe('hunt');
  });

  it('obeys nobody when it has no owner', () => {
    const { agent, bots } = online({ ...botConfig, owner: undefined });
    bots[0]!.emit('chat', 'Boss', 'stop');
    expect(agent.mode.name).toBe('guard');
    expect(bots[0]!.chat).not.toHaveBeenCalled();
  });

  it('ignores ordinary chat, commands for other bots, and its own words', () => {
    const { agent, bots } = online();
    bots[0]!.emit('chat', 'Boss', 'nice weather today');
    bots[0]!.emit('chat', 'Boss', 'OtherBot stop');
    bots[0]!.emit('chat', 'JevBot', 'stop'); // its own username
    expect(agent.mode.name).toBe('guard');
    expect(bots[0]!.chat).not.toHaveBeenCalled();
  });

  it('forgets its orders when the connection is lost', () => {
    const { agent, bots } = online();
    bots[0]!.emit('chat', 'Boss', 'stop');
    bots[0]!.emit('end');
    expect(agent.mode).toEqual({ name: 'guard' }); // the configured default until it reconnects
    expect(() => bots[0]!.emit('chat', 'Boss', 'follow')).not.toThrow();
  });
});
