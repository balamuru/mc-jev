import { config as loadEnv } from 'dotenv';
import { GAME_TICK_MS, loadConfig } from './config.js';

loadEnv({ quiet: true });

// Phase 0 entry point: validates config and reports what would run.
// Bot agents are wired in from Phase 1 onwards (see docs/phases.md).
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
