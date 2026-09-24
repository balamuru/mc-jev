# mc-jev

An experiment in controlling a Minecraft (Java Edition) character with software. Bots built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) perceive their surroundings, fight and act on their own. Fast reflexes are plain code. Judgment calls, such as whether to engage or retreat, come from [Jev](https://docs.typesafe.ai), TypeSafe's typed-decision model, reached through OpenRouter.

**Status:** Phase 2 is done: bots connect, reconnect, perceive their surroundings, and fight hostile mobs by rules alone (chase, attack with the right timing, retreat at low HP, eat, wear armor). Survival hardening (Phase 2.5) is next, then Jev decisions in Phase 3. See [docs/phases.md](docs/phases.md).

## How it works

- **Reflex layer:** rules that run every N game ticks (50ms each). They aim, time attacks, strafe, shield and eat, and never wait on the network.
- **Strategic layer:** a batched Jev call every few seconds, and immediately when something happens (the bot is hurt, a new threat appears). Jev's answers set the bot's current intent. If Jev is slow, down or unsure, the rules decide.
- **Several bots:** each bot runs on its own. They can also share what they see and coordinate as a swarm (Phase 6).

Both tick rates are settings. Jev costs about $0.08 per hour per bot at the default rate. Details are in [docs/architecture.md](docs/architecture.md).

## Quickstart

```bash
npm install
cp .env.example .env    # add your OpenRouter key
npm run dev             # connects the bots in config/default.json and prints what they perceive
npm run check           # lint + typecheck + unit tests
```

Node.js 20 or newer is required, and Java 21 or newer for the local server (`./scripts/server.sh`).

## Documentation

| Doc                                          | Contents                                                         |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [docs/setup.md](docs/setup.md)               | Installation, keys, running the server and bot, config reference |
| [docs/architecture.md](docs/architecture.md) | Two-layer design, timing rules, swarms, Jev integration, cost    |
| [docs/requirements.md](docs/requirements.md) | Functional requirements (FR-1 to FR-11)                          |
| [docs/phases.md](docs/phases.md)             | Delivery phases, with scope and tests for each                   |
