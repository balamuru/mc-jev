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

## 3. Start a local Minecraft server (from Phase 1)

```bash
./scripts/server.sh
```

The script:

- downloads Paper into `server/`, using the newest Minecraft version Mineflayer supports
- asks you before accepting the Minecraft EULA
- sets `online-mode=false` so bots can join without Mojang accounts

**Do not expose this server to the internet.**

## 4. Run the bot

```bash
npm run dev
```

In Phase 0 this only checks `config/default.json` and prints each bot's settings.

From Phase 1 onwards, the bots join the server. To use a different config file, set `MC_JEV_CONFIG=path/to/config.json`.

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
npm run test:integration          # needs the local server running (from Phase 1)
```

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

### Per-bot defaults

| Setting                                             | Meaning                                                        | Default                      |
| --------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| `defaults.reflex.everyTicks`                        | Run the reflex layer every N game ticks (one tick is 50ms)     | 1                            |
| `defaults.strategic.intervalMs`                     | Time between periodic strategic decisions                      | 2000                         |
| `defaults.strategic.eventTriggers`                  | Events that trigger an immediate decision                      | `hurt`, `newThreat`, `lowHp` |
| `defaults.strategic.minGapMs`                       | Minimum time between any two decisions                         | 250                          |
| `defaults.jev.model`                                | Jev model                                                      | `jev-latest`                 |
| `defaults.jev.timeoutMs`, `defaults.jev.maxRetries` | Timeout per call, and how many retries                         | 800, 0                       |
| `defaults.jev.thresholds.act`                       | Confidence needed to act on a decision                         | 0.7                          |
| `defaults.jev.thresholds.cautious`                  | Confidence needed to act cautiously. Below this, rules decide. | 0.5                          |

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
