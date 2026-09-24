import { BotAgent, type AgentOptions } from './agent/BotAgent.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { formatSnapshot } from './perception/format.js';
import { JevGateway } from './strategic/gateway.js';
import { createJevClient, type JevClient } from './strategic/jev.js';
import { Blackboard } from './swarm/blackboard.js';
import { InProcessBus } from './swarm/bus.js';
import { Coordinator } from './swarm/coordinator.js';
import { JsonlDecisionLog, type DecisionSink } from './telemetry/decisionLog.js';

export interface AppDeps {
  /** Replaceable in tests. Defaults to the real SDK client when an API key is set. */
  jevClient?: JevClient | null;
  createBot?: AgentOptions['createBot'];
  decisions?: DecisionSink;
  log?: Logger;
}

export interface App {
  agents: BotAgent[];
  gateway: JevGateway;
  board: Blackboard;
  coordinator: Coordinator | null;
  /** Start the bots one at a time, `server.staggerMs` apart, and the coordinator if there is one. */
  start(): void;
  /** Stop everything, including bots that have not started yet. */
  stop(): void;
  /** A short account of Jev usage, for the end of a run. */
  usageSummary(): string;
}

/**
 * Assemble the whole program from a validated config: one agent per bot, one shared Jev gateway,
 * one bus and blackboard for the squad, and a coordinator when the swarm is coordinated.
 */
export function buildApp(config: Config, deps: AppDeps = {}): App {
  const log: Logger = deps.log ?? {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
  const { apiKey, baseURL } = config.jevApi;
  const client =
    deps.jevClient !== undefined
      ? deps.jevClient
      : apiKey
        ? createJevClient({ apiKey, baseURL })
        : null;
  const gateway = new JevGateway({ client, limits: config.gateway });
  const decisions =
    deps.decisions ??
    (config.debug.decisionLogDir
      ? new JsonlDecisionLog(config.debug.decisionLogDir, (m) => log.error(m))
      : undefined);

  const bus = new InProcessBus((err) => log.error(`swarm bus: ${err}`));
  const board = new Blackboard(bus, { claimTtlMs: config.swarm.claimTtlMs });
  const swarm = {
    mode: config.swarm.mode,
    bus,
    board,
    helpHp: config.swarm.helpHp,
    helpAllies: config.swarm.helpAllies,
  };

  const coordinator =
    config.swarm.mode === 'coordinated'
      ? new Coordinator({
          gateway,
          board,
          bus,
          settings: config.swarm.coordinator,
          thresholds: config.bots[0]!.jev.thresholds,
          log,
          decisions,
        })
      : null;

  const agents = config.bots.map(
    (bot) =>
      new BotAgent(bot, config.server, {
        gateway,
        decisions,
        swarm,
        createBot: deps.createBot,
        logger: deps.log,
        snapshotIntervalMs: config.debug.snapshotIntervalMs,
        onSnapshot: (snapshot, agent) =>
          log.info(`[${agent.config.username}] ${formatSnapshot(snapshot)}`),
      }),
  );

  let timers: NodeJS.Timeout[] = [];
  return {
    agents,
    gateway,
    board,
    coordinator,
    start() {
      agents[0]?.start();
      timers = agents
        .slice(1)
        .map((agent, i) => setTimeout(() => agent.start(), (i + 1) * config.server.staggerMs));
      coordinator?.start();
    },
    stop() {
      timers.forEach(clearTimeout);
      timers = [];
      coordinator?.stop();
      agents.forEach((agent) => agent.stop());
      board.close();
    },
    usageSummary() {
      const s = gateway.stats();
      return (
        `Jev: ${s.calls} calls, ${s.failures} failed, $${s.costUsd.toFixed(5)} spent` +
        (s.disabledReason ? ` (disabled: ${s.disabledReason})` : '')
      );
    },
  };
}
