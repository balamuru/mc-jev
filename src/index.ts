import { config as loadEnv } from 'dotenv';
import { BotAgent } from './agent/BotAgent.js';
import { GAME_TICK_MS, loadConfig } from './config.js';
import { formatSnapshot } from './perception/format.js';
import { JevGateway } from './strategic/gateway.js';
import { createJevClient } from './strategic/jev.js';
import { JsonlDecisionLog } from './telemetry/decisionLog.js';

loadEnv({ quiet: true });

const config = loadConfig();
const { apiKey, baseURL } = config.jevApi;

console.log(`mc-jev: server ${config.server.host}:${config.server.port}`);
console.log(
  apiKey
    ? `Jev: key present via ${baseURL ?? 'https://api.typesafe.ai'}`
    : 'Jev: no key, so the bots run on rules only (set TYPESAFE_API_KEY in .env)',
);
for (const bot of config.bots) {
  console.log(
    `bot ${bot.username} (${bot.role}): reflex every ${bot.reflex.everyTicks * GAME_TICK_MS}ms,` +
      ` strategic ${bot.strategic.enabled ? `every ${bot.strategic.intervalMs}ms` : 'off'},` +
      ` Jev timeout ${bot.jev.timeoutMs}ms`,
  );
}

const gateway = new JevGateway({
  client: apiKey ? createJevClient({ apiKey, baseURL }) : null,
  limits: config.gateway,
});
const decisions = config.debug.decisionLogDir
  ? new JsonlDecisionLog(config.debug.decisionLogDir, (m) => console.error(m))
  : undefined;

const agents = config.bots.map(
  (bot) =>
    new BotAgent(bot, config.server, {
      gateway,
      decisions,
      snapshotIntervalMs: config.debug.snapshotIntervalMs,
      onSnapshot: (snapshot, agent) =>
        console.log(`[${agent.config.username}] ${formatSnapshot(snapshot)}`),
    }),
);
agents.forEach((agent) => agent.start());

function shutdown(): void {
  console.log('\nshutting down');
  agents.forEach((agent) => agent.stop());
  const s = gateway.stats();
  console.log(
    `Jev: ${s.calls} calls, ${s.failures} failed, $${s.costUsd.toFixed(5)} spent` +
      (s.disabledReason ? ` (disabled: ${s.disabledReason})` : ''),
  );
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
