import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.js';

const base = () => JSON.parse(readFileSync('config/default.json', 'utf8'));

describe('config', () => {
  it('loads the shipped default config', () => {
    const cfg = loadConfig({});
    expect(cfg.bots).toHaveLength(1);
    expect(cfg.bots[0]).toMatchObject({
      username: 'JevBot',
      role: 'fighter',
      reflex: { everyTicks: 1 },
      strategic: { intervalMs: 2000 },
      jev: { model: 'jev-latest' },
    });
  });

  it('applies per-bot overrides on top of defaults, including nested thresholds', () => {
    const raw = base();
    raw.bots = [
      { username: 'Alpha' },
      {
        username: 'Bravo',
        role: 'ranged',
        overrides: {
          reflex: { everyTicks: 2 },
          strategic: { intervalMs: 500 },
          jev: { thresholds: { act: 0.9 } },
        },
      },
    ];
    const [alpha, bravo] = parseConfig(raw).bots;
    expect(alpha?.strategic.intervalMs).toBe(2000);
    expect(bravo?.reflex.everyTicks).toBe(2);
    expect(bravo?.strategic.intervalMs).toBe(500);
    expect(bravo?.strategic.minGapMs).toBe(250);
    expect(bravo?.jev.thresholds).toEqual({ act: 0.9, cautious: 0.5 });
    expect(bravo?.role).toBe('ranged');
  });

  it('rejects an override that breaks an invariant', () => {
    const raw = base();
    raw.bots = [{ username: 'Alpha', overrides: { jev: { thresholds: { act: 0.3 } } } }];
    expect(() => parseConfig(raw)).toThrow(/cautious must be <= act/);
  });

  it('rejects invalid tick settings', () => {
    const raw = base();
    raw.defaults.reflex.everyTicks = 0;
    expect(() => parseConfig(raw)).toThrow(/Invalid config/);
  });

  it('rejects duplicate and invalid usernames', () => {
    const raw = base();
    raw.bots = [{ username: 'Alpha' }, { username: 'alpha' }];
    expect(() => parseConfig(raw)).toThrow(/duplicate bot username/);
    raw.bots = [{ username: 'no spaces allowed' }];
    expect(() => parseConfig(raw)).toThrow(/usernames/);
  });

  it('reads server and Jev API settings from the environment', () => {
    const cfg = parseConfig(base(), {
      MC_HOST: 'mc.local',
      MC_PORT: '25570',
      TYPESAFE_API_KEY: 'sk-test',
      TYPESAFE_BASE_URL: 'https://openrouter.ai/api',
    });
    expect(cfg.server).toMatchObject({ host: 'mc.local', port: 25570 });
    expect(cfg.jevApi).toEqual({ apiKey: 'sk-test', baseURL: 'https://openrouter.ai/api' });
  });

  it('treats an empty API key as missing', () => {
    expect(parseConfig(base(), { TYPESAFE_API_KEY: '' }).jevApi.apiKey).toBeUndefined();
  });
});

describe('perception and debug settings', () => {
  it('has perception defaults that disable visibility filtering', () => {
    const [bot] = parseConfig(base()).bots;
    expect(bot?.perception).toEqual({
      radiusBlocks: 24,
      maxEntities: 8,
      fovDegrees: 360,
      requireLineOfSight: false,
    });
    expect(parseConfig(base()).debug.snapshotIntervalMs).toBe(1000);
  });

  it('lets a bot override perception settings individually', () => {
    const raw = base();
    raw.bots = [{ username: 'Scout', overrides: { perception: { fovDegrees: 120 } } }];
    const [bot] = parseConfig(raw).bots;
    expect(bot?.perception).toMatchObject({ fovDegrees: 120, radiusBlocks: 24 });
  });

  it('rejects an out-of-range field of view', () => {
    const raw = base();
    raw.defaults.perception.fovDegrees = 10;
    expect(() => parseConfig(raw)).toThrow(/Invalid config/);
  });
});

describe('reflex and rules settings', () => {
  it('has defaults', () => {
    const [bot] = parseConfig(base()).bots;
    expect(bot?.reflex).toEqual({ enabled: true, everyTicks: 1 });
    expect(bot?.rules).toEqual({
      retreatHp: 6,
      resumeHp: 14,
      engageRadiusBlocks: 16,
      eatBelowFood: 15,
    });
  });

  it('lets a bot override rules individually', () => {
    const raw = base();
    raw.bots = [
      { username: 'Brave', overrides: { rules: { retreatHp: 2 }, reflex: { enabled: false } } },
    ];
    const [bot] = parseConfig(raw).bots;
    expect(bot?.rules).toMatchObject({ retreatHp: 2, resumeHp: 14 });
    expect(bot?.reflex.enabled).toBe(false);
  });

  it('rejects a retreat HP above the resume HP', () => {
    const raw = base();
    raw.bots = [{ username: 'Odd', overrides: { rules: { retreatHp: 15 } } }];
    expect(() => parseConfig(raw)).toThrow(/retreatHp must be <= resumeHp/);
  });
});
