import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig, protectedFor } from '../src/config.js';

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
      pvp: true,
      shield: false,
      strafeMobs: false,
      bow: true,
      bowMinBlocks: 6,
      bowMaxBlocks: 20,
      retreat: false,
      retreatHp: 6,
      resumeHp: 14,
      engageRadiusBlocks: 16,
      eatBelowFood: 15,
      noEatRadiusBlocks: 10,
      dangerMargin: 0.8,
      retreatCheckMs: 2000,
      retreatMinGainBlocks: 1.5,
      fightBackMs: 4000,
    });
  });

  it('lets a bot turn retreating on for itself', () => {
    const raw = base();
    raw.bots = [{ username: 'Careful', overrides: { rules: { retreat: true } } }];
    expect(parseConfig(raw).bots[0]?.rules.retreat).toBe(true);
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

describe('strategic and decision-log settings', () => {
  it('has defaults', () => {
    const cfg = parseConfig(base());
    expect(cfg.bots[0]?.strategic).toEqual({
      enabled: true,
      intervalMs: 2000,
      eventTriggers: ['hurt', 'newThreat', 'lowHp'],
      minGapMs: 250,
    });
    expect(cfg.debug.decisionLogDir).toBe('logs');
  });

  it('lets a bot turn Jev off, or decide more often, on its own', () => {
    const raw = base();
    raw.bots = [
      { username: 'Rules', overrides: { strategic: { enabled: false } } },
      { username: 'Quick', overrides: { strategic: { intervalMs: 500 } } },
    ];
    const [rulesOnly, quick] = parseConfig(raw).bots;
    expect(rulesOnly?.strategic.enabled).toBe(false);
    expect(quick?.strategic).toMatchObject({ enabled: true, intervalMs: 500 });
  });

  it('accepts an empty decision log directory to turn logging off', () => {
    const raw = base();
    raw.debug.decisionLogDir = '';
    expect(parseConfig(raw).debug.decisionLogDir).toBe('');
  });
});

describe('bot modes and owners', () => {
  it('defaults to guard mode with no owner', () => {
    const bot = parseConfig(base()).bots[0];
    expect(bot?.mode).toBe('guard');
    expect(bot?.owner).toBeUndefined();
  });

  it('accepts guard, hunt and idle, per bot', () => {
    const raw = base();
    raw.bots = [
      { username: 'Alpha', owner: 'Boss', mode: 'hunt' },
      { username: 'Bravo', mode: 'idle' },
    ];
    const [alpha, bravo] = parseConfig(raw).bots;
    expect(alpha).toMatchObject({ mode: 'hunt', owner: 'Boss' });
    expect(bravo?.mode).toBe('idle');
  });

  it('rejects a mode that a bot cannot start in', () => {
    const raw = base();
    raw.bots = [{ username: 'Alpha', mode: 'follow' }];
    expect(() => parseConfig(raw)).toThrow(/Invalid config/);
  });
});

describe('allies, protected players and pvp', () => {
  it('protects the owner, the allies and every bot in the config, without duplicates', () => {
    const raw = base();
    raw.bots = [
      { username: 'Alpha', owner: 'Boss', allies: ['Friend', 'boss'] },
      { username: 'Bravo' },
    ];
    const [alpha, bravo] = parseConfig(raw).bots;
    expect(alpha?.protectedPlayers.map((n) => n.toLowerCase()).sort()).toEqual([
      'alpha',
      'boss',
      'bravo',
      'friend',
    ]);
    expect(bravo?.protectedPlayers.map((n) => n.toLowerCase()).sort()).toEqual(['alpha', 'bravo']);
  });

  it('always protects at least the bot’s own swarm', () => {
    expect(parseConfig(base()).bots[0]?.protectedPlayers).toEqual(['JevBot']);
  });

  it('defaults to fighting back, and lets a bot switch that off', () => {
    const raw = base();
    raw.bots = [{ username: 'Pacifist', overrides: { rules: { pvp: false } } }];
    expect(parseConfig(raw).bots[0]?.rules.pvp).toBe(false);
    expect(parseConfig(base()).bots[0]?.rules.pvp).toBe(true);
  });
});

describe('protectedFor', () => {
  it('always includes the owner, however the list was built', () => {
    expect(protectedFor({ owner: 'Boss', protectedPlayers: ['JevBot'] })).toEqual([
      'Boss',
      'JevBot',
    ]);
    expect(protectedFor({ owner: 'Boss', protectedPlayers: ['Boss', 'Pal'] })).toEqual([
      'Boss',
      'Pal',
    ]);
    expect(protectedFor({ owner: undefined, protectedPlayers: ['Pal'] })).toEqual(['Pal']);
  });
});

describe('swarm and server stagger settings', () => {
  it('has defaults: cooperative bots, started a second apart', () => {
    const cfg = parseConfig(base());
    expect(cfg.swarm).toEqual({
      mode: 'cooperative',
      claimTtlMs: 8000,
      helpHp: 8,
      helpAllies: true,
      coordinator: { intervalMs: 4000, directiveTtlMs: 6000, model: 'jev-latest', timeoutMs: 1500 },
    });
    expect(cfg.server.staggerMs).toBe(1000);
  });

  it('accepts the three swarm modes and rejects anything else', () => {
    for (const mode of ['independent', 'cooperative', 'coordinated']) {
      const raw = base();
      raw.swarm.mode = mode;
      expect(parseConfig(raw).swarm.mode).toBe(mode);
    }
    const raw = base();
    raw.swarm.mode = 'anarchy';
    expect(() => parseConfig(raw)).toThrow(/Invalid config/);
  });

  it('rejects a claim lifetime that is too short to be useful', () => {
    const raw = base();
    raw.swarm.claimTtlMs = 100;
    expect(() => parseConfig(raw)).toThrow(/Invalid config/);
  });

  it('protects every bot in the swarm from every other', () => {
    const raw = base();
    raw.bots = [{ username: 'One' }, { username: 'Two' }, { username: 'Three' }];
    for (const bot of parseConfig(raw).bots) {
      expect(bot.protectedPlayers.sort()).toEqual(['One', 'Three', 'Two']);
    }
  });
});

describe('bow settings', () => {
  it('rejects a minimum bow range that is not below the maximum', () => {
    const raw = base();
    raw.defaults.rules.bowMinBlocks = 20;
    expect(() => parseConfig(raw)).toThrow(/bowMinBlocks must be < bowMaxBlocks/);
  });

  it('lets a bot turn the bow off or change its range', () => {
    const raw = base();
    raw.bots = [{ username: 'Melee', overrides: { rules: { bow: false, bowMaxBlocks: 12 } } }];
    expect(parseConfig(raw).bots[0]?.rules).toMatchObject({
      bow: false,
      bowMinBlocks: 6,
      bowMaxBlocks: 12,
    });
  });
});
