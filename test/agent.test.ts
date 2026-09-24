import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotAgent, type Logger } from '../src/agent/BotAgent.js';
import { parseConfig } from '../src/config.js';
import { FakeBot } from './fakeBot.js';

const config = parseConfig(JSON.parse(readFileSync('config/default.json', 'utf8')));
const botConfig = config.bots[0]!;

function setup(extra: { snapshotIntervalMs?: number; onSnapshot?: () => void } = {}) {
  const bots: FakeBot[] = [];
  const logs: string[] = [];
  const logger: Logger = {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  };
  const agent = new BotAgent(botConfig, config.server, {
    logger,
    reconnect: { baseMs: 1000, maxMs: 4000 },
    createBot: () => {
      const b = new FakeBot();
      bots.push(b);
      return b;
    },
    ...extra,
  });
  return { agent, bots, logs };
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
        return new FakeBot();
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
