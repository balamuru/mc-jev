import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonlDecisionLog, type DecisionEntry } from '../src/telemetry/decisionLog.js';

const entry = (over: Partial<DecisionEntry> = {}): DecisionEntry => ({
  time: '2026-09-24T12:00:00.000Z',
  agent: 'Bot',
  trigger: 'interval',
  questionSet: 'v1',
  outcome: 'applied',
  why: 'jev voted to retreat',
  situation: 'hp 20',
  ...over,
});

describe('JsonlDecisionLog', () => {
  it('appends one JSON object per line to a file named after the day', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'mcjev-')), 'nested', 'logs');
    const log = new JsonlDecisionLog(dir);
    log.write(entry());
    log.write(entry({ trigger: 'event:hurt', time: '2026-09-24T12:00:01.000Z' }));
    log.write(entry({ time: '2026-09-25T00:00:00.000Z' }));

    expect(readdirSync(dir).sort()).toEqual([
      'decisions-2026-09-24.jsonl',
      'decisions-2026-09-25.jsonl',
    ]);
    const lines = readFileSync(join(dir, 'decisions-2026-09-24.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ trigger: 'event:hurt', agent: 'Bot' });
  });

  it('never throws; it reports a problem and keeps going', () => {
    const base = mkdtempSync(join(tmpdir(), 'mcjev-'));
    const blocker = join(base, 'file');
    writeFileSync(blocker, 'not a directory');
    const onError = vi.fn();
    const log = new JsonlDecisionLog(join(blocker, 'logs'), onError);
    expect(() => log.write(entry())).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatch(/could not write decision log/);
  });
});
