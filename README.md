# mc-jev

An experiment in controlling a Minecraft (Java Edition) character with software. Bots built on [Mineflayer](https://github.com/PrismarineJS/mineflayer) perceive their surroundings, fight and act on their own. Fast reflexes are plain code. Judgment calls, such as whether to engage or retreat, come from [Jev](https://docs.typesafe.ai), TypeSafe's typed-decision model, reached through OpenRouter.

**Status:** Phases 0-4 are done. Bots connect and reconnect, perceive their surroundings, fight hostile mobs by rules, ask Jev for judgment calls (with the rules as a safety net), and take orders from their owner in chat. Next: player combat (Phase 5), then swarms (Phase 6). See [docs/phases.md](docs/phases.md).

## How it works

- **Reflex layer:** rules that run every N game ticks (50ms each). They aim, time attacks, strafe, shield and eat, and never wait on the network.
- **Strategic layer:** a batched Jev call every few seconds, and immediately when something happens (the bot is hurt, a new threat appears). Jev's answers set the bot's current intent. If Jev is slow, down or unsure, the rules decide.
- **Orders:** the owner can tell a bot to `follow`, `guard here`, `hunt`, `stop` and more, in chat.
- **Several bots:** each bot runs on its own. They can also share what they see and coordinate as a swarm (Phase 6).

Both tick rates are settings. Jev costs about $0.00003 per call, under $0.06 per hour per bot even with a threat present all the time. Details are in [docs/architecture.md](docs/architecture.md).

## Quickstart

```bash
npm install
cp .env.example .env    # add your OpenRouter key
npm run dev             # connects the bots in config/default.json and prints what they perceive
npm run check           # lint + typecheck + unit tests
npm run test:integration  # fights on throwaway local servers (run ./scripts/server.sh once first)
```

Node.js 20 or newer is required, and Java 21 or newer for the local server (`./scripts/server.sh`).

## Documentation

| Doc                                                      | Contents                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------- |
| [docs/setup.md](docs/setup.md)                           | Installation, keys, running the server and bot, config reference |
| [docs/architecture.md](docs/architecture.md)             | Two-layer design, timing rules, swarms, Jev integration, cost    |
| [docs/requirements.md](docs/requirements.md)             | Functional requirements (FR-1 to FR-11)                          |
| [docs/survival-benchmark.md](docs/survival-benchmark.md) | Survival benchmark: method, results and what they mean           |
| [docs/phases.md](docs/phases.md)                         | Delivery phases, with scope and tests for each                   |
