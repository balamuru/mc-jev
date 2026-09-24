# Phases

Each phase ends with `npm run check` passing, the phase's integration scenario working where there is one, the docs updated, and a commit you have approved.

| Phase | Scope                                         | Requirements     | Status  |
| ----- | --------------------------------------------- | ---------------- | ------- |
| 0     | Repo and scaffolding                          | FR-9             | Done    |
| 1     | Server, connection and perception             | FR-1, FR-2       | Done    |
| 2     | Reflex layer: rules-only fighter against mobs | FR-3             | Done    |
| 2.5   | Survival hardening                            | FR-12            | Next    |
| 3     | Jev strategic layer against mobs              | FR-4, FR-5, FR-8 | Planned |
| 4     | Modes and chat commands                       | FR-6             | Planned |
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

The rules-only fighter can still die while retreating. Auto-eat makes it stop and eat with a zombie behind it, it retreats only when HP is already critical, and nothing notices when a retreat is failing. This phase fixes those three, and measures the result.

- **Survival benchmark first.** An opt-in script (`npm run benchmark:survival`) runs each scenario about 20 times on the throwaway test server and reports survival rate and mean time to death. Scenarios: one zombie at low HP, three zombies at full HP, a baby zombie, a spider, a skeleton, and a creeper. The baseline goes into `docs/survival-benchmark.md` before any change, so every improvement is judged by numbers.
- **No eating near hostiles.** Auto-eat is paused while a hostile is within `rules.noEatRadiusBlocks` (default 10), and any eating in progress is cancelled. Instant heals such as golden apples and healing potions are not affected. The decision is a pure function.
- **Danger-based retreat.** A pure `assessDanger` function estimates whether the bot would win the fight from the number and type of hostiles, their distance, and the bot's HP, armor and weapon. The bot retreats when it would lose, or avoids starting the fight. `rules.retreatHp` stays as a hard floor. The mob stats table in code is approximate and documented as such.
- **Retreat failure detection.** A pure `RetreatWatch` tracks the distance to the threat. If the distance hasn't grown by `rules.retreatMinGainBlocks` (default 1.5) within `rules.retreatCheckMs` (default 2000), the retreat has failed, and the bot fights back for a short time instead of standing still or being chased down.
- **Tests:**
  - Unit tests for each pure function (eating pause, danger estimate, retreat watch).
  - The retreat integration test also checks that the bot does not eat while a zombie is close.
  - Exit criteria: benchmark before and after are recorded, no scenario gets worse, and the low-HP scenarios improve.

## Phase 3: Jev strategic layer

- **`strategic/jev.ts`:** wraps `TypeSafeClient`. It uses OpenRouter via `TYPESAFE_BASE_URL`.
- **`strategic/gateway.ts`:** the shared `JevGateway`. It enforces the global rate limit and budget, allows one call at a time per agent, and tracks cost from `usage.cost`.
- **`strategic/scheduler.ts`:** triggers decisions on the interval and on events, enforces `minGapMs`, and cancels stale calls.
- **`strategic/questions.ts`:** the four questions and their thresholds, versioned.
- **`strategic/policy.ts`:** maps answers and confidence to an `Intent`, or falls back to the rules.
- **`telemetry/log.ts`:** writes the JSONL decision log and cost totals.
- **Tests:**
  - Unit tests for the policy, the scheduler (with fake timers), the gateway, and the Jev client (with a mocked fetch).
  - An opt-in live smoke test.

## Phase 4: Modes and chat commands

- **Modes:** `guard`, `hunt` and `idle`. The bot is autonomous by default.
- **Commands:** `follow`, `guard here`, `hunt`, `stop`, `status` and `auto`, accepted from the owner only.
- **Tests:** unit tests for command parsing and owner-only access.

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
