# mc-jev

An experiment in controlling Minecraft (Java Edition) characters with AI. Bots built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) perceive their surroundings, fight, and cooperate autonomously. 

- **Fast reflexes are deterministic code:** Aiming, timing attacks, strafing, raising shields, and shooting bows run on high-frequency game ticks without waiting on network calls.
- **Judgment calls come from AI:** Complex decisions—such as whether to press an attack, retreat, or coordinate squad targets—are made by [Jev](https://docs.typesafe.ai), TypeSafe's fast typed-decision model (via OpenRouter), with local rule engines serving as a fallback.

**Status:** Phases 0–11 complete. Bots support single and multi-bot squads, role specializations (fighter, tank, support, scout, ranged), in-game chat orders from human owners, self-defense against players, and comprehensive survival benchmarks.

---

## Architecture Overview

```
                      ┌───────────────────────────────┐
                      │    OpenRouter / TypeSafe      │
                      │  (Jev typed decision model)   │
                      └───────────────▲───────────────┘
                                      │ Jev calls (~every 2s or on-event)
 ┌────────────────────────┐   ┌───────┴───────────────────────┐
 │ Minecraft Game Client  │   │     mc-jev Bot Runtime        │
 │ (Human observer / OP)  │   │  - Reflex layer (50ms ticks)  │
 │ Prism / Lunar / Mojang │   │  - Strategic layer (AI/Rules) │
 └───────────┬────────────┘   │  - Swarm coordinator          │
             │                └───────────────┬───────────────┘
             │                                │
             ▼                                ▼
 ┌────────────────────────────────────────────────────────────┐
 │ Paper Minecraft Server (Minecraft 26.1.2)                 │
 │ Runs locally or on LAN (online-mode=false)                 │
 └────────────────────────────────────────────────────────────┘
```

1. **Reflex Layer:** Executes every tick (50ms). Handles aiming, timing strikes, raising shields, strafing, shooting bows, and eating. Never blocked by network latency.
2. **Strategic Layer:** Batched Jev calls run every few seconds and immediately on combat events (taking damage, new threats, low HP). If the model is slow, offline, or uncertain, the local rule engine takes over seamlessly.
3. **Owner Commands:** Human players can command bots in-game using plain chat (`follow`, `guard here`, `hunt`, `stop`). Bots will defend their owner and allies.
4. **Squad Coordination:** Multiple bots share an API budget and coordinate targets, roles, and mutual assistance without dogpiling the same hostile mob.

---

## Getting Started

To run `mc-jev`, three components interact together:
1. **The Server:** A local Paper server running Minecraft 26.1.2.
2. **The Bots:** The Node.js application running the bot logic (`npm run dev`).
3. **The Game Client *(Optional)*:** Your own Minecraft client (Prism Launcher, Lunar Client, or Official Launcher) to watch and command the bots in-game.

### Quick Workflow

```bash
# 1. Install dependencies
npm install

# 2. Add your OpenRouter API key (optional, bots fall back to rules without it)
cp .env.example .env

# 3. Start the local Minecraft server in terminal 1
./scripts/server.sh

# 4. Start the bots in terminal 2
npm run dev
```

For full, step-by-step setup instructions—including configuring LAN access, setting up Prism/Lunar launchers, arming bots, and issuing chat commands—see **[docs/setup.md](docs/setup.md)**.

---

## Developer Commands

```bash
# Code Quality
npm run check              # Run linter, typecheck, and unit tests (all in one)
npm run lint               # Run ESLint
npm run typecheck          # Check TypeScript types
npm test                   # Run unit tests via Vitest

# Integration & Benchmarks
npm run test:integration   # Automated combat integration tests on throwaway servers
npm run test:live          # Live test verifying real Jev model decisions
npm run benchmark:survival # Measure bot survival rates against hostile mob waves
npm run benchmark:squad    # Benchmark multi-bot squad performance
npm run analyze:decisions  # Analyze latency, cost, and decision patterns in logs/
```

---

## Documentation

| Document | Purpose |
| :--- | :--- |
| **[docs/setup.md](docs/setup.md)** | **Step-by-step setup guide**: Tools, server, game clients (Prism/Lunar), bot config, in-game commands, and troubleshooting. |
| **[docs/architecture.md](docs/architecture.md)** | Deep dive into the two-layer reflex/strategic architecture, timing, swarms, Jev prompts, and costs. |
| **[docs/requirements.md](docs/requirements.md)** | Functional requirements specification (FR-1 through FR-11). |
| **[docs/survival-benchmark.md](docs/survival-benchmark.md)** | Survival benchmark methodology, empirical results, and combat tuning decisions. |
| **[docs/tuning.md](docs/tuning.md)** | Tuning parameters and findings from Phase 7 onwards. |
| **[docs/blog-post.md](docs/blog-post.md)** | Architectural deep dive & blog post on dual-speed AI companions in Minecraft. |
| **[docs/phases.md](docs/phases.md)** | Detailed implementation breakdown across all development phases. |

---

## License

This project is licensed under the Apache License, Version 2.0 - see the [LICENSE](LICENSE) file for details.
