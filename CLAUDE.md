# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Phase 0 is done except the first commit: scaffolding, the typed config module (`src/config.ts`) and its tests. The bot itself starts in Phase 1. `docs/phases.md` is the source of truth for scope and status, and `docs/requirements.md` lists the functional requirements (FR-1 to FR-11).

## Commands

```bash
npm run dev                        # runs src/index.ts (Phase 0: validates config, prints bot settings)
npm test                           # unit tests (Vitest, no Minecraft server needed)
npx vitest run test/config.test.ts # a single test file
npx vitest run -t "overrides"      # tests matching a name
npm run lint                       # ESLint
npm run typecheck                  # tsc --noEmit
npm run format                     # Prettier (CI runs `format:check`)
npm run check                      # lint + typecheck + tests
npm run test:integration           # opt-in; needs the local Paper server (Phase 1 onwards)
```

## Architecture

The full write-up is in `docs/architecture.md`. The parts that need reading across files:

- **Two layers per bot.** The reflex layer (`src/reflex/`) runs deterministic rules every `reflex.everyTicks` game ticks (50ms each) and never waits on I/O. The strategic layer (`src/strategic/`) asks Jev for a decision every `strategic.intervalMs` and on trigger events, and the result becomes the bot's current Intent. The reflex layer follows that Intent.
- **Jev never runs inside a game tick.** A call takes roughly 70–500ms. Each bot has one call in flight at a time, and a newer call cancels the older one with `AbortSignal`. On timeout, error, rate limit, exhausted budget or low confidence, the rules decide.
- **All bots share one `JevGateway`** (global `maxCallsPerMinute` and `dailyBudgetUsd`). Each bot is a self-contained `BotAgent` with no global state, so several can run in one process. Swarm messages go through a `Bus` interface (`InProcessBus` first, so NATS can replace it later), with a shared `Blackboard`.
- **Keep the core logic pure** (observe, policy, rules, scheduler, commands, gateway, bus) so it can be unit tested without a Minecraft server.
- **Jev questions and confidence thresholds live in one versioned module**, `src/strategic/questions.ts`.
- **Safety rules live in code, not in Jev.** For example, a bot never attacks its owner or an allowlisted player.

## Jev access

- Use TypeSafe's official SDK, `@typesafe-ai/sdk`, through **OpenRouter**: `TYPESAFE_API_KEY` holds the OpenRouter key and `TYPESAFE_BASE_URL=https://openrouter.ai/api`. The model is `jev-latest`.
- Do not use the third-party `thejevai.com` wrapper or the `jev-ai/jev-agent-skill` package.
- `client.models.list()` doesn't work through OpenRouter, so don't call it.
- The TypeSafe agent skill is installed twice on purpose: as a Claude Code plugin, and as a project copy in `.agents/skills/typesafe-ai` for Gemini. Update both together.

## Conventions

- **Minecraft:** Java Edition (not Bedrock), Mineflayer, and a local server with `online-mode=false` that must never be exposed to the internet.
- **Language:** TypeScript in strict mode, ESM, Node 20 or newer. Config is validated with zod.
- **Commits:** never commit or push without the user's explicit go-ahead. The repo is private on GitHub: `balamuru/mc-jev`.
