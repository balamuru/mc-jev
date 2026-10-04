# Setup Guide

This guide walks you step-by-step from an empty environment to standing inside Minecraft next to your autonomous AI bots, arming them, giving them orders in chat, and watching them fight.

---

## Table of Contents

- [Architecture & Components](#architecture--components)
- [1. Install Prerequisites](#1-install-prerequisites)
- [2. Configure API Keys & Environment](#2-configure-api-keys--environment)
- [3. Start and Configure the Minecraft Server](#3-start-and-configure-the-minecraft-server)
  - [Localhost vs LAN Binding (`server-ip`)](#localhost-vs-lan-binding-server-ip)
  - [Offline Mode & Network Safety](#offline-mode--network-safety)
- [4. Set Up the Minecraft Game Client](#4-set-up-the-minecraft-game-client)
  - [Option A: Prism Launcher (Recommended)](#option-a-prism-launcher-recommended)
  - [Option B: Lunar Client](#option-b-lunar-client)
  - [Option C: Official Minecraft Launcher (Flatpak)](#option-c-official-minecraft-launcher-flatpak)
  - [Troubleshooting Ubuntu .deb Dependency Issues](#troubleshooting-ubuntu-deb-dependency-issues)
  - [Joining the Game](#joining-the-game)
- [5. Configure Bots & Squad](#5-configure-bots--squad)
  - [Setting the Bot Owner](#setting-the-bot-owner)
  - [Configuring Roles and Modes](#configuring-roles-and-modes)
  - [Connecting Bots to LAN IPs (`MC_HOST`)](#connecting-bots-to-lan-ips-mc_host)
- [6. Start the Bots](#6-start-the-bots)
- [7. In-Game Interaction, Combat & Chat Orders](#7-in-game-interaction-combat--chat-orders)
  - [Teleporting and Arming Bots](#teleporting-and-arming-bots)
  - [In-Game Chat Commands](#in-game-chat-commands)
  - [Testing Combat and Squad Mechanics](#testing-combat-and-squad-mechanics)
- [8. Automated Tests & Benchmarks](#8-automated-tests--benchmarks)
- [9. Configuration Reference (`config/default.json`)](#9-configuration-reference-configdefaultjson)
- [10. Troubleshooting Guide](#10-troubleshooting-guide)

---

## Architecture & Components

Running `mc-jev` involves three programs running on your machine:

```
 ┌────────────────────────┐        ┌──────────────────────────────┐
 │ Minecraft Game Client  │        │ mc-jev Runtime (npm run dev) │
 │ (Human observer / OP)  │        │ - Mineflayer bots            │
 │ Prism / Lunar / Mojang │        │ - Reflex loop (50ms)         │
 └───────────┬────────────┘        │ - Strategic layer (AI/Rules) ┼──► OpenRouter / TypeSafe
             │                     └──────────────┬───────────────┘
             │  localhost / LAN IP                │  localhost / LAN IP
             ▼                                    ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ Paper Minecraft Server (./scripts/server.sh), Minecraft 26.1.2 │
 │ online-mode=false (bots connect without Mojang accounts)       │
 └────────────────────────────────────────────────────────────────┘
```

1. **The Server:** The Paper server is the world simulation. Both you and the bots join as players on this server.
2. **The Bots:** Headless Node.js programs that log into the server as players. They require no official Minecraft account.
3. **The Game Client *(Optional)*:** Without a client, the bots still fight and log decisions to your terminal. With a client, you can watch them in creative mode, test player combat, and command them in chat.

---

## 1. Install Prerequisites

| Tool | Minimum Version | Needed For |
| :--- | :--- | :--- |
| **Node.js** | 20 or newer (CI uses 22) | Running bots, tests, and benchmarks |
| **Java** | **25** or newer | Running the Paper server for Minecraft 26.1.2 |
| **git, curl, python3, bash** | Any recent version | Repository checkout and `./scripts/server.sh` |
| **Minecraft Client** | Minecraft: Java Edition 26.1.2 | Optional: observing and commanding bots in-game |
| **OpenRouter API Key** | — | Optional: AI judgment calls (bots fall back to rules without it) |

### Linux (Debian / Ubuntu)

```bash
# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git curl python3

# Java 25 (from distribution or Eclipse Temurin)
sudo apt install -y openjdk-25-jre-headless
```

### macOS (Homebrew)

```bash
brew install node git python
brew install --cask temurin     # Installs latest Temurin JDK (25 or newer)
```

### Windows

Use **WSL2 (Ubuntu)** and follow the Linux instructions inside WSL. WSL2 automatically forwards `localhost` to Windows, allowing a Minecraft client running in Windows to connect to the server running in WSL.

Verify your installed versions:
```bash
node --version    # Should report v20+
java -version     # Should report version 25+
```

---

## 2. Configure API Keys & Environment

Bots use **Jev** (TypeSafe’s typed decision model) via OpenRouter to make strategic choices (e.g. whether to retreat or press an attack). Without an API key, bots still fight reliably using deterministic fallback rules.

1. Clone and install project dependencies:
   ```bash
   git clone git@github.com:balamuru/mc-jev.git
   cd mc-jev
   npm install
   ```

2. Create your `.env` file:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your API credentials:
   ```env
   TYPESAFE_API_KEY=your_openrouter_key_here
   TYPESAFE_BASE_URL=https://openrouter.ai/api
   ```

- **Cost Safety:** Jev calls cost ~$0.00003 each (under $0.06/hour per bot in continuous combat). The default daily spending cap (`gateway.dailyBudgetUsd: 1.0` in `config/default.json`) stops API calls once reached for the day, safely reverting to rules.
- **Using TypeSafe Directly:** If you have a direct TypeSafe API key, set `TYPESAFE_API_KEY` and omit `TYPESAFE_BASE_URL`.

---

## 3. Start and Configure the Minecraft Server

Open a terminal and start the server:

```bash
./scripts/server.sh
```

On the first run, the script will:
1. Fetch and download the latest Paper build for Minecraft **26.1.2** into `server/` and verify its SHA-256 checksum.
2. Prompt you to accept the [Minecraft EULA](https://aka.ms/MinecraftEULA). Type `yes` to accept.
3. Generate `server/server.properties` and generate the world files.
4. Print `Done (...s)! For help, type "help"` when ready.

Keep this terminal open—it is your **server console**. Commands typed here run with root operator permissions without a leading `/` (e.g. `stop`, `time set night`, `op <player>`).

### Localhost vs LAN Binding (`server-ip`)

By default, the server writes `server-ip=127.0.0.1` to [`server/server.properties`](file:///home/vinayb/CodeProjects/mc-jev/server/server.properties#L60), which restricts connections strictly to the same machine.

To allow connections from other machines on your local network (LAN) or your LAN IP:

* **Recommended (Listen on both `localhost` and LAN):**
  In [`server/server.properties`](file:///home/vinayb/CodeProjects/mc-jev/server/server.properties#L60), leave `server-ip` blank:
  ```properties
  server-ip=
  ```
  Leaving it blank binds the server to `0.0.0.0`. This allows local bots connecting to `localhost` and external clients connecting via your LAN IP (e.g. `192.168.1.147`) to connect at the same time.

* **Explicit LAN IP Binding:**
  If you set `server-ip=192.168.1.147`, Java will bind strictly to that network interface and reject connections to `localhost`. If you do this, you must configure the bots with `MC_HOST=192.168.1.147` (see [Step 5](#connecting-bots-to-lan-ips-mc_host)).

### Offline Mode & Network Safety

The server starts with:
```text
Starting paper-26.1.2-74.jar (online-mode=false; keep this server off the internet).
```

* **Why offline mode?** In `online-mode=false`, Mojang/Microsoft account verification is disabled. This is required so headless AI bot agents can connect as players without owning individual paid accounts.
* **Why keep it off the internet?** In offline mode, anyone who can reach port 25565 can log in under any username (including server operator accounts) without a password.
* **Is LAN safe?** **Yes.** Connecting from within your home LAN is completely private and safe, provided you do **not** set up port-forwarding on your home router for port 25565.

---

## 4. Set Up the Minecraft Game Client

You need a Minecraft: Java Edition client configured for version **26.1.2** to join the server and observe your bots.

### Option A: Prism Launcher (Recommended)
[Prism Launcher](https://prismlauncher.org/) is an open-source launcher ideal for bot development because it supports offline accounts, instant version selection, and isolated instances.

1. **Install via Flatpak:**
   ```bash
   flatpak install flathub org.prismlauncher.PrismLauncher
   ```
2. **Launch:** Run `flatpak run org.prismlauncher.PrismLauncher` or open it from your applications menu.
3. **Add Account:** Click **Accounts** in the top right. You can add an **Offline account** with any username (e.g. your name), or add your Microsoft account.
4. **Create Instance:** Click **Add Instance**, select version **26.1.2**, and launch.

### Option B: Lunar Client
Lunar Client is a popular PvP client that bundles performance optimizations (Sodium/Iris).

1. **Install via Snap:**
   ```bash
   sudo snap install lunar-client
   ```
   *(Or via Flatpak: `flatpak install flathub com.lunarclient.LunarClient`)*
2. **Version Selection:** On the main launch screen, click the version dropdown arrow next to the green launch button and select **26.1.2**.
3. **Log in:** Log in with your Microsoft account and click Launch.

### Option C: Official Minecraft Launcher (Flatpak)
1. **Install via Flatpak:**
   ```bash
   flatpak install flathub com.mojang.Minecraft
   ```
2. **Create Profile:** Open **Installations → New installation**, select version **release 26.1.2**, and save.

### Troubleshooting Ubuntu .deb Dependency Issues

If you downloaded Mojang's official `Minecraft.deb` on modern Ubuntu (24.04 or 26.04) and encountered:
```text
dpkg: dependency problems prevent configuration of minecraft-launcher:
 minecraft-launcher depends on libgdk-pixbuf2.0-0; however: Package libgdk-pixbuf2.0-0 is not installed.
```
This occurs because the legacy `.deb` package references outdated package names (`libgdk-pixbuf2.0-0`) that Ubuntu has renamed (`libgdk-pixbuf-2.0-0`).

**Fix:** Clean up the unconfigured package and use Flatpak instead:
```bash
sudo dpkg --purge minecraft-launcher
flatpak install flathub com.mojang.Minecraft
```

### Joining the Game

1. In your Minecraft client, go to **Multiplayer → Direct Connection** (or **Add Server**).
2. **Server Address:**
   * If playing on the same machine: `localhost` (or `127.0.0.1`).
   * If connecting across your home network: Your server machine's LAN IP (e.g. `192.168.1.147`).
3. Click **Join Server**.

---

## 5. Configure Bots & Squad

Bot configurations live in [`config/default.json`](file:///home/vinayb/CodeProjects/mc-jev/config/default.json). To keep your local edits out of git, copy it to `config/local.json`:

```bash
cp config/default.json config/local.json
echo 'MC_JEV_CONFIG=config/local.json' >> .env
```

### Setting the Bot Owner

Set your in-game Minecraft username as the bot's `owner`. The bot will obey your chat orders and will **never** attack you:

```json
  "bots": [
    {
      "username": "JevBot",
      "owner": "YourMinecraftUsername",
      "role": "fighter"
    }
  ]
```

### Configuring Roles and Modes

You can spawn single bots or a cooperative squad:

```json
  "swarm": {
    "mode": "cooperative"
  },
  "bots": [
    { "username": "JevBot", "owner": "YourName", "role": "tank", "mode": "guard" },
    { "username": "ScoutBot", "owner": "YourName", "role": "scout", "mode": "hunt" },
    { "username": "ArcherBot", "owner": "YourName", "role": "ranged", "mode": "guard" }
  ]
```

* **Squad Roles:**
  * `fighter` (default): Balanced melee combatant.
  * `tank`: Closes in, holds threat, prioritizes armor and shield.
  * `ranged`: Keeps distance and uses bow and arrows.
  * `support`: Stays near allies and assists injured teammates.
  * `scout`: Roams ahead and identifies incoming threats.
* **Default Modes:**
  * `guard` (default): Holds position and defends the immediate area against threats.
  * `hunt`: Actively wanders and hunts hostile mobs within 24 blocks.
  * `idle`: Stands still and observes.

### Connecting Bots to LAN IPs (`MC_HOST`)

If your Paper server is bound exclusively to a specific LAN IP (e.g. `server-ip=192.168.1.147`), bots attempting to connect to `localhost` will fail. 

Point the bots to your LAN IP in `.env`:
```env
MC_HOST=192.168.1.147
MC_PORT=25565
```
*(Or specify it inline: `MC_HOST=192.168.1.147 npm run dev`)*.

---

## 6. Start the Bots

Open a second terminal window and run:

```bash
npm run dev
```

The runtime will connect each configured bot to the server and begin printing live status snapshots once per second:

```text
mc-jev: server localhost:25565
Jev: key present via https://openrouter.ai/api
bot JevBot (fighter, guard): reflex every 50ms, strategic every 2000ms, Jev timeout 1000ms
[JevBot] hp 20 food 20 at (229, 73, 31) holding empty hand | zombie 5.2m ahead approaching
```

In Minecraft, you will see the in-game announcement:
```text
JevBot joined the game
```

To stop the bots, press **Ctrl+C** in the terminal. A usage summary showing API calls, latency, and dollars spent will be displayed.

---

## 7. In-Game Interaction, Combat & Chat Orders

### Teleporting and Arming Bots

1. **Make yourself a server operator:**
   In your server console terminal, run:
   ```text
   op YourMinecraftUsername
   ```
2. **Teleport the bot to you:**
   In Minecraft chat (press `T` or `/`), type:
   ```text
   /tp JevBot YourMinecraftUsername
   ```
3. **Arm the bot:**
   Give the bot armor and weapons. The bot will automatically equip the best gear in its inventory:
   ```text
   /give JevBot iron_sword
   /give JevBot iron_helmet
   /give JevBot iron_chestplate
   /give JevBot iron_leggings
   /give JevBot iron_boots
   /give JevBot shield
   /give JevBot bow
   /give JevBot arrow 64
   /give JevBot cooked_beef 16
   ```

### In-Game Chat Commands

Type these directly into in-game chat (no `/` prefix). Only the designated `owner` is obeyed:

| Command | Effect |
| :--- | :--- |
| `follow` (or `follow me`) | Bot follows behind the owner. It pauses following to fight hostiles, then resumes. |
| `guard here` | Holds current position and defends the perimeter, returning to post if dragged away. |
| `hunt` | Actively seeks and attacks hostile mobs within 24 blocks. |
| `stop` | Disables combat and movement until told `auto`. |
| `auto` | Resumes default behavior (`bots[].mode`). |
| `status` | Bot reports current mode, HP, food, and nearest threat in chat. |
| `help` | Lists available chat commands. |

* **Targeting specific bots:** A command like `follow` applies to all bots you own. To target a single bot in a squad, prefix the command: `JevBot follow` or `@ArcherBot stop`.

### Testing Combat and Squad Mechanics

1. Switch yourself to creative or spectator mode so mobs ignore you:
   ```text
   /gamemode creative
   ```
2. Set the time to night:
   ```text
   /time set night
   ```
3. Summon hostile mobs near the bot:
   ```text
   /summon zombie ~4 ~ ~
   /summon skeleton ~8 ~ ~
   /summon creeper ~6 ~ ~
   ```
4. Watch the bot aim, raise its shield, kite creepers outside blast radius, shoot distant targets with a bow, and switch to sword when mobs close the gap.

---

## 8. Automated Tests & Benchmarks

```bash
# Code Quality Checks
npm test                          # Run unit tests
npm run lint && npm run typecheck # ESLint and TypeScript checks
npm run check                     # Combined lint, typecheck, and unit tests

# Integration Testing
npm run test:integration          # Combat tests on isolated throwaway servers
npm run test:live                 # Live test validating real Jev model decisions

# Benchmarking
npm run benchmark:survival        # Automated mob survival benchmark
npm run benchmark:squad           # Squad coordination benchmark across mob waves
npm run analyze:decisions         # Summarizes logs in logs/ (costs, latencies, tactics)
```

- **Integration Tests:** `npm run test:integration` spins up dedicated Paper server instances on isolated ports (25586–25599) with empty flat worlds to test combat, eating, armor equipping, chat commands, and bot duels.
- **Decision Logs:** Decisions made by Jev are recorded in `logs/decisions-YYYY-MM-DD.jsonl`. Inspect them in real time with:
  ```bash
  tail -f logs/decisions-*.jsonl | jq -c '{agent, trigger, outcome, why, intent: .intent.tactic, latencyMs, costUsd}'
  ```

---

## 9. Configuration Reference (`config/default.json`)

### Server Settings

| Setting | Meaning | Default |
| :--- | :--- | :--- |
| `server.host`, `server.port` | Server address (overridden by `MC_HOST` and `MC_PORT`). | `localhost:25565` |
| `server.version` | Minecraft protocol version (`false` to auto-detect). | `false` |
| `server.staggerMs` | Delay between starting successive bots in a squad. | `1000` |

### API Gateway Limits

| Setting | Meaning | Default |
| :--- | :--- | :--- |
| `gateway.maxCallsPerMinute` | API rate limit ceiling across all bots. | `300` |
| `gateway.dailyBudgetUsd` | Daily spend limit in USD. When reached, bots revert to rules. | `1.0` |

### Swarm & Squad Coordination

| Setting | Meaning | Default |
| :--- | :--- | :--- |
| `swarm.mode` | `independent`, `cooperative`, or `coordinated`. | `cooperative` |
| `swarm.claimTtlMs` | Duration a target claim holds before expiring. | `8000` |
| `swarm.helpHp` | Ally HP threshold to trigger assistance from teammates. | `8` |
| `swarm.helpAllies` | Whether squad members assist allies in distress. | `true` |
| `swarm.coordinator.intervalMs` | How often coordinator analyzes combat state. | `4000` |
| `swarm.coordinator.directiveTtlMs`| Duration of coordinator squad focus directives. | `6000` |
| `swarm.coordinator.model` | Model used for coordinator decisions. | `jev-latest` |
| `swarm.coordinator.assignRoles` | Dynamically assign squad roles based on combat state. | `true` |

### Per-Bot Combat & Reflex Defaults

| Setting | Meaning | Default |
| :--- | :--- | :--- |
| `defaults.perception.radiusBlocks` | Max entity perception distance. | `24` |
| `defaults.perception.maxEntities` | Max entities tracked simultaneously. | `8` |
| `defaults.reflex.everyTicks` | Reflex loop rate (1 tick = 50ms). | `1` |
| `defaults.rules.pvp` | Defend against hostile players. | `true` |
| `defaults.rules.shield` | Raise shield between attacks / against arrows. | `false` |
| `defaults.rules.strafeMobs` | Side-step melee mobs during weapon cooldown. | `false` |
| `defaults.rules.bow` | Shoot bow at range, melee closer in. | `true` |
| `defaults.rules.creeperHitAndRun` | Strike creeper and step back outside blast range. | `true` |
| `defaults.rules.bowMinBlocks` | Minimum distance for bow (switches to sword below this). | `6` |
| `defaults.rules.bowMaxBlocks` | Maximum distance for bow engagement. | `20` |
| `defaults.rules.retreatHp` | HP threshold to trigger retreat. | `6` |
| `defaults.rules.resumeHp` | HP required before resuming combat after retreat. | `14` |
| `defaults.rules.engageRadiusBlocks`| Hostile engagement range. | `16` |
| `defaults.rules.eatBelowFood` | Food level to trigger eating. | `15` |
| `defaults.rules.noEatRadiusBlocks` | Distance to hostile mob that forbids eating. | `10` |
| `defaults.rules.dangerMargin` | Fight if expected damage is below this fraction of HP. | `0.8` |
| `defaults.strategic.intervalMs` | Periodic strategic decision interval. | `2000` |
| `defaults.strategic.eventTriggers` | Events triggering immediate strategic evaluation. | `["hurt", "newThreat", "lowHp"]` |
| `defaults.jev.model` | Strategic decision model. | `jev-latest` |
| `defaults.jev.thresholds.act` | Confidence required to execute model tactic. | `0.7` |
| `defaults.jev.thresholds.cautious`| Confidence threshold for cautious action. | `0.5` |

---

## 10. Troubleshooting Guide

| Symptom | Cause | Solution |
| :--- | :--- | :--- |
| `Failed to bind to port` | Port 25565 is already in use by another server instance. | Stop the running instance (`stop` in console), or check `ss -tulpn \| grep 25565`. |
| Bot fails to connect: `ECONNREFUSED 127.0.0.1:25565` | Server is bound to a specific LAN IP (e.g. `192.168.1.147`) instead of all interfaces. | Either set `MC_HOST=192.168.1.147` in `.env`, or leave `server-ip=` blank in `server/server.properties` and restart the server. |
| Game client says `Outdated client` or `Outdated server` | Client version does not match server version (**26.1.2**). | In Lunar Client or Prism Launcher, configure your profile/instance to version **26.1.2**. |
| Game client says `Failed to verify username` | Server was started with `online-mode=true`. | Set `online-mode=false` in `server/server.properties` and restart the server. |
| Bot ignores your chat commands | Username does not match `owner` in bot config. | Verify your exact in-game name (press `Tab` in-game) and set `"owner": "YourName"` in `config/default.json` or `config/local.json`. |
| Bot doesn't fight back when you hit it | By design: bots never attack their owner, allies, or teammates. | To test player combat, hit the bot from an account not listed as `owner` or in `allies`. |
| `UnsupportedClassVersionError` or Java version error | Java runtime is older than Java 25. | Minecraft 26.1.2 requires Java 25. Verify with `java -version` and install `openjdk-25-jre-headless`. |
| Ubuntu `dpkg: dependency problems... libgdk-pixbuf2.0-0` | Legacy `.deb` dependencies on modern Ubuntu. | Run `sudo dpkg --purge minecraft-launcher`, then install via Flatpak: `flatpak install flathub com.mojang.Minecraft`. |
| `Jev: no key, so the bots run on rules only` | `.env` missing or `TYPESAFE_API_KEY` unset. | Set `TYPESAFE_API_KEY` in `.env`. Bots will continue operating on deterministic rules in the meantime. |
| Bots disconnect with `socketClosed` or enter 30s reconnect loops | Paper connection throttling drops rapid successive bot logins from the same IP. | Set `connection-throttle: 0` in `server/bukkit.yml` and restart the server. |
