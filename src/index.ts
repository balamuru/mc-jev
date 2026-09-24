import { config as loadEnv } from 'dotenv';
import { buildApp } from './app.js';
import { GAME_TICK_MS, loadConfig } from './config.js';

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
    `bot ${bot.username} (${bot.role}, ${bot.mode}): reflex every ${bot.reflex.everyTicks * GAME_TICK_MS}ms,` +
      ` strategic ${bot.strategic.enabled ? `every ${bot.strategic.intervalMs}ms` : 'off'},` +
      ` Jev timeout ${bot.jev.timeoutMs}ms`,
  );
}
if (config.bots.length > 1) {
  console.log(
    `swarm: ${config.swarm.mode}, ${config.bots.length} bots, started ${config.server.staggerMs}ms apart`,
  );
}

const app = buildApp(config);
app.start();

function shutdown(): void {
  console.log('\nshutting down');
  app.stop();
  console.log(app.usageSummary());
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
