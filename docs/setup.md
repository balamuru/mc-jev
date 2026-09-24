# Setup

This guide takes you from a fresh clone to a running bot. The bot connects to a Minecraft server you run on your own machine, and it can use Jev (through OpenRouter) to make its decisions.

## Prerequisites

| Tool               | Version                  | Used for                                   |
| ------------------ | ------------------------ | ------------------------------------------ |
| Node.js            | 20 or newer (CI uses 22) | Running the bot and the tests              |
| Java               | 21 or newer              | Running the local Paper server             |
| OpenRouter API key | —                        | Optional: without one, bots use rules only |

## 1. Install

```bash
git clone git@github.com:balamuru/mc-jev.git
cd mc-jev
npm install
```

## 2. Add your Jev key

Jev runs through OpenRouter:

1. Copy the example file: `cp .env.example .env`.
2. Edit `.env` so it contains:

   ```bash
   TYPESAFE_API_KEY=<your OpenRouter key>
   TYPESAFE_BASE_URL=https://openrouter.ai/api
   ```

- **Keep `.env` private:** it is gitignored. Never commit it, and don't paste the key into issues or chat.
- **Without a key:** leave `TYPESAFE_API_KEY` empty, and every bot runs on its rules alone.
- **Using TypeSafe directly instead:** set `TYPESAFE_API_KEY` to a TypeSafe key and remove `TYPESAFE_BASE_URL`.

## 3. Start a local Minecraft server

```bash
./scripts/server.sh
```

The script:

- downloads Paper into `server/` and verifies its checksum. The default version is 26.1.2, which is within the newest version Mineflayer supports (26.1). Override it with `MC_VERSION`.
- asks you before accepting the Minecraft EULA (https://aka.ms/MinecraftEULA)
- sets `online-mode=false` so bots can join without Mojang accounts

To download without starting the server, run `./scripts/server.sh --download-only`. `MC_MEMORY` sets the Java heap size (default `2G`). Leave the server running in its own terminal while you run the bot.

**Do not expose this server to the internet.**

## 4. Run the bot

```bash
npm run dev
```

This prints each bot's settings, connects every bot in `config/default.json` to the server, and prints what each one perceives once a second:

```
[JevBot] hp 20 food 20 at (12, 64, -3) holding empty hand | zombie 5.2m ahead approaching, Steve 12.0m left
```

If the server goes away, bots reconnect with exponential backoff (1s up to 30s). Press Ctrl+C to stop them. To use a different config file, set `MC_JEV_CONFIG=path/to/config.json`.

### Chat commands (from Phase 4)

Bots run on their own by default. A bot's `owner` can type these commands in chat to take over:

| Command      | Effect                             |
| ------------ | ---------------------------------- |
| `follow`     | Follow the owner                   |
| `guard here` | Defend the current spot            |
| `hunt`       | Seek out hostiles                  |
| `stop`       | Stop everything                    |
| `status`     | Report HP, mode and current intent |
| `auto`       | Return to autonomous mode          |

## 5. Tests and checks

```bash
npm test                          # unit tests (no server needed)
npx vitest run test/config.test.ts            # one test file
npx vitest run -t "applies per-bot overrides" # one test by name
npm run test:watch                # watch mode
npm run lint && npm run typecheck
npm run check                     # lint + typecheck + unit tests (what CI runs, minus format)
npm run test:integration          # starts its own throwaway servers (needs step 3 run once)
```

### Integration tests

`npm run test:integration` starts its own Paper server for each test file, on ports 25598 and 25599. Each gets a fresh flat world at night with no natural mob spawns, and it is deleted afterwards. Your dev world in `server/world` is never touched. The tests reuse the download and EULA acceptance in `server/`, so run `./scripts/server.sh` once first and stop it.

Together the tests cover spawning, seeing another player, reconnecting after a kick, wearing armor, killing a summoned zombie with the best sword, retreating at low HP, and eating when hungry. They take about 35 seconds.

## Configuration reference (`config/default.json`)

### Server

| Setting                      | Meaning                                                           | Default           |
| ---------------------------- | ----------------------------------------------------------------- | ----------------- |
| `server.host`, `server.port` | Server address. `MC_HOST` and `MC_PORT` override these.           | `localhost:25565` |
| `server.version`             | Minecraft protocol version, or `false` to detect it automatically | `false`           |

### Limits shared by all bots

| Setting                     | Meaning                                                                       | Default |
| --------------------------- | ----------------------------------------------------------------------------- | ------- |
| `gateway.maxCallsPerMinute` | Maximum Jev calls per minute, across all bots                                 | 60      |
| `gateway.dailyBudgetUsd`    | Daily Jev spending cap. Once reached, bots use rules only. `0` turns Jev off. | 1.0     |

### Debugging

| Setting                    | Meaning                                                        | Default |
| -------------------------- | -------------------------------------------------------------- | ------- |
| `debug.snapshotIntervalMs` | How often each bot prints what it perceives. `0` turns it off. | 1000    |

### Per-bot defaults

| Setting                                             | Meaning                                                                                  | Default                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------- |
| `defaults.perception.radiusBlocks`                  | Ignore entities farther away than this                                                   | 24                           |
| `defaults.perception.maxEntities`                   | Keep at most this many entities (nearest first)                                          | 8                            |
| `defaults.perception.fovDegrees`                    | Horizontal field of view. Entities outside it are dropped. 360 turns the filter off.     | 360                          |
| `defaults.perception.requireLineOfSight`            | Drop entities behind walls, so the bot can't see through them                            | false                        |
| `defaults.reflex.enabled`                           | Turn the reflex layer off to make a bot observe-only                                     | true                         |
| `defaults.reflex.everyTicks`                        | Run the reflex layer every N game ticks (one tick is 50ms)                               | 1                            |
| `defaults.rules.retreatHp`                          | At or below this HP (of 20) the bot retreats from hostiles                               | 6                            |
| `defaults.rules.resumeHp`                           | After retreating, resume fighting once HP is back to this. Must be at least `retreatHp`. | 14                           |
| `defaults.rules.engageRadiusBlocks`                 | Engage hostiles within this many blocks                                                  | 16                           |
| `defaults.rules.eatBelowFood`                       | Start eating when food falls below this level (of 20)                                    | 15                           |
| `defaults.strategic.intervalMs`                     | Time between periodic strategic decisions                                                | 2000                         |
| `defaults.strategic.eventTriggers`                  | Events that trigger an immediate decision                                                | `hurt`, `newThreat`, `lowHp` |
| `defaults.strategic.minGapMs`                       | Minimum time between any two decisions                                                   | 250                          |
| `defaults.jev.model`                                | Jev model                                                                                | `jev-latest`                 |
| `defaults.jev.timeoutMs`, `defaults.jev.maxRetries` | Timeout per call, and how many retries                                                   | 800, 0                       |
| `defaults.jev.thresholds.act`                       | Confidence needed to act on a decision                                                   | 0.7                          |
| `defaults.jev.thresholds.cautious`                  | Confidence needed to act cautiously. Below this, rules decide.                           | 0.5                          |

### Bots

| Setting            | Meaning                                                       | Default   |
| ------------------ | ------------------------------------------------------------- | --------- |
| `bots[].username`  | Username: 3–16 letters, digits or `_`. Must be unique.        | `JevBot`  |
| `bots[].role`      | `fighter`, `tank`, `ranged`, `support` or `scout`             | `fighter` |
| `bots[].owner`     | Player who can give chat commands                             | none      |
| `bots[].overrides` | Any `reflex`, `strategic` or `jev` settings for this bot only | none      |

Example: two bots, where the second decides more often and needs more confidence before acting:

```json
"bots": [
  { "username": "Alpha", "owner": "YourName" },
  { "username": "Bravo", "role": "ranged",
    "overrides": { "strategic": { "intervalMs": 1000 }, "jev": { "thresholds": { "act": 0.8 } } } }
]
```

## Troubleshooting

| Symptom                                         | Fix                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid config: …` at startup                  | The message names the bad field. Check it against the configuration reference above.                                            |
| `Jev: no key (rules-only)`                      | `.env` is missing, or `TYPESAFE_API_KEY` is empty in it.                                                                        |
| Jev returns 401                                 | Check the key, and that `TYPESAFE_BASE_URL` matches where the key came from (OpenRouter or TypeSafe).                           |
| Jev returns 429 or 529, or calls time out often | Raise `strategic.intervalMs` or `jev.timeoutMs`, or lower `gateway.maxCallsPerMinute`. Bots fall back to rules in the meantime. |
| Bot can't join the server                       | Check that the server is running with `online-mode=false`, and that `server.version` matches it or is `false`.                  |
