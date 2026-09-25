# Setup

This guide takes you from nothing to watching your own AI bots fight in Minecraft, standing next to them in the game. It covers the tools to install, the local Minecraft server, the Minecraft game client, the bots, and the tests.

## What you will run

Three programs, all on your own machine:

```
 ┌───────────────────────┐        ┌──────────────────────────────┐
 │ Minecraft game client │        │ mc-jev (npm run dev)         │
 │ (you, playing)        │        │ one Mineflayer bot per entry │
 └──────────┬────────────┘        │ in config, plus Jev calls ───┼──► OpenRouter (optional)
            │                     └──────────────┬───────────────┘
            │  localhost:25565                   │  localhost:25565
            ▼                                    ▼
 ┌─────────────────────────────────────────────────────────────┐
 │ Paper server (./scripts/server.sh), Minecraft 26.1.2        │
 │ online-mode=false, listening on 127.0.0.1 only              │
 └─────────────────────────────────────────────────────────────┘
```

- **The server** is the world. The bots and you are all players on it.
- **The bots** are programs that log in as players. They need no Minecraft account.
- **The game client** is optional: without it the bots still run, and you follow them in the terminal. With it you can watch them, fight next to them and give them orders in chat.

## 1. Install the tools

| Tool                     | Version                        | Needed for                                          |
| ------------------------ | ------------------------------ | --------------------------------------------------- |
| Node.js                  | 20 or newer (CI uses 22)       | The bots, the tests and the benchmarks              |
| Java                     | **25** or newer                | The Paper server for Minecraft 26.1.2               |
| git, curl, python3, bash | any recent                     | Cloning, and `scripts/server.sh`                    |
| Minecraft: Java Edition  | a copy you own, version 26.1.2 | Optional: joining the world yourself (see step 5)   |
| OpenRouter API key       | —                              | Optional: without it the bots decide by rules alone |

**Linux (Debian or Ubuntu):**

```bash
# Node.js from NodeSource (or use nvm)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git curl python3
# Java 25: from your distribution if it has it, otherwise Eclipse Temurin (https://adoptium.net)
sudo apt install -y openjdk-25-jre-headless
```

**macOS (Homebrew):**

```bash
brew install node git python
brew install --cask temurin     # the current Temurin JDK (25 or newer)
brew install coreutils   # only if `sha256sum` is missing (older macOS)
```

**Windows:** use WSL2 (Ubuntu), and follow the Linux steps inside it. `scripts/server.sh` is a bash script. WSL2 forwards `localhost` to Windows by default, so the Minecraft client on Windows can join a server running in WSL.

Check the versions:

```bash
node --version    # v20 or newer
java -version     # 25 or newer
```

## 2. Get the code

```bash
git clone git@github.com:balamuru/mc-jev.git
cd mc-jev
npm install
npm run check     # lint, typecheck and the unit tests: should pass before you go further
```

## 3. Add your Jev key (optional)

Jev makes the bots' judgment calls, through OpenRouter. Without a key the bots still fight, using their rules.

```bash
cp .env.example .env
```

Then edit `.env`:

```bash
TYPESAFE_API_KEY=<your OpenRouter key>
TYPESAFE_BASE_URL=https://openrouter.ai/api
```

- **Keep `.env` private.** It is gitignored. Never commit it, and don't paste the key into issues or chat.
- **Cost:** about $0.00003 per Jev call, under $0.06 an hour per bot in a constant fight. `gateway.dailyBudgetUsd` (default $1) stops all calls for the day once reached.
- **Using TypeSafe directly instead of OpenRouter:** put a TypeSafe key in `TYPESAFE_API_KEY` and remove `TYPESAFE_BASE_URL`.

## 4. Start the Minecraft server

Open a terminal for the server and keep it open:

```bash
./scripts/server.sh
```

The first time, the script:

1. looks up the latest Paper build for Minecraft 26.1.2, downloads it into `server/` and checks its SHA-256 checksum;
2. writes `server/server.properties` for bot experiments: `online-mode=false` (bots have no accounts), `server-ip=127.0.0.1` (this machine only), port 25565, normal difficulty, no spawn protection;
3. asks you to accept the Minecraft EULA (https://aka.ms/MinecraftEULA). Type `yes` to accept; the server does not start otherwise;
4. starts the server. The first start generates the world and takes a minute. It is ready when it prints `Done (…s)! For help, type "help"`.

Later runs reuse the download, settings, EULA answer and world, and start in a few seconds.

**Server console.** The terminal running the server is its console. Commands typed there run with full permission, without a leading `/`:

| Command                                    | Effect                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `stop`                                     | Save the world and shut the server down. Always stop it this way rather than closing the window. |
| `op <your name>`                           | Let yourself use commands in the game (type them in chat with a leading `/`).                    |
| `list`                                     | Who is online, bots included.                                                                    |
| `time set night`, `time set day`           | Hostile mobs spawn at night.                                                                     |
| `difficulty peaceful`, `difficulty normal` | Peaceful removes hostile mobs altogether.                                                        |

**Options:**

- `MC_MEMORY=4G ./scripts/server.sh` sets the Java heap (default `2G`).
- `MC_VERSION=<version> ./scripts/server.sh` runs another Minecraft version. The bots support up to 26.1 (Mineflayer 4.39), so leave this alone unless Mineflayer is upgraded.
- `./scripts/server.sh --download-only` downloads and configures without starting.
- Your edits to `server/server.properties` are kept: the script only writes it when it is missing.

**A fresh world:** stop the server, delete the world folders (`rm -rf server/world*`), and start it again.

**Safety:** the server accepts anyone with any name, because `online-mode=false`. It listens on `127.0.0.1` only, so nothing outside your machine can reach it. **Never expose it to the internet** (no port forwarding, no `server-ip=0.0.0.0` on a public network).

## 5. Set up the Minecraft game client (optional)

You need Minecraft: Java Edition (not Bedrock), bought through https://www.minecraft.net, and the Minecraft Launcher.

1. **Match the server's version.** In the launcher, open **Installations → New installation**, choose version **release 26.1.2**, and save. Play with that installation: a client on a different version cannot join (the server says "Outdated client" or "Outdated server").
2. **Launch the game** with that installation and choose **Multiplayer → Add Server**. Server address: `localhost` (the port 25565 is the default). Save, then join.
3. **Your name is your account's Minecraft name.** The server is in offline mode, so it takes your name without checking it. Note it exactly: you need it as the bots' owner in step 6.
4. **Make yourself an operator,** in the server console: `op <your name>`. Then, in the game, `/gamemode creative` makes you fly and hostile mobs ignore you, which is the easiest way to watch a fight. `/gamemode survival` puts you back in danger.

Joining from another computer on your home network is possible (set `server-ip` in `server/server.properties` to your machine's LAN address and allow port 25565 through its firewall), but anyone on that network can then join under any name. Don't do it on a network you don't trust.

## 6. Configure your bots

The bots are listed in `config/default.json` under `bots`. To keep your own settings out of git, copy it and point the bots at the copy:

```bash
cp config/default.json config/local.json      # config/local*.json is gitignored
echo 'MC_JEV_CONFIG=config/local.json' >> .env
```

Then edit the `bots` list in `config/local.json`. At the least, set yourself as the owner, so the bots take your orders and never attack you:

```json
"bots": [
  { "username": "JevBot", "owner": "YourMinecraftName" }
]
```

| Field      | Meaning                                                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `username` | The bot's in-game name: 3 to 16 letters, digits or `_`, and not a name already on the server (not yours).                                          |
| `owner`    | Your Minecraft name. The owner gives orders in chat and is never attacked. Without an owner, a bot obeys nobody.                                   |
| `mode`     | What the bot does on its own: `guard` (default: fight what comes near), `hunt` (seek out hostiles) or `idle`.                                      |
| `role`     | In a squad: `fighter` (default), `tank`, `support`, `scout` or `ranged` (see [architecture.md](architecture.md#roles-botsrole-srccontrolrolests)). |
| `allies`   | Other players the bot must never attack.                                                                                                           |

For a squad, add more entries, each with its own `username`. They share one Jev budget, and by default they cooperate (claim different targets, help a hurt ally). Every other setting is in the [configuration reference](#configuration-reference-configdefaultjson) below.

## 7. Start the bots

In a second terminal:

```bash
npm run dev
```

It prints the setup, then each bot's view of the world once a second:

```
mc-jev: server localhost:25565
Jev: key present via https://openrouter.ai/api
bot JevBot (fighter, guard): reflex every 50ms, strategic every 2000ms, Jev timeout 1000ms
[JevBot] hp 20 food 20 at (12, 64, -3) holding empty hand | zombie 5.2m ahead approaching, Steve 12.0m left
```

- In the game, the server announces `JevBot joined the game`, and the bot appears near the world spawn.
- If the server is not running yet, or restarts, the bots keep retrying (1 second, doubling up to 30 seconds).
- **Ctrl+C** stops the bots and prints the Jev usage: calls, failures and dollars spent.
- Every Jev decision goes to `logs/decisions-YYYY-MM-DD.jsonl` (see [Decision log](#decision-log)).

## 8. Watch them fight, and give orders

**Arm the bots,** from the server console (or in the game with a leading `/`, once you are an operator):

```
give JevBot iron_sword
give JevBot iron_helmet
give JevBot iron_chestplate
give JevBot iron_leggings
give JevBot iron_boots
give JevBot bow
give JevBot arrow 64
give JevBot bread 16
```

The bot wears armor as soon as it gets it, fights with its best weapon, shoots with a bow at range, and eats when hungry.

**Start a fight:**

```
execute at JevBot run summon zombie ~8 ~ ~
execute at JevBot run summon skeleton ~12 ~ ~
execute at JevBot run summon creeper ~10 ~ ~
time set night
```

In the console, `~` needs `execute at <someone>` to know where "here" is.

**Give orders** by typing in the game's chat (press `T`). Only the bot's owner is obeyed:

### Chat commands

| Command                   | Effect                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `follow` (or `follow me`) | Follow the owner. The bot still fights threats first, then goes back to following. The owner must be one the server is tracking for the bot, which is within about 48 blocks. |
| `guard here`              | Hold this spot. The bot fights what comes near, then walks back to the post. It gives up a chase and returns once it is more than 14 blocks from the post.                    |
| `hunt`                    | Seek out hostiles up to 24 blocks away, and wander about 15 blocks at a time to find some when none are in sight.                                                             |
| `stop`                    | Stand down: no fighting, no moving and no Jev calls, until you say `auto`. A bot that has stopped does not defend itself.                                                     |
| `auto`                    | Go back to the bot's default mode (`bots[].mode`).                                                                                                                            |
| `status`                  | The bot replies with its mode, HP, food and the nearest hostile.                                                                                                              |
| `help`                    | The bot lists these commands.                                                                                                                                                 |

- **Exact commands only.** A message must be exactly one of these (case-insensitive, with an optional leading `!`), so ordinary chat is never mistaken for an order. `please follow me around` does nothing.
- **Owner only.** Everyone else is ignored, and a bot with no `owner` obeys nobody. Whispers work too.
- **Several bots.** A plain command goes to every bot you own. Start the message with a bot's name to command just that one: `JevBot follow`, `@JevBot: stop`.
- **Never attacked.** The owner, `bots[].allies` and other bots in the config are never attacked, even if they hit the bot. See [architecture.md](architecture.md#player-combat).
- **Default mode.** `bots[].mode` is what a bot does until it is told otherwise: `guard` (the default: hold position and fight what comes near), `hunt`, or `idle` (do nothing).

## 9. Tests and checks

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

`npm run test:integration` starts its own Paper server for each test file, one file at a time, on ports between 25586 and 25599. The benchmarks use ports in the same range, so do not run them at the same time. Each gets a fresh flat world at night with no natural mob spawns, and it is deleted afterwards. Your dev world in `server/world` is never touched. The tests reuse the download and EULA acceptance in `server/`, so run `./scripts/server.sh` once first and stop it.

Together the tests cover spawning, seeing another player, reconnecting after a kick, wearing armor, killing a summoned zombie with the best sword, retreating at low HP, eating when hungry, chat commands, fighting a player who attacks, sweep safety, a cooperative squad, a real Jev call when a key is set, the shield, the bow, roles in a coordinated squad, line of sight behind a wall and field of view, and a duel between bots from two separate apps. They take about 4 minutes.

### Live Jev test

`npm run test:live` makes a few real Jev calls with the key in `.env` and checks that the answers have the expected shape and make sense (a hopeless fight scores more dangerous than an easy one). It costs a fraction of a cent, writes its measurements to `logs/live-smoke.jsonl`, and is skipped when there is no key. It never runs in CI.

### Survival benchmark

`npm run benchmark:survival` runs fights against summoned mobs on a throwaway server and reports how often the bot survives:

```bash
npm run benchmark:survival -- --trials 8 --label mychange
npm run benchmark:survival -- --scenarios zombie-lowhp,creeper --trials 20
```

Options: `--trials N` (default 8), `--scenarios a,b,c` (default all), `--label NAME`, `--trace` (print what the bot sees and intends every second), `--timeout SECONDS` per trial (default 30), `--port N` (default 25597). Natural regeneration is switched off so that starting HP is a controlled variable. Results are printed as a table and saved to `logs/survival-<label>-<time>.json`. A full run takes about 15 minutes. See [survival-benchmark.md](survival-benchmark.md) for results and how to read them.

### Tuning tools

These are for Phase 7 and later work. The findings so far are in [tuning.md](tuning.md).

| Command                               | What it does                                                                                                                                                                                                                                                                                                                                               | Cost                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `npm run eval:jev`                    | Runs the Jev question set on 17 labeled situations with the real API and reports which expectations held. Rerun it after changing a question in `src/strategic/questions.ts`.                                                                                                                                                                              | about $0.0006                          |
| `npm run benchmark:survival -- --jev` | The survival benchmark with the bot asking the real API, then a summary of its decisions (outcomes, latency, cost).                                                                                                                                                                                                                                        | about $0.02 for a full run             |
| `npm run benchmark:squad`             | Three bots against a wave of mobs in each swarm mode. Options: `--trials N`, `--modes independent,cooperative,coordinated`, `--wave zombie:8,skeleton:2` (the default; a plain number means that many zombies), `--bows N` (bots that also carry a bow, default 1), `--no-roles`, `--jev`, `--label NAME`. Reports time to clear, squad damage and deaths. | free without `--jev`; about $0.03 with |
| `npm run analyze:decisions`           | Summarizes the decision logs in `logs/`: outcomes, latency percentiles and a suggested timeout, cost, how confident Jev was per tactic, and how often it really differed from the rules.                                                                                                                                                                   | free                                   |

### Decision log

While a bot runs with Jev, every decision is appended to `logs/decisions-YYYY-MM-DD.jsonl`, one JSON object per line. To see what Jev is doing:

```bash
tail -f logs/decisions-*.jsonl | jq -c '{agent, trigger, outcome, why, intent: .intent.tactic, latencyMs, costUsd}'
```

## Configuration reference (`config/default.json`)

### Server

| Setting                      | Meaning                                                                                           | Default           |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | ----------------- |
| `server.host`, `server.port` | Server address. `MC_HOST` and `MC_PORT` override these.                                           | `localhost:25565` |
| `server.version`             | Minecraft protocol version, or `false` to detect it automatically                                 | `false`           |
| `server.staggerMs`           | Wait this long between starting one bot and the next, so a server's login throttle is not tripped | 1000              |

### Limits shared by all bots

| Setting                     | Meaning                                                                       | Default |
| --------------------------- | ----------------------------------------------------------------------------- | ------- |
| `gateway.maxCallsPerMinute` | Maximum Jev calls per minute, across all bots                                 | 300     |
| `gateway.dailyBudgetUsd`    | Daily Jev spending cap. Once reached, bots use rules only. `0` turns Jev off. | 1.0     |

### Swarm

| Setting                                                  | Meaning                                                                                                      | Default                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------- |
| `swarm.mode`                                             | `independent`, `cooperative` or `coordinated` (see [architecture.md](architecture.md#swarm-modes-swarmmode)) | `cooperative`             |
| `swarm.claimTtlMs`                                       | A target claim lapses after this long without being refreshed                                                | 8000                      |
| `swarm.helpHp`                                           | An ally at or below this HP that was hit in the last 5 seconds counts as needing help                        | 8                         |
| `swarm.helpAllies`                                       | Bots go to the aid of an ally in trouble                                                                     | true                      |
| `swarm.coordinator.intervalMs`                           | How often the coordinator looks at the situation                                                             | 4000                      |
| `swarm.coordinator.directiveTtlMs`                       | How long a focus directive holds                                                                             | 6000                      |
| `swarm.coordinator.model`, `swarm.coordinator.timeoutMs` | Jev model and timeout for the coordinator                                                                    | `jev-latest`, 1500        |
| `swarm.coordinator.assignRoles`                          | The coordinator also assigns each bot a role (by Jev, or by gear without it)                                 | true                      |
| `swarm.coordinator.thresholds`                           | `act` and `cautious` confidence for the coordinator's answers                                                | `defaults.jev.thresholds` |

### Debugging

| Setting                    | Meaning                                                                            | Default |
| -------------------------- | ---------------------------------------------------------------------------------- | ------- |
| `debug.snapshotIntervalMs` | How often each bot prints what it perceives. `0` turns it off.                     | 1000    |
| `debug.decisionLogDir`     | Directory for the log of Jev decisions (JSONL). An empty string turns the log off. | `logs`  |

### Per-bot defaults

| Setting                                             | Meaning                                                                                                                                                          | Default                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `defaults.perception.radiusBlocks`                  | Ignore entities farther away than this                                                                                                                           | 24                           |
| `defaults.perception.maxEntities`                   | Keep at most this many entities (nearest first)                                                                                                                  | 8                            |
| `defaults.perception.fovDegrees`                    | Horizontal field of view. Entities outside it are dropped. 360 turns the filter off.                                                                             | 360                          |
| `defaults.perception.requireLineOfSight`            | Drop entities behind walls, so the bot can't see through them                                                                                                    | false                        |
| `defaults.reflex.enabled`                           | Turn the reflex layer off to make a bot observe-only                                                                                                             | true                         |
| `defaults.reflex.everyTicks`                        | Run the reflex layer every N game ticks (one tick is 50ms)                                                                                                       | 1                            |
| `defaults.rules.pvp`                                | Fight back against players who attack the bot (or that Jev is very sure are about to). `false`: never fight players.                                             | true                         |
| `defaults.rules.shield`                             | Hold up a shield (if one is in the off-hand) between swings and against creepers and archers. Off: it helped against creepers but not against groups of zombies. | false                        |
| `defaults.rules.strafeMobs`                         | Side-step melee mobs while the weapon recharges. Off: no measurable effect.                                                                                      | false                        |
| `defaults.rules.bow`                                | Shoot with a bow (if the bot has one and arrows) at targets in bow range, melee closer in. On: less damage in every benchmark scenario.                          | true                         |
| `defaults.rules.creeperHitAndRun`                   | Against a creeper in melee, swing once and back out of blast range while the weapon recharges. On: took creeper deaths from 16 in 20 to none.                    | true                         |
| `defaults.rules.bowMinBlocks`                       | Use melee, not the bow, closer than this                                                                                                                         | 6                            |
| `defaults.rules.bowMaxBlocks`                       | Shoot targets up to this far away. Must be more than `bowMinBlocks`.                                                                                             | 20                           |
| `defaults.rules.retreatHp`                          | At or below this HP (of 20) the bot retreats from hostiles                                                                                                       | 6                            |
| `defaults.rules.resumeHp`                           | After retreating, resume fighting once HP is back to this. Must be at least `retreatHp`.                                                                         | 14                           |
| `defaults.rules.engageRadiusBlocks`                 | Engage hostiles within this many blocks                                                                                                                          | 16                           |
| `defaults.rules.eatBelowFood`                       | Start eating when food falls below this level (of 20)                                                                                                            | 15                           |
| `defaults.rules.noEatRadiusBlocks`                  | Don't eat while a hostile is within this many blocks (eating slows you and cancels sprinting)                                                                    | 10                           |
| `defaults.rules.dangerMargin`                       | Fight only if the expected damage is below this fraction of current HP; otherwise retreat                                                                        | 0.8                          |
| `defaults.rules.retreatCheckMs`                     | A retreat is judged every this many milliseconds...                                                                                                              | 2000                         |
| `defaults.rules.retreatMinGainBlocks`               | ...and has failed if the distance to the threat grew by less than this                                                                                           | 1.5                          |
| `defaults.rules.fightBackMs`                        | After a failed retreat, fight back for this long. 0 turns fight-back off.                                                                                        | 4000                         |
| `defaults.strategic.enabled`                        | Ask Jev for decisions. When false, or with no API key, the rules decide alone.                                                                                   | true                         |
| `defaults.strategic.intervalMs`                     | Time between periodic strategic decisions                                                                                                                        | 2000                         |
| `defaults.strategic.eventTriggers`                  | Events that trigger an immediate decision                                                                                                                        | `hurt`, `newThreat`, `lowHp` |
| `defaults.strategic.minGapMs`                       | Minimum time between any two decisions                                                                                                                           | 250                          |
| `defaults.jev.model`                                | Jev model                                                                                                                                                        | `jev-latest`                 |
| `defaults.jev.timeoutMs`, `defaults.jev.maxRetries` | Timeout per call, and how many retries                                                                                                                           | 1000, 0                      |
| `defaults.jev.thresholds.act`                       | Confidence needed to act on a decision                                                                                                                           | 0.7                          |
| `defaults.jev.thresholds.cautious`                  | Confidence needed to act cautiously. Below this, rules decide.                                                                                                   | 0.5                          |

### Bots

| Setting            | Meaning                                                                                                                                                                                                                 | Default   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `bots[].username`  | Username: 3–16 letters, digits or `_`. Must be unique.                                                                                                                                                                  | `JevBot`  |
| `bots[].role`      | `fighter`, `tank`, `ranged`, `support` or `scout`. Changes how the bot fights in a swarm (see [architecture.md](architecture.md#roles-botsrole-srccontrolrolests)); a coordinator's assignment replaces it for a while. | `fighter` |
| `bots[].owner`     | Your Minecraft name. Only this player can give the bot chat commands.                                                                                                                                                   | none      |
| `bots[].allies`    | Players this bot must never attack, in addition to its owner and every other bot in the config                                                                                                                          | none      |
| `bots[].mode`      | What the bot does until told otherwise: `guard`, `hunt` or `idle`                                                                                                                                                       | `guard`   |
| `bots[].overrides` | Any `perception`, `reflex`, `rules`, `strategic` or `jev` settings for this bot only                                                                                                                                    | none      |

To run a squad, list several bots and set the swarm mode. Every bot in the list is protected from every other (they never attack each other):

```json
"swarm": { "mode": "cooperative", ... },
"bots": [
  { "username": "Alpha", "owner": "YourName" },
  { "username": "Bravo", "owner": "YourName" },
  { "username": "Charlie", "owner": "YourName" }
]
```

Example: two bots, where the second decides more often and needs more confidence before acting:

```json
"bots": [
  { "username": "Alpha", "owner": "YourName" },
  { "username": "Bravo", "role": "ranged",
    "overrides": { "strategic": { "intervalMs": 1000 }, "jev": { "thresholds": { "act": 0.8 } } } }
]
```

## Troubleshooting

| Symptom                                                                                  | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Invalid config: …` at startup                                                           | The message names the bad field. Check it against the configuration reference above.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Jev: no key, so the bots run on rules only`                                             | `.env` is missing, or `TYPESAFE_API_KEY` is empty in it.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Jev unavailable (auth…)` or a 401                                                       | Check the key, and that `TYPESAFE_BASE_URL` matches where the key came from (OpenRouter or TypeSafe).                                                                                                                                                                                                                                                                                                                                                                                            |
| Jev returns 429 or 529, or calls time out often                                          | Raise `strategic.intervalMs` or `jev.timeoutMs`, or lower `gateway.maxCallsPerMinute`. Bots fall back to rules in the meantime.                                                                                                                                                                                                                                                                                                                                                                  |
| `./scripts/server.sh` fails with `UnsupportedClassVersionError`, or says Java is too old | Minecraft 26.1.2 needs Java 25 or newer. Check `java -version`; if several are installed, put Java 25 first on your `PATH` (or set `JAVA_HOME`).                                                                                                                                                                                                                                                                                                                                                 |
| The server stops right after starting and mentions the EULA                              | Run `./scripts/server.sh` again and type `yes` at the EULA question.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Failed to bind to port` when the server starts                                          | Another server is already on port 25565 (often an earlier one still running). Stop it, or change `server-port` in `server/server.properties` and `server.port` in the bots' config.                                                                                                                                                                                                                                                                                                              |
| The game client says "Can't connect to server" or "Connection refused"                   | The server is not running, or not finished starting (wait for `Done`). The address is `localhost`, on the same machine.                                                                                                                                                                                                                                                                                                                                                                          |
| The game client says "Outdated client" or "Outdated server"                              | Play with a launcher installation set to exactly release 26.1.2 (step 5).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The game client says "Failed to verify username"                                         | `server/server.properties` has `online-mode=true`. Set it back to `false` and restart the server.                                                                                                                                                                                                                                                                                                                                                                                                |
| A bot keeps getting kicked with "You logged in from another location"                    | Two players with the same name: a bot's `username` is the same as yours or another bot's. Give each a unique name.                                                                                                                                                                                                                                                                                                                                                                               |
| The bot ignores your chat commands                                                       | Check that `owner` in the bot's config is exactly your Minecraft name, and that the message is exactly a command (`follow`, not `follow me please`). Nobody else is obeyed.                                                                                                                                                                                                                                                                                                                      |
| Bots don't attack you even when you hit them                                             | By design: the owner, `allies` and other bots are never attacked. Anyone else who hits a bot is fought back.                                                                                                                                                                                                                                                                                                                                                                                     |
| Hostile mobs never show up                                                               | It is day, or the difficulty is peaceful. In the console: `time set night`, `difficulty normal`, or summon one (step 8).                                                                                                                                                                                                                                                                                                                                                                         |
| Bot can't join the server                                                                | Check that the server is running with `online-mode=false`, and that `server.version` matches it or is `false`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `npm audit` reports 8 moderate warnings                                                  | Known and harmless here. They are all one advisory in `uuid` (a missing bounds check when a caller passes its own buffer to `v3`, `v5` or `v6`), pulled in by `yggdrasil` and `@azure/msal-node`, which Mineflayer uses only to log in to online-mode servers. Offline bots never call them, and neither library passes a buffer. The only "fix" npm offers is downgrading Mineflayer to 1.4.0, so leave it until Mineflayer updates its dependencies (4.39.0, the version used, is the latest). |
