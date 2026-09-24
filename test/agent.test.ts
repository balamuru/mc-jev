import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotAgent, type Logger } from '../src/agent/BotAgent.js';
import { parseConfig } from '../src/config.js';
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
    bots[0]!.emit('spawn');
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
    bots[0]!.emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    for (let i = 0; i < 4; i++) bots[0]!.emit('physicsTick');
    expect(actuators[0]!.calls).toEqual([]);
    bots[0]!.emit('physicsTick');
    expect(actuators[0]!.calls).toEqual(['engage 5']);
  });

  it('retreats when HP is low', () => {
    const { agent, bots, actuators } = setup();
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
    bots[0]!.emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    bots[0]!.emit('death');
    expect(actuators[0]!.calls).toEqual(['engage 5', 'stop']);
    expect(agent.intent.tactic).toBe('idle');
  });

  it('stops acting on disconnect and starts fresh on the new connection', () => {
    const { agent, bots, actuators } = setup();
    agent.start();
    bots[0]!.emit('spawn');
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
    bots[0]!.emit('spawn');
    bots[0]!.entities['5'] = zombieAt(5, -6);
    bots[0]!.emit('physicsTick');
    agent.stop();
    expect(actuators[0]!.calls).toEqual(['engage 5', 'stop']);
  });
});
