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
| 5     | Player combat                                 | FR-7             | Done    |
| 6     | Multiple bots and swarm                       | FR-10, FR-11     | Done    |
| 7     | Tuning (optional)                             | none             | Done    |
| 8     | Shield and strafing against mobs              | FR-3             | Done    |
| 9     | Bow combat                                    | FR-3             | Next    |
| 10    | Roles that change behavior                    | FR-11            | Planned |
| 11    | Test coverage and housekeeping                | FR-2, FR-7       | Planned |

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

- **Who attacked me.** `ProvocationTracker` records players who hit the bot, from Mineflayer's `entityHurt` (which names the attacker) or from a swing seen near the bot at the moment its HP dropped, ignoring drops when a mob is right next to it.
- **Safety first.** The owner, `bots[].allies` and every bot in the config are protected. The check is in the rules, in Jev's target list and in the actuator, and the owner is always included however the config was built.
- **Jev judges strangers** with one yes/no question per nearby unfamiliar player, acted on only when Jev is very sure, the player is armed and close (see FR-7).
- **PvP tactics** (`src/reflex/pvp.ts`): jump-crits, no sprinting in reach, and strafing.
- **Tests:** unit tests for the tracker, protection, PvP timing, the rules with players, the questions and the policy; agent tests for attribution, protection and Jev-judged hostility; and an integration test against a scripted opponent on a real server (a bot that attacks is fought and beaten, a bystander is left alone, and the owner can hit the bot without being hit back).

## Phase 6: Multiple bots and swarm

- **`buildApp`** assembles the program: one agent per bot, one shared gateway, one bus and blackboard, an optional coordinator, and staggered starts.
- **`swarm/bus.ts`, `swarm/events.ts`:** the `Bus` interface and `InProcessBus`, with JSON events.
- **`swarm/blackboard.ts`:** allies, target claims (first wins, with expiry), known threats, help requests and the coordinator's focus.
- **`swarm/member.ts`:** each bot's reporting and its view of the squad.
- **Cooperative behavior** in the mode logic: focus fire, avoiding claimed targets, helping a hurt ally. Jev is told about the squad (question set v2).
- **`swarm/coordinator.ts`:** the optional coordinator, asking Jev for a squad focus target.
- **Tests:** unit tests for every piece; agent tests with real bus and blackboard; `buildApp` tests for staggering, the shared limit and the modes; and an integration test in which a squad of three bots beats a wave of six zombies on a real server, holding different targets at the same time, with nobody lost.

## Phase 7: Tuning

Measurements, not intuition, decided the defaults. The full write-up is in [tuning.md](tuning.md).

- **Tools:** `npm run eval:jev` (the question set on 17 labeled situations), `npm run benchmark:survival -- --jev`, `npm run benchmark:squad` and `npm run analyze:decisions`. Each decision now also logs what the rules alone would have done, so the analyzer can say how often Jev truly differed.
- **Jev against rules:** at parity on survival (75% against 75% over 20 trials of the hardest scenario). Jev is not a survival win for mobs, but it costs almost nothing and does not hurt.
- **Questions:** v3 adds each mob's max health and attack style, which fixed a ravager that Jev rated too safe. 13 of 13 evaluation expectations now hold, against 12 of 13.
- **Defaults changed:** `jev.timeoutMs` 800 → 1000 (the slowest measured calls were 743 and 908 ms), `gateway.maxCallsPerMinute` 60 → 300 (a squad makes about 70 decisions a minute), and `swarm.mode` `independent` → `cooperative` (squad damage down by about a third in both benchmarks).
- **Not helpful:** the coordinator's focus-fire directive did not beat plain cooperation.
- **A bug found:** an SDK bug that crashed the whole process under load, now guarded.

## Phase 8: Shield and strafing against mobs

Phases 8 to 11 close the gaps a review of the implementation against the plan found (see [plan-gap-closure.md](plan-gap-closure.md)).

- **`src/reflex/shield.ts`:** a pure `shouldBlock` decides when to hold up a shield. It raises it between swings, against a close creeper even while closing in, and against archers in range, and it lowers it for every ready swing, while chasing, and while an axe hit has it on cooldown (the `set_cooldown` packet).
- **Actuator:** raises and lowers the shield (never swinging while blocking), side-steps melee mobs between swings, and equips a shield or totem to the off-hand as soon as one arrives. The snapshot now reports the off-hand item, and Jev's state includes `shield` (question set v4).
- **Benchmark:** three shield scenarios, and a `--trace` option. Craters from creeper explosions were skewing results; test worlds now turn off `mob_griefing`.
- **Sweep safety (found by the tests):** a sword swing on the ground also hurts anyone next to the target, and the integration tests caught the owner losing health that way. When another player stands within 2 blocks of the target, the bot now only swings as a critical hit, which never sweeps (`src/reflex/sweep.ts`). A new integration test puts the owner beside a zombie that cannot move and checks the owner takes no damage.
- **Results:** the shield cut creeper damage by about 17% but lowered survival against three zombies at low HP in two runs. Strafing made no measurable difference. **Both ship off** under the agreed rule, with the numbers in [survival-benchmark.md](survival-benchmark.md#phase-8-shield-and-strafing-against-mobs).
- **Tests:** unit tests for `shouldBlock`, the first unit tests for the actuator (with a fake Mineflayer bot), and an integration test on a real server in which the shield is equipped and raised and the bot still kills a zombie.

## Backlog (not scheduled)

Ideas from the survival discussion, to revisit once the benchmark shows where the bot still dies:

- **Escape destinations.** Pick an open spot away from all threats (and toward home, the spawn point or a bed) and pathfind to it, instead of "get 24 blocks away". This avoids dead ends.
- **Enemy-specific tactics.** Sprinting works against zombies. Baby zombies and spiders are faster than a sprinting player, so fight or block. Skeletons need broken line of sight. Creepers need 7+ blocks of distance and no melee. The speeds are from memory and should be measured first.
- **A creeper-only shield.** Phase 8 showed the shield helps against creepers (about 17% less damage) but not against groups of zombies. Raising it only for creepers may keep the gain without the loss. It would need its own benchmark run.
- **Emergency tools.** Golden apples, healing potions, a totem of undying in the offhand, raising a shield, and blocking yourself in with blocks (this only stops melee mobs).
- **Cheaper deaths.** The `keepInventory` gamerule for experiments, and remembering where the bot died.
- **Jev judgments around survival.** For example "can I win this fight?" and "is it safe to stop and eat?". These arrive with Phase 3 and later. The flee reflex itself stays in code, because Jev is too slow for it.
