import { config as loadEnv } from 'dotenv';
import { BotAgent } from './agent/BotAgent.js';
import { GAME_TICK_MS, loadConfig } from './config.js';
import { formatSnapshot } from './perception/format.js';

loadEnv({ quiet: true });

const config = loadConfig();

console.log(`mc-jev: server ${config.server.host}:${config.server.port}`);
console.log(
  `Jev: ${config.jevApi.apiKey ? 'key present' : 'no key (rules-only)'}` +
    ` via ${config.jevApi.baseURL ?? 'https://api.typesafe.ai'}`,
);
for (const bot of config.bots) {
  console.log(
    `bot ${bot.username} (${bot.role}): reflex every ${bot.reflex.everyTicks * GAME_TICK_MS}ms,` +
      ` strategic every ${bot.strategic.intervalMs}ms, Jev timeout ${bot.jev.timeoutMs}ms`,
  );
}

const agents = config.bots.map(
  (bot) =>
    new BotAgent(bot, config.server, {
      snapshotIntervalMs: config.debug.snapshotIntervalMs,
      onSnapshot: (snapshot, agent) =>
        console.log(`[${agent.config.username}] ${formatSnapshot(snapshot)}`),
    }),
);
agents.forEach((agent) => agent.start());

function shutdown(): void {
  console.log('\nshutting down');
  agents.forEach((agent) => agent.stop());
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
