import { createBot } from 'mineflayer';
import { protectedFor, type BotConfig, type Config } from '../config.js';
import { isAuthorized, parseChat } from '../control/commands.js';
import { ModeController, type Mode } from '../control/modes.js';
import { IDLE, type Intent } from '../intent.js';
import type { Logger } from '../logger.js';
import { ProvocationTracker } from '../perception/provocation.js';
import { distance } from '../perception/geometry.js';
import type { Snapshot, Vec3Like } from '../perception/types.js';
import { ReflexLoop, type Actuator } from '../reflex/loop.js';
import { GAME_TICK_MS } from '../config.js';
import type { JevGateway } from '../strategic/gateway.js';
import { StrategicLayer } from '../strategic/layer.js';
import type { DecisionSink } from '../telemetry/decisionLog.js';
import type { Blackboard } from '../swarm/blackboard.js';
import type { Bus } from '../swarm/bus.js';
import { SwarmMember, type SwarmMode } from '../swarm/member.js';
import { MineflayerActuator, attachPlugins } from './actuator.js';
import { backoffDelayMs, type BackoffOptions } from './backoff.js';
import { readSnapshot, type BotLike } from './mineflayerAdapter.js';
import { isProtectedPlayer } from '../reflex/protect.js';

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
  /** Link to the rest of the squad. Without it (or in `independent` mode) the bot works alone. */
  swarm?: {
    mode: SwarmMode;
    bus: Bus;
    board: Blackboard;
    helpHp: number;
    helpAllies: boolean;
  };
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
  return {
    bot: bot as unknown as BotLike,
    actuator: new MineflayerActuator(bot, {
      protectedPlayers: protectedFor(config),
      shield: config.rules.shield,
      strafeMobs: config.rules.strafeMobs,
      bow: config.rules.bow,
      creeperHitAndRun: config.rules.creeperHitAndRun,
      bowRange: { minBlocks: config.rules.bowMinBlocks, maxBlocks: config.rules.bowMaxBlocks },
    }),
  };
}

/**
 * One bot's lifecycle: connect, keep reconnecting with backoff, and publish perception snapshots.
 * Owns all of its state, so several agents can run in the same process.
 */
export class BotAgent {
  private _state: AgentState = 'idle';
  private bot: BotLike | null = null;
  private reflex: ReflexLoop | null = null;
  private actuator: Actuator | null = null;
  private strategic: StrategicLayer | null = null;
  private modes: ModeController | null = null;
  private member: SwarmMember | null = null;
  private readonly provocation = new ProvocationTracker();
  private _deaths = 0;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private unsubSwarm: (() => void) | null = null;
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

  /** True while the bot holds up a shield. */
  get blocking(): boolean {
    return this.actuator?.blocking ?? false;
  }

  /** Arrows shot and hits that followed, since the agent started (real actuator only). */
  get bowStats(): { shots: number; hits: number } {
    return this.actuator?.bowStats ?? { shots: 0, hits: 0 };
  }

  /** What the bot is currently trying to do. */
  get intent(): Intent {
    return this.reflex?.intent ?? IDLE;
  }

  /** Latest snapshot, or null when not spawned. */
  snapshot(): Snapshot | null {
    if (!this.bot || this._state !== 'online') return null;
    const now = Date.now();
    return readSnapshot(
      this.bot,
      this.config.perception,
      now,
      this.config.owner,
      this.provocation.hostileNames(now),
    );
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
    this.actuator = actuator;
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
    const rules = { ...this.config.rules, protectedPlayers: protectedFor(this.config) };
    const swarm = this.options.swarm;
    const member =
      swarm && swarm.mode !== 'independent'
        ? new SwarmMember({
            agent: this.config.username,
            role: this.config.role,
            mode: swarm.mode,
            bus: swarm.bus,
            board: swarm.board,
            helpHp: swarm.helpHp,
            helpAllies: swarm.helpAllies,
          })
        : null;
    this.member = member;

    this.unsubSwarm?.();
    this.unsubSwarm = null;
    if (swarm?.bus) {
      const protectedNames = rules.protectedPlayers ?? protectedFor(this.config);
      this.unsubSwarm = swarm.bus.subscribe('provoked', (event) => {
        if (event.type === 'provoked' && event.agent !== this.config.username) {
          if (!isProtectedPlayer(event.attacker, protectedNames)) {
            this.provocation.noteHit(event.attacker, event.at);
            this.log.info(
              `alerted: player ${event.attacker} attacked ${event.victim}; squad defending!`,
            );
          }
        }
      });
    }

    const modes = new ModeController({
      swarm: member ?? undefined,
      ownerName: this.config.owner,
      defaultMode: this.config.mode,
      rules,
      huntRadiusBlocks: this.config.perception.radiusBlocks,
    });
    this.modes = modes;
    const strategic =
      gateway && this.config.strategic.enabled
        ? new StrategicLayer({
            agentId: this.config.username,
            strategic: this.config.strategic,
            jev: this.config.jev,
            rules,
            gateway,
            onHostilePlayers: (names, ttlMs) => {
              for (const name of names) this.provocation.markHostile(name, Date.now(), ttlMs);
              this.log.info(`Jev judged ${names.join(', ')} about to attack`);
            },
            currentIntent: () => this.intent,
            active: () => !modes.standingDown,
            squad: () => member?.context() ?? null,
            apply: (intent, ttlMs) => reflex.setOverride(intent, Math.ceil(ttlMs / GAME_TICK_MS)),
            clear: () => reflex.clearOverride(),
            log: this.log,
            decisions: this.options.decisions,
          })
        : null;

    const reflex: ReflexLoop = new ReflexLoop({
      everyTicks: this.config.reflex.everyTicks,
      rules,
      read: () => {
        const snapshot = this.snapshot();
        if (snapshot) {
          strategic?.observe(snapshot);
          member?.observe(snapshot, reflex.intent);
        }
        return snapshot;
      },
      actuator,
      decide: (snapshot, previous) => modes.decide(snapshot, previous),
      adjustOverride: (snapshot, intent, previous) => modes.withRole(snapshot, intent, previous),
      onIntent: (next, prev) =>
        this.log.info(`intent ${prev.tactic} -> ${next.tactic}: ${next.reason}`),
      onError: (err) => this.log.error(`reflex error: ${errorMessage(err)}`),
    });
    this.reflex = reflex;
    this.strategic = strategic;
    strategic?.start();
    bot.on('physicsTick', () => reflex.onTick());
    this.watchForAttackers(bot);
    const onChat = (username: string, message: string) =>
      this.handleChat(bot, reflex, username, message);
    bot.on('chat', onChat);
    bot.on('whisper', onChat);
    // After dying the bot respawns with a clean slate.
    bot.on('death', () => {
      reflex.dispose();
      strategic?.reset();
      member?.died();
      this.provocation.reset();
    });
  }

  /**
   * Notice players who attack the bot, its owner, allies, or squadmates.
   * The server names the attacker in `entityHurt` when it can;
   * otherwise a swing near the victim at the moment of damage is used.
   */
  private watchForAttackers(bot: BotLike): void {
    if (!this.config.rules.pvp) return;
    const protectedNames = protectedFor(this.config);
    const recentSwings = new Map<string, { at: number; position: Vec3Like }>();
    // `bot.entity` does not exist until the bot has spawned, so read it when an event arrives.
    let lastHealth = bot.health;

    bot.on('entityHurt', (victim: unknown, source: unknown) => {
      const victimName = playerUsername(bot, victim);
      const isVictimMe =
        victim === (bot.entity as unknown) ||
        (victimName != null && victimName.toLowerCase() === this.config.username.toLowerCase());
      const isVictimOwner =
        !!this.config.owner && victimName?.toLowerCase() === this.config.owner.toLowerCase();
      const isVictimProtected =
        isVictimMe ||
        isVictimOwner ||
        (victimName != null && isProtectedPlayer(victimName, protectedNames));

      let attackerName = playerUsername(bot, source);

      // If the server did not supply a source cause, fall back to recent swings near the victim.
      if (!attackerName && isVictimProtected) {
        const victimPos =
          isVictimMe && bot.entity
            ? bot.entity.position
            : (victim as { position?: Vec3Like } | undefined)?.position;
        if (victimPos) {
          const now = Date.now();
          for (const [name, swing] of recentSwings) {
            if (now - swing.at <= 600 && distance(victimPos, swing.position) <= 4.5) {
              if (!isProtectedPlayer(name, protectedNames)) {
                attackerName = name;
                break;
              }
            }
          }
        }
      }

      if (attackerName && !isProtectedPlayer(attackerName, protectedNames) && isVictimProtected) {
        const now = Date.now();
        this.provocation.noteHit(attackerName, now);
        this.log.info(
          `player ${attackerName} attacked ${isVictimMe ? 'me' : (victimName ?? 'protected player')}; defending!`,
        );
        if (this.options.swarm?.bus) {
          this.options.swarm.bus.publish({
            type: 'provoked',
            agent: this.config.username,
            attacker: attackerName,
            victim: isVictimMe ? this.config.username : (victimName ?? 'protected player'),
            at: now,
          });
        }
      }
    });

    bot.on('entitySwingArm', (entity: unknown) => {
      const e = entity as { type?: string; username?: string; position?: Vec3Like };
      const me = bot.entity;
      const name = playerUsername(bot, entity);
      if (!name || isProtectedPlayer(name, protectedNames) || !e.position) return;
      recentSwings.set(name.toLowerCase(), { at: Date.now(), position: e.position });
      if (me) {
        this.provocation.noteSwing(name, distance(me.position, e.position), Date.now());
      }
    });

    bot.on('health', () => {
      const drop = lastHealth - bot.health;
      lastHealth = bot.health;
      if (drop <= 0) return;
      const mobNearby = (this.snapshot()?.entities ?? []).some(
        (e) => e.category === 'hostile' && e.dist <= 4,
      );
      const now = Date.now();
      const attackers = this.provocation.noteHpDrop({ amount: drop, mobNearby }, now);
      if (attackers.length > 0 && this.options.swarm?.bus) {
        for (const attacker of attackers) {
          if (!isProtectedPlayer(attacker, protectedNames)) {
            this.log.info(`player ${attacker} attacked me; defending!`);
            this.options.swarm.bus.publish({
              type: 'provoked',
              agent: this.config.username,
              attacker,
              victim: this.config.username,
              at: now,
            });
          }
        }
      }
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
    this.unsubSwarm?.();
    this.unsubSwarm = null;
    this.modes = null;
    this.member?.dispose();
    this.member = null;
    this.provocation.reset();
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

function playerUsername(bot: BotLike, entity: unknown): string | null {
  if (!entity || typeof entity !== 'object') return null;
  const e = entity as { type?: string; username?: string; name?: string; id?: number };
  if (e.username) return e.username;
  if (e === (bot.entity as unknown)) return (bot as { username?: string }).username ?? null;
  if (bot.players) {
    for (const [username, p] of Object.entries(bot.players)) {
      if (
        p?.entity === entity ||
        (e.id != null && (p?.entity as { id?: number } | undefined)?.id === e.id)
      ) {
        return username;
      }
    }
  }
  return e.type === 'player' && e.name && e.name !== 'player' ? e.name : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
