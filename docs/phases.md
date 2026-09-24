# Phases

Each phase ends with `npm run check` passing, the phase's integration scenario working where there is one, the docs updated, and a commit you have approved.

| Phase | Scope                                         | Requirements     | Status  |
| ----- | --------------------------------------------- | ---------------- | ------- |
| 0     | Repo and scaffolding                          | FR-9             | Done    |
| 1     | Server, connection and perception             | FR-1, FR-2       | Done    |
| 2     | Reflex layer: rules-only fighter against mobs | FR-3             | Done    |
| 2.5   | Survival hardening                            | FR-12            | Done    |
| 3     | Jev strategic layer against mobs              | FR-4, FR-5, FR-8 | Done    |
| 4     | Modes and chat commands                       | FR-6             | Done    |
| 5     | Player combat                                 | FR-7             | Planned |
| 6     | Multiple bots and swarm                       | FR-10, FR-11     | Planned |
| 7     | Tuning (optional)                             | none             | Planned |

## Phase 0: Repo and scaffolding

- A private GitHub repo, `balamuru/mc-jev`.
- TypeScript in strict mode, with `tsx`, Vitest, ESLint and Prettier.
- A GitHub Actions CI job that runs lint, format check, typecheck and unit tests.
- A typed config module with `defaults`, per-bot overrides and shared gateway limits, plus unit tests.
- Docs: README, setup, architecture, requirements and phases.

## Phase 1: Server, connection and perception

- **`scripts/server.sh`:**
  - downloads Paper for the newest Minecraft version Mineflayer supports into `server/` (gitignored)
  - asks you before accepting the Minecraft EULA
  - sets `online-mode=false`
- **`BotAgent`:** connects, loads plugins, and reconnects with backoff. It holds no global state.
- **`observe()` and `visibility`:** pure functions that turn bot data into a `Snapshot`.
- **Tests:**
  - Unit tests for `observe` using fake entities.
  - An integration test in which the bot spawns and prints snapshots.

## Phase 2: Reflex layer against mobs

- **Plugins:** `mineflayer-pathfinder`, `mineflayer-auto-eat` and `mineflayer-armor-manager`. `mineflayer-pvp` was dropped because it is unmaintained and uses a deprecated event, so combat is our own code.
- **Reflex loop:** `reflex/loop.ts` runs every `everyTicks` game ticks.
- **Rules:** `reflex/rules.ts` covers targeting the nearest hostile, retreating at low HP, and eating. This rules policy is also the fallback whenever Jev is unavailable.
- **Tests:**
  - Unit tests for the rules.
  - An integration test in which the bot kills a summoned zombie and survives.

## Phase 2.5: Survival hardening

The rules-only fighter could die while retreating: auto-eat made it stop and eat with a zombie behind it, it retreated only when HP was already critical, and nothing noticed a failing retreat. This phase fixed these and measured the result.

- **Survival benchmark** (`npm run benchmark:survival`): nine scenarios run 8 times each on the throwaway server. The baseline, the intermediate runs and the final results are in [survival-benchmark.md](survival-benchmark.md).
- **No eating near hostiles:** auto-eat pauses while a hostile is within `rules.noEatRadiusBlocks` (default 10) and resumes afterwards. Checked by an integration test, since the benchmark switches regeneration off.
- **Danger-based fight assessment:** `estimateFight` predicts the damage the bot would take from the hostiles' kind, distance and count, and the bot's weapon and armor. It is calibrated against the baseline runs.
- **Failed-retreat detection:** if the distance to the threat has not grown by `rules.retreatMinGainBlocks` within `rules.retreatCheckMs`, the bot fights back for `rules.fightBackMs`.
- **The finding:** the benchmark showed that retreating without a safe place to run does more harm than good. `rules.retreat` therefore defaults to **off**, and everything above except the eating pause only takes effect when it is switched on.
- **Results:** one zombie at 6 HP went from 25% to 100% survival; three zombies at 6 HP from 25% to 88%; one skeleton at 6 HP from 12% to 100%. Nothing got worse.
- **Tests:** unit tests for each pure function, and integration tests for the eating pause and for retreating (when on) and fighting on (by default).

## Phase 3: Jev strategic layer

- **`strategic/jev.ts`:** wraps the official `@typesafe-ai/sdk` and reaches Jev through OpenRouter via `TYPESAFE_BASE_URL`. SDK failures become a few typed error kinds.
- **`strategic/gateway.ts`:** the shared `JevGateway`. It enforces the global rate limit and daily budget, allows one call at a time per bot, pauses after rate-limit and server errors, stops for good after a bad key or no credit, and tracks cost from `usage.cost`. It never throws.
- **`strategic/layer.ts`:** `StrategicLayer` triggers a decision on the interval and on events (enforcing `minGapMs`), skips calls when no threat is present, discards stale answers and hands the result to the reflex layer as an override.
- **`strategic/questions.ts`:** the four questions, the state description and the answer parser, versioned (`QUESTION_SET_VERSION`).
- **`strategic/policy.ts`:** the confidence-gated merge of Jev's judgment with the rules.
- **`telemetry/decisionLog.ts`:** the JSONL decision log.
- **Tests:**
  - Unit tests for every piece, with fake timers and a scripted client. The client tests run the real SDK against a fake network.
  - An integration test on a real server with a scripted Jev (retreat, target choice, and fighting on when Jev fails).
  - An opt-in live test (`npm run test:live`) against the real API. Measured: 271ms, 711 tokens and $0.00003 per call.

## Phase 4: Modes and chat commands

- **Modes:** `guard` (the default: hold position and fight what comes near), `hunt` and `idle`, set per bot with `bots[].mode`. Commands add `follow` and a guard post.
- **Commands:** `follow`, `guard here`, `hunt`, `stop`, `auto`, `status` and `help`, accepted from the bot's owner only, matched exactly, and confirmed in chat. A message that starts with a bot's name commands just that bot.
- **Behavior:** `follow` uses a direct owner lookup that reaches beyond the perception radius. `guard here` returns the bot to its post when idle or pulled more than 14 blocks away. `hunt` widens the engage radius and wanders when nothing is in sight. `stop` stops fighting, moving and asking Jev.
- **Tests:** unit tests for parsing, authorization and every mode's decisions; agent tests for the chat wiring; and an integration test on a real server in which an owner client gives orders in chat and a stranger's orders are ignored.

## Phase 5: Player combat

- Players are added to the snapshot.
- Jev judges whether a player is hostile.
- The owner and allowlisted players are never attacked. This safety rule is enforced in code, not by Jev.
- Player-vs-player tactics.
- **Test:** an integration match against a second, scripted bot acting as the opponent.

## Phase 6: Multiple bots and swarm

- **Agents:** run N agents from `bots[]`.
- **`swarm/bus.ts`:** the `Bus` interface and `InProcessBus`.
- **`swarm/blackboard.ts`:** threats seen by any bot, target claims, positions and roles.
- **Cooperative mode:** each bot's Jev state includes its allies and their claimed targets.
- **`swarm/coordinator.ts`:** optional. Assigns roles and focus targets.
- **Tests:**
  - Unit tests for the bus and blackboard, covering claim conflicts and stale threats.
  - An integration test in which a squad of 3 bots fights a mob wave.

## Phase 7: Tuning (optional)

- Analyse the decision logs.
- Adjust the thresholds and questions.
- Compare win rates against rules-only bots.

## Backlog (not scheduled)

Ideas from the survival discussion, to revisit once the benchmark shows where the bot still dies:

- **Escape destinations.** Pick an open spot away from all threats (and toward home, the spawn point or a bed) and pathfind to it, instead of "get 24 blocks away". This avoids dead ends.
- **Enemy-specific tactics.** Sprinting works against zombies. Baby zombies and spiders are faster than a sprinting player, so fight or block. Skeletons need broken line of sight. Creepers need 7+ blocks of distance and no melee. The speeds are from memory and should be measured first.
- **Emergency tools.** Golden apples, healing potions, a totem of undying in the offhand, raising a shield, and blocking yourself in with blocks (this only stops melee mobs).
- **Cheaper deaths.** The `keepInventory` gamerule for experiments, and remembering where the bot died.
- **Jev judgments around survival.** For example "can I win this fight?" and "is it safe to stop and eat?". These arrive with Phase 3 and later. The flee reflex itself stays in code, because Jev is too slow for it.
