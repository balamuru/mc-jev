import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Game physics runs at a fixed 20 Hz; reflex timing is expressed in game ticks. */
export const GAME_TICK_MS = 50;

const reflexSchema = z.object({
  /** Turn the reflex layer off to make a bot observe-only. */
  enabled: z.boolean(),
  /** Run the reflex layer every N game ticks (1 = every 50ms). */
  everyTicks: z.number().int().min(1).max(20),
});

/** Deterministic combat and survival rules. They are also the fallback when Jev is unavailable. */
const rulesBaseSchema = z.object({
  /** Fight back against players who attack the bot (or that Jev judges to be a threat). Off: never fight players. */
  pvp: z.boolean(),
  /**
   * Hold up a shield (if one is in the off-hand) between swings and against creepers and archers.
   * Off by default: it cut creeper damage but slightly lowered survival against groups of zombies
   * (docs/survival-benchmark.md, Phase 8).
   */
  shield: z.boolean(),
  /** Side-step melee mobs while the weapon recharges. Off by default: no measurable effect. */
  strafeMobs: z.boolean(),
  /** Shoot with a bow (if the bot has one and arrows) at targets between the bow range limits. */
  bow: z.boolean(),
  /** Closer than this, the bot switches to its melee weapon. */
  bowMinBlocks: z.number().min(2).max(64),
  /** Farther than this, the bot closes in before shooting. */
  bowMaxBlocks: z.number().min(2).max(64),
  /**
   * Allow retreating at all. Off by default: with no safe place to run to, the survival benchmark
   * shows a bot that fights on survives more often than one that flees (docs/survival-benchmark.md).
   */
  retreat: z.boolean(),
  /** At or below this many HP (of 20) the bot retreats from hostiles instead of fighting. */
  retreatHp: z.number().min(0).max(20),
  /** After retreating, the bot resumes fighting only once it has regained this many HP. */
  resumeHp: z.number().min(0).max(20),
  /** Hostiles within this many blocks are engaged. */
  engageRadiusBlocks: z.number().min(1).max(64),
  /** Start eating when food falls below this level (of 20). */
  eatBelowFood: z.number().min(0).max(20),
  /** Do not eat while a hostile is within this many blocks: eating slows you and cancels sprinting. */
  noEatRadiusBlocks: z.number().min(0).max(64),
  /** Fight only if the expected damage taken is below this fraction of current HP; otherwise retreat. */
  dangerMargin: z.number().min(0.1).max(2),
  /** A retreat is judged every this many milliseconds... */
  retreatCheckMs: z.number().int().min(250),
  /** ...and has failed if the distance to the threat grew by less than this many blocks. */
  retreatMinGainBlocks: z.number().min(0).max(20),
  /** After a failed retreat, fight back for this long before the rules decide again. */
  fightBackMs: z.number().int().min(0),
});
const rulesSchema = rulesBaseSchema
  .refine((r) => r.retreatHp <= r.resumeHp, { message: 'retreatHp must be <= resumeHp' })
  .refine((r) => r.bowMinBlocks < r.bowMaxBlocks, {
    message: 'bowMinBlocks must be < bowMaxBlocks',
  });

const strategicSchema = z.object({
  /** Ask Jev for decisions. When false (or with no API key) the rules decide alone. */
  enabled: z.boolean(),
  /** Periodic strategic decision interval. */
  intervalMs: z.number().int().min(100),
  /** Events that trigger an immediate strategic decision. */
  eventTriggers: z.array(z.enum(['hurt', 'newThreat', 'lowHp'])),
  /** Minimum gap between two strategic decisions, however triggered. */
  minGapMs: z.number().int().min(0),
});

const thresholdsSchema = z.object({
  /** Confidence at or above which a decision is acted on directly. */
  act: z.number().min(0).max(1),
  /** Confidence at or above which a decision is acted on cautiously; below it, rules take over. */
  cautious: z.number().min(0).max(1),
});

const jevSchema = z.object({
  model: z.string().min(1),
  timeoutMs: z.number().int().min(50),
  maxRetries: z.number().int().min(0).max(3),
  thresholds: thresholdsSchema.refine((t) => t.cautious <= t.act, {
    message: 'cautious must be <= act',
  }),
});

const perceptionSchema = z.object({
  /** Entities farther than this many blocks are ignored. */
  radiusBlocks: z.number().min(1).max(128),
  /** Keep at most this many entities in a snapshot (nearest first). */
  maxEntities: z.number().int().min(1).max(64),
  /** Horizontal field of view in degrees; 360 disables the filter. */
  fovDegrees: z.number().min(30).max(360),
  /** Drop entities the bot has no line of sight to (so it cannot see through walls). */
  requireLineOfSight: z.boolean(),
});

const agentSettingsSchema = z.object({
  perception: perceptionSchema,
  reflex: reflexSchema,
  rules: rulesSchema,
  strategic: strategicSchema,
  jev: jevSchema,
});

/** Limits shared by every bot in the process (enforced by the Jev gateway). */
const gatewaySchema = z.object({
  maxCallsPerMinute: z.number().int().min(1),
  /** Stop calling Jev (rules-only) once this much has been spent today. 0 disables Jev. */
  dailyBudgetUsd: z.number().min(0),
});

const swarmSchema = z.object({
  /**
   * How bots relate to each other. `independent`: they ignore one another. `cooperative`: they
   * share what they see and claim targets so they do not pile onto the same one. `coordinated`:
   * as cooperative, plus a coordinator that picks a focus target for the squad.
   */
  mode: z.enum(['independent', 'cooperative', 'coordinated']),
  /** A target claim lapses after this long without being refreshed. */
  claimTtlMs: z.number().int().min(500),
  /** A bot at or below this HP that was hit recently counts as needing help. */
  helpHp: z.number().min(0).max(20),
  /** Bots go to the aid of an ally in trouble. */
  helpAllies: z.boolean(),
  coordinator: z.object({
    /** How often the coordinator looks at the situation and may ask Jev. */
    intervalMs: z.number().int().min(500),
    /** How long a focus directive holds before bots go back to their own choices. */
    directiveTtlMs: z.number().int().min(500),
    model: z.string().min(1),
    timeoutMs: z.number().int().min(50),
    /** Also assign each bot a role for the fight (by Jev, or by gear without it). */
    assignRoles: z.boolean().default(false),
    /** Confidence thresholds for the coordinator's answers. Defaults to `defaults.jev.thresholds`. */
    thresholds: thresholdsSchema
      .refine((t) => t.cautious <= t.act, { message: 'cautious must be <= act' })
      .optional(),
  }),
});

const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** Mineflayer protocol version, or false to auto-detect. */
  version: z.union([z.string(), z.literal(false)]),
  /** Wait this long between starting one bot and the next, so a server's login throttle is not tripped. */
  staggerMs: z.number().int().min(0),
});

const debugSchema = z.object({
  /** Print each bot's snapshot this often; 0 turns it off. */
  snapshotIntervalMs: z.number().int().min(0),
  /** Directory for the JSONL log of Jev decisions. An empty string turns the log off. */
  decisionLogDir: z.string(),
});

const botEntrySchema = z.object({
  username: z.string().regex(/^\w{3,16}$/, 'Minecraft usernames are 3-16 letters, digits or _'),
  role: z.enum(['fighter', 'tank', 'ranged', 'support', 'scout']).default('fighter'),
  owner: z.string().optional(),
  /** Players this bot must never attack, in addition to its owner and the other bots. */
  allies: z.array(z.string()).default([]),
  /** What the bot does on its own until its owner gives an order: hold and fight what comes (guard), seek out hostiles (hunt), or do nothing (idle). */
  mode: z.enum(['guard', 'hunt', 'idle']).default('guard'),
  /** Per-bot overrides of `defaults`. */
  overrides: z
    .object({
      perception: perceptionSchema.partial(),
      reflex: reflexSchema.partial(),
      rules: rulesBaseSchema.partial(),
      strategic: strategicSchema.partial(),
      jev: jevSchema
        .omit({ thresholds: true })
        .partial()
        .extend({ thresholds: thresholdsSchema.partial().optional() }),
    })
    .partial()
    .default({}),
});

const fileSchema = z.object({
  server: serverSchema,
  gateway: gatewaySchema,
  swarm: swarmSchema,
  debug: debugSchema,
  defaults: agentSettingsSchema,
  bots: z.array(botEntrySchema).min(1),
});

export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export type ConfigFile = z.infer<typeof fileSchema>;

export interface BotConfig extends AgentSettings {
  username: string;
  role: ConfigFile['bots'][number]['role'];
  owner?: string;
  /** Everyone this bot must never attack: its owner, its allies, and every bot in the config. */
  protectedPlayers: string[];
  mode: ConfigFile['bots'][number]['mode'];
}

type Thresholds = z.infer<typeof thresholdsSchema>;

export interface Config {
  server: ConfigFile['server'];
  gateway: ConfigFile['gateway'];
  /** The coordinator's thresholds are always resolved. */
  swarm: ConfigFile['swarm'] & {
    coordinator: ConfigFile['swarm']['coordinator'] & { thresholds: Thresholds };
  };
  debug: ConfigFile['debug'];
  bots: BotConfig[];
  jevApi: { apiKey?: string; baseURL?: string };
}

/**
 * Everyone a bot must never attack. The owner is always included, even if `protectedPlayers` was
 * built without them, so protecting the owner never depends on how the config was assembled.
 */
export function protectedFor(config: Pick<BotConfig, 'owner' | 'protectedPlayers'>): string[] {
  return [...new Set([...(config.owner ? [config.owner] : []), ...config.protectedPlayers])];
}

/** Parse raw config + environment into a validated config with per-bot settings resolved. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = {}): Config {
  const result = fileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  const file = result.data;

  const names = file.bots.map((b) => b.username.toLowerCase());
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new Error(`Invalid config: duplicate bot username "${dupe}"`);

  const server = {
    ...file.server,
    host: env.MC_HOST ?? file.server.host,
    port: env.MC_PORT ? Number(env.MC_PORT) : file.server.port,
  };

  const swarm = file.bots.map((b) => b.username);
  const bots = file.bots.map((entry): BotConfig => {
    const o = entry.overrides;
    const settings = agentSettingsSchema.parse({
      perception: { ...file.defaults.perception, ...o.perception },
      reflex: { ...file.defaults.reflex, ...o.reflex },
      rules: { ...file.defaults.rules, ...o.rules },
      strategic: { ...file.defaults.strategic, ...o.strategic },
      jev: {
        ...file.defaults.jev,
        ...o.jev,
        thresholds: { ...file.defaults.jev.thresholds, ...o.jev?.thresholds },
      },
    });
    const protectedPlayers = [
      ...new Map(
        [...(entry.owner ? [entry.owner] : []), ...entry.allies, ...swarm].map((n) => [
          n.toLowerCase(),
          n,
        ]),
      ).values(),
    ];
    return {
      username: entry.username,
      role: entry.role,
      owner: entry.owner,
      protectedPlayers,
      mode: entry.mode,
      ...settings,
    };
  });

  return {
    server,
    gateway: file.gateway,
    swarm: {
      ...file.swarm,
      coordinator: {
        ...file.swarm.coordinator,
        thresholds: file.swarm.coordinator.thresholds ?? file.defaults.jev.thresholds,
      },
    },
    debug: file.debug,
    bots,
    jevApi: {
      apiKey: env.TYPESAFE_API_KEY || undefined,
      baseURL: env.TYPESAFE_BASE_URL || undefined,
    },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env.MC_JEV_CONFIG ?? 'config/default.json';
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')), env);
}
