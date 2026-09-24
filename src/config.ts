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
  /** At or below this many HP (of 20) the bot retreats from hostiles instead of fighting. */
  retreatHp: z.number().min(0).max(20),
  /** After retreating, the bot resumes fighting only once it has regained this many HP. */
  resumeHp: z.number().min(0).max(20),
  /** Hostiles within this many blocks are engaged. */
  engageRadiusBlocks: z.number().min(1).max(64),
  /** Start eating when food falls below this level (of 20). */
  eatBelowFood: z.number().min(0).max(20),
});
const rulesSchema = rulesBaseSchema.refine((r) => r.retreatHp <= r.resumeHp, {
  message: 'retreatHp must be <= resumeHp',
});

const strategicSchema = z.object({
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

const serverSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** Mineflayer protocol version, or false to auto-detect. */
  version: z.union([z.string(), z.literal(false)]),
});

const debugSchema = z.object({
  /** Print each bot's snapshot this often; 0 turns it off. */
  snapshotIntervalMs: z.number().int().min(0),
});

const botEntrySchema = z.object({
  username: z.string().regex(/^\w{3,16}$/, 'Minecraft usernames are 3-16 letters, digits or _'),
  role: z.enum(['fighter', 'tank', 'ranged', 'support', 'scout']).default('fighter'),
  owner: z.string().optional(),
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
}

export interface Config {
  server: ConfigFile['server'];
  gateway: ConfigFile['gateway'];
  debug: ConfigFile['debug'];
  bots: BotConfig[];
  jevApi: { apiKey?: string; baseURL?: string };
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
    return { username: entry.username, role: entry.role, owner: entry.owner, ...settings };
  });

  return {
    server,
    gateway: file.gateway,
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
