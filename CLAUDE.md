# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Phases 0-10 are done (Phases 8-11 close gaps from a plan review, see `docs/plan-gap-closure.md`; 11 coverage and housekeeping is next): scaffolding and config, connection and perception, the rules-based reflex layer, survival hardening, the Jev strategic layer, modes with owner chat commands, player combat, multiple bots with swarms, and measurement-driven tuning. `docs/tuning.md` and `docs/survival-benchmark.md` record what the benchmarks showed; re-run them before changing a default. `docs/phases.md` is the source of truth for scope and status, and `docs/requirements.md` lists the functional requirements (FR-1 to FR-12).

## Commands

```bash
npm run dev                        # connects the configured bots and prints what they perceive
npm test                           # unit tests (Vitest, no Minecraft server needed)
npx vitest run test/config.test.ts # a single test file
npx vitest run -t "overrides"      # tests matching a name
npm run lint                       # ESLint
npm run typecheck                  # tsc --noEmit
npm run format                     # Prettier (CI runs `format:check`)
npm run check                      # lint + typecheck + tests
npm run test:integration           # opt-in; starts throwaway flat-world Paper servers (ports 25593-25599)
npm run test:live                  # opt-in; a few real Jev calls with the key in .env (fractions of a cent)
npm run benchmark:survival         # opt-in; ~15 min; survival rate per fight scenario (see docs/survival-benchmark.md); add --jev to use the real API
npm run benchmark:squad            # opt-in; three bots vs a wave, per swarm mode (see docs/tuning.md)
npm run eval:jev                   # opt-in; the Jev question set on labeled situations (a fraction of a cent)
npm run analyze:decisions          # summarize logs/decisions-*.jsonl
```

## Architecture

The full write-up is in `docs/architecture.md`. The parts that need reading across files:

- **Two layers per bot.** The reflex layer (`src/reflex/`) runs deterministic rules every `reflex.everyTicks` game ticks (50ms each) and never waits on I/O. The strategic layer (`src/strategic/`) asks Jev for a decision every `strategic.intervalMs` and on trigger events, and the result becomes the bot's current Intent. The reflex layer follows that Intent.
- **Jev never runs inside a game tick.** A call takes about 270ms (measured). Each bot has one call in flight at a time, and a newer call cancels the older one with `AbortSignal`. On timeout, error, rate limit, exhausted budget or low confidence, the rules decide.
- **All bots share one `JevGateway`** (global `maxCallsPerMinute` and `dailyBudgetUsd`). Each bot is a self-contained `BotAgent` with no global state, so several can run in one process. Swarm messages go through a `Bus` interface (`InProcessBus` first, so NATS can replace it later), with a shared `Blackboard`.
- **Keep the core logic pure** (observe, policy, rules, scheduler, commands, gateway, bus) so it can be unit tested without a Minecraft server.
- **Jev questions and confidence thresholds live in one versioned module**, `src/strategic/questions.ts`.
- **Safety rules live in code, not in Jev.** For example, a bot never attacks its owner or an allowlisted player.
- **Perception is pure.** `src/perception/observe.ts` turns plain data into a `Snapshot`, and `src/agent/mineflayerAdapter.ts` is the only place that reads a Mineflayer bot. Bots are typed through the structural `BotLike` interface, so tests use `test/fakeBot.ts` instead of a server.
- **Rules are the fallback policy.** `src/reflex/rules.ts` maps a `Snapshot` (plus the previous `Intent`) to an `Intent`: engage the nearest visible non-neutral hostile. **Retreating is off by default (`rules.retreat: false`)**: `docs/survival-benchmark.md` shows a bot that fights on survives far more often than one that flees, because our retreat has no safe destination. The danger estimate (`src/reflex/danger.ts`, calibrated on the benchmark), retreat hysteresis and failed-retreat detection remain, tested, for when it is switched on. `ReflexLoop` applies intents through an `Actuator`, and `MineflayerActuator` (`src/agent/actuator.ts`) is the real one.
- **Who decides each reflex step:** a fight-back after a failed retreat, else Jev's override (`ReflexLoop.setOverride`), else the current mode (`ModeController` in `src/control/modes.ts`, which uses the rules for combat). Intents are `idle`, `engage`, `retreat`, `follow` and `goto`.
- **Strategic layer** (`src/strategic/`): `layer.ts` schedules and applies decisions, `gateway.ts` is the shared limiter (rate, daily budget, cooldowns, one call per bot), `jev.ts` wraps the SDK, `questions.ts` builds the versioned question set, `policy.ts` merges Jev with the rules (Jev can add caution freely, but cannot remove it at critical HP). Every decision goes to `logs/decisions-*.jsonl`.
- **Player combat.** A player is a threat only after attacking the bot (`src/perception/provocation.ts`) or when Jev is very sure and they are armed and close. The owner, `allies` and other configured bots are never attacked: `isProtectedPlayer` is enforced in the rules, in Jev's target list and in the actuator, and `protectedFor(config)` always adds the owner. Do not build a `BotConfig` by hand without going through it. A sword swing on the ground sweeps into anyone next to the target, so `src/reflex/sweep.ts` makes the bot swing only as a critical hit when another player is within 2 blocks of its target; keep that check in any new attack path. Arrows get the same protection: `shotEndangers` in `src/reflex/bow.ts` refuses a release whose path passes near a protected player.
- **Swarm** (`src/swarm/`): `buildApp` (`src/app.ts`) assembles everything. Bots share a `Bus` (JSON events, in-process so NATS can replace it) and a `Blackboard` (allies, first-wins claims with expiry, known threats, coordinator focus); each bot has a `SwarmMember`. `ModeController` uses it for focus fire, avoiding claimed targets and helping hurt allies. `swarm.mode: independent` makes bots ignore all of it; `cooperative` is the default because the benchmark showed it cuts squad damage by about a third (`docs/tuning.md`). The coordinator only issues time-limited focus directives and role assignments, so bots never depend on it. Roles (`src/control/roles.ts`: fighter, tank, support, scout, ranged) adjust combat intents in `ModeController.withRole`, which the reflex loop also applies to Jev's overrides (`adjustOverride`); without Jev the coordinator assigns roles by gear (`rolesByGear`).
- **Chat commands** (`src/control/commands.ts`): exact-match, owner-only. The owner is looked up directly through `bot.players` so following works beyond the perception radius.
- **No `mineflayer-pvp`.** It is unmaintained and relies on the deprecated `physicTick` event, so combat (aim, reach check, weapon cooldown) is our own code in `MineflayerActuator`. Pathfinder, auto-eat and armor-manager are used; armor-manager only reacts to picked-up items, so `attachPlugins` also re-checks armor when an armor item enters the inventory.
- **`mineflayer-pathfinder` is loaded with `createRequire`** because Node's ESM loader does not expose its `goals` export.
- **Integration tests** (`test/integration/`) start a throwaway Paper server in `server/it-<port>/` (fresh flat world at night, natural regeneration off, reusing the cache from `server/`) and drive it through its console, e.g. `execute at <bot> run summon zombie ~6 ~ ~`. Use `execute at X run tp X ~N ~ ~`: with `execute as`, `~` is relative to the console, not to X. Run `./scripts/server.sh` once first so `server/` has the EULA and cache. On this server version, gamerules are snake_case: `advance_time`, `mob_griefing`, `natural_health_regeneration`, `spawn_mobs`. Test worlds turn `mob_griefing` off, because creeper craters pile up over many trials and trap the bot, and `spawn_mobs` off, because `spawn-monsters=false` doesn't stop slimes.
- **Mineflayer yaw convention:** 0 faces -Z and positive turns left. `relativeYaw` in `src/perception/geometry.ts` depends on it.

## Jev access

- Use TypeSafe's official SDK, `@typesafe-ai/sdk`, through **OpenRouter**: `TYPESAFE_API_KEY` holds the OpenRouter key and `TYPESAFE_BASE_URL=https://openrouter.ai/api`. The model is `jev-latest`.
- Do not use the third-party `thejevai.com` wrapper or the `jev-ai/jev-agent-skill` package.
- `client.models.list()` doesn't work through OpenRouter, so don't call it.
- The SDK leaks an unobserved `AbortError` when a call is cancelled or times out mid-body, which would crash the process. `installAbortGuard` in `src/strategic/jev.ts` handles it; keep it if you touch the client, and don't remove it because "nothing crashed".
- The TypeSafe agent skill is installed twice on purpose: as a Claude Code plugin, and as a project copy in `.agents/skills/typesafe-ai` for Gemini. Update both together.

## Conventions

- **Minecraft:** Java Edition (not Bedrock), Mineflayer, and a local server with `online-mode=false` that must never be exposed to the internet.
- **Language:** TypeScript in strict mode, ESM, Node 20 or newer. Config is validated with zod.
- **Commits:** never commit or push without the user's explicit go-ahead. The repo is private on GitHub: `balamuru/mc-jev`.
