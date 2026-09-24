import { createBot } from 'mineflayer';
import type { BotConfig, Config } from '../config.js';
import { isAuthorized, parseChat } from '../control/commands.js';
import { ModeController, type Mode } from '../control/modes.js';
import { IDLE, type Intent } from '../intent.js';
import type { Logger } from '../logger.js';
import type { Snapshot } from '../perception/types.js';
import { ReflexLoop, type Actuator } from '../reflex/loop.js';
import { GAME_TICK_MS } from '../config.js';
import type { JevGateway } from '../strategic/gateway.js';
import { StrategicLayer } from '../strategic/layer.js';
import type { DecisionSink } from '../telemetry/decisionLog.js';
import { MineflayerActuator, attachPlugins } from './actuator.js';
import { backoffDelayMs, type BackoffOptions } from './backoff.js';
import { readSnapshot, type BotLike } from './mineflayerAdapter.js';

export type { Logger };

export type AgentState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'stopped';

export interface AgentOptions {
  /** Print/collect a snapshot this often once spawned; 0 disables. */
  snapshotIntervalMs?: number;
  onSnapshot?: (snapshot: Snapshot, agent: BotAgent) => void;
  logger?: Logger;
  reconnect?: BackoffOptions;
  /** Shared Jev gateway. Without one, the bot runs on rules only. */
  gateway?: JevGateway;
  /** Where Jev decisions are recorded. */
  decisions?: DecisionSink;
  /** Bot factory, replaceable in tests. */
  createBot?: (server: Config['server'], config: BotConfig) => BotHandle;
}

/** A connected bot together with the object that drives it. */
export interface BotHandle {
  bot: BotLike;
  actuator: Actuator;
}

const DEFAULT_RECONNECT: BackoffOptions = { baseMs: 1000, maxMs: 30_000 };

export function createMineflayerBot(server: Config['server'], config: BotConfig): BotHandle {
  const bot = createBot({
    host: server.host,
    port: server.port,
    username: config.username,
    auth: 'offline',
    // Errors are logged once, by the agent, through its 'error' handler.
    logErrors: false,
    // `false` in config means auto-detect, which Mineflayer expresses by omitting the version.
    ...(server.version ? { version: server.version } : {}),
  });
  // Plugins need the negotiated protocol version, so they load once the bot has spawned.
  if (config.reflex.enabled) {
    bot.once('spawn', () => attachPlugins(bot, config.rules));
  }
  return { bot: bot as unknown as BotLike, actuator: new MineflayerActuator(bot) };
}

/**
 * One bot's lifecycle: connect, keep reconnecting with backoff, and publish perception snapshots.
 * Owns all of its state, so several agents can run in the same process.
 */
export class BotAgent {
  private _state: AgentState = 'idle';
  private bot: BotLike | null = null;
  private reflex: ReflexLoop | null = null;
  private strategic: StrategicLayer | null = null;
  private modes: ModeController | null = null;
  private _deaths = 0;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;
  private readonly backoff: BackoffOptions;

  constructor(
    readonly config: BotConfig,
    private readonly server: Config['server'],
    private readonly options: AgentOptions = {},
  ) {
    const prefix = `[${config.username}]`;
    const base = options.logger ?? {
      info: (m: string) => console.log(m),
      warn: (m: string) => console.warn(m),
      error: (m: string) => console.error(m),
    };
    this.log = {
      info: (m) => base.info(`${prefix} ${m}`),
      warn: (m) => base.warn(`${prefix} ${m}`),
      error: (m) => base.error(`${prefix} ${m}`),
    };
    this.backoff = options.reconnect ?? DEFAULT_RECONNECT;
  }

  get state(): AgentState {
    return this._state;
  }

  start(): void {
    if (this._state !== 'idle' && this._state !== 'stopped') return;
    this._state = 'connecting';
    this.connect();
  }

  stop(): void {
    this._state = 'stopped';
    this.clearTimers();
    const bot = this.bot;
    this.bot = null;
    this.stopReflex();
    bot?.removeAllListeners();
    // Swallow late errors from a bot we no longer track.
    bot?.on('error', () => {});
    bot?.quit('shutting down');
  }

  /** How many times this bot has died since the agent was created. */
  get deaths(): number {
    return this._deaths;
  }

  /** The bot's current high-level order: guarding, hunting, following or standing down. */
  get mode(): Mode {
    return this.modes?.mode ?? { name: this.config.mode };
  }

  /** What the bot is currently trying to do. */
  get intent(): Intent {
    return this.reflex?.intent ?? IDLE;
  }

  /** Latest snapshot, or null when not spawned. */
  snapshot(): Snapshot | null {
    if (!this.bot || this._state !== 'online') return null;
    return readSnapshot(this.bot, this.config.perception, Date.now(), this.config.owner);
  }

  private connect(): void {
    this.log.info(`connecting to ${this.server.host}:${this.server.port}`);
    const make = this.options.createBot ?? createMineflayerBot;
    let bot: BotLike;
    let actuator: Actuator;
    try {
      ({ bot, actuator } = make(this.server, this.config));
    } catch (err) {
      this.log.error(`could not create bot: ${errorMessage(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.bot = bot;
    bot.on('death', () => {
      this._deaths++;
    });
    this.startReflex(bot, actuator);

    bot.on('spawn', () => {
      if (this.bot !== bot) return;
      this.attempt = 0;
      this._state = 'online';
      this.log.info('spawned');
      this.startSnapshots();
    });
    bot.on('kicked', (reason: unknown) => {
      this.log.warn(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
    });
    bot.on('error', (err: unknown) => {
      this.log.error(errorMessage(err));
    });
    bot.on('end', (reason: unknown) => {
      if (this.bot !== bot) return;
      this.log.warn(`disconnected${reason ? ` (${String(reason)})` : ''}`);
      this.bot = null;
      this.stopReflex();
      this.scheduleReconnect();
    });
  }

  private startReflex(bot: BotLike, actuator: Actuator): void {
    if (!this.config.reflex.enabled) return;
    const { gateway } = this.options;
    const modes = new ModeController({
      ownerName: this.config.owner,
      defaultMode: this.config.mode,
      rules: this.config.rules,
      huntRadiusBlocks: this.config.perception.radiusBlocks,
    });
    this.modes = modes;
    const strategic =
      gateway && this.config.strategic.enabled
        ? new StrategicLayer({
            agentId: this.config.username,
            strategic: this.config.strategic,
            jev: this.config.jev,
            rules: this.config.rules,
            gateway,
            currentIntent: () => this.intent,
            active: () => !modes.standingDown,
            apply: (intent, ttlMs) => reflex.setOverride(intent, Math.ceil(ttlMs / GAME_TICK_MS)),
            clear: () => reflex.clearOverride(),
            log: this.log,
            decisions: this.options.decisions,
          })
        : null;

    const reflex: ReflexLoop = new ReflexLoop({
      everyTicks: this.config.reflex.everyTicks,
      rules: this.config.rules,
      read: () => {
        const snapshot = this.snapshot();
        if (snapshot) strategic?.observe(snapshot);
        return snapshot;
      },
      actuator,
      decide: (snapshot, previous) => modes.decide(snapshot, previous),
      onIntent: (next, prev) =>
        this.log.info(`intent ${prev.tactic} -> ${next.tactic}: ${next.reason}`),
      onError: (err) => this.log.error(`reflex error: ${errorMessage(err)}`),
    });
    this.reflex = reflex;
    this.strategic = strategic;
    strategic?.start();
    bot.on('physicsTick', () => reflex.onTick());
    const onChat = (username: string, message: string) =>
      this.handleChat(bot, reflex, username, message);
    bot.on('chat', onChat);
    bot.on('whisper', onChat);
    // After dying the bot respawns with a clean slate.
    bot.on('death', () => {
      reflex.dispose();
      strategic?.reset();
    });
  }

  /** Obey a chat command, but only from the bot's owner. Everything else is ignored. */
  private handleChat(bot: BotLike, reflex: ReflexLoop, sender: string, message: string): void {
    const { owner, username } = this.config;
    if (sender === username || !this.modes) return;
    if (!isAuthorized(sender, owner)) return;
    const command = parseChat(message, username);
    if (!command) return;

    const reply = this.modes.apply(command, bot.entity.position, this.snapshot());
    if (this.modes.standingDown) reflex.clearOverride();
    this.log.info(`${command.name} from ${sender}: ${reply}`);
    bot.chat(reply);
  }

  private stopReflex(): void {
    this.modes = null;
    this.strategic?.stop();
    this.strategic = null;
    this.reflex?.dispose();
    this.reflex = null;
  }

  private scheduleReconnect(): void {
    if (this._state === 'stopped' || this.reconnectTimer) return;
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this._state = 'reconnecting';
    const delay = backoffDelayMs(this.attempt++, this.backoff);
    this.log.info(`reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this._state !== 'reconnecting') return;
      this._state = 'connecting';
      this.connect();
    }, delay);
  }

  private startSnapshots(): void {
    const every = this.options.snapshotIntervalMs ?? 0;
    const sink = this.options.onSnapshot;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (every <= 0 || !sink) return;
    this.snapshotTimer = setInterval(() => {
      const snap = this.snapshot();
      if (!snap) return;
      try {
        sink(snap, this);
      } catch (err) {
        this.log.error(`snapshot handler failed: ${errorMessage(err)}`);
      }
    }, every);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.reconnectTimer = null;
    this.snapshotTimer = null;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
