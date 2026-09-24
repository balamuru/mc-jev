# Functional requirements

Each requirement lists the phase that delivers it (see [phases.md](phases.md)).

| ID    | Requirement                                                                                                                                                                                                                    | Phase |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| FR-1  | **Connect**: join the configured server and reconnect with backoff if kicked or disconnected.                                                                                                                                  | 1     |
| FR-2  | **Perceive**: build an `observe()` snapshot (see below).                                                                                                                                                                       | 1     |
| FR-3  | **Reflex layer**: deterministic combat and survival rules that run every `reflex.everyTicks` game ticks.                                                                                                                       | 2     |
| FR-4  | **Strategic layer**: one batched Jev call per decision, made every `strategic.intervalMs` and when a trigger event happens.                                                                                                    | 3     |
| FR-5  | **Resilience**: the bot must never stall waiting on Jev (see below).                                                                                                                                                           | 3     |
| FR-6  | **Modes and chat**: the bot is autonomous by default, and chat commands from its `owner` override that (see below).                                                                                                            | 4     |
| FR-7  | **Player combat**: track players, judge hostility with Jev, and fight players (see below).                                                                                                                                     | 5     |
| FR-8  | **Observability**: write every decision to a JSONL log (see below).                                                                                                                                                            | 3     |
| FR-9  | **Config**: one typed config file validated with zod, with `defaults`, per-bot `overrides`, shared `gateway` limits, and environment overrides for the server and Jev API. All tick rates, thresholds and limits are settings. | 0     |
| FR-10 | **Multiple bots**: run N independent bots from `bots[]` in one process. Each has its own username, role, owner and settings, and all share one Jev rate limit and budget.                                                      | 6     |
| FR-11 | **Swarm**: bots share observations and target claims (see below).                                                                                                                                                              | 6     |
| FR-12 | **Survive a retreat**: the bot must not stop to eat with hostiles close, must retreat when it would lose a fight (not only at critical HP), and must notice a failing retreat and fall back to fighting.                       | 2.5   |

## Details

### FR-2 Perceive

The snapshot contains:

- **Self**: HP, food, position, held item, armor.
- **Nearby entities**: kind, distance, direction, whether they are approaching, held item.
- **Environment**: terrain flags and an inventory summary.

Entities outside line of sight or field of view can be filtered out. This is a setting.

### FR-3 Reflex layer

It covers chasing, aiming, attack timing (respecting the weapon's cooldown), choosing the best weapon, retreating, eating, and wearing armor. It uses no network calls. Strafing and shielding are not implemented yet.

### FR-4 Strategic layer

The trigger events are `hurt`, `newThreat` and `lowHp`. Each call asks four questions:

| Question       | Type   |
| -------------- | ------ |
| `tactic`       | choice |
| `threat_level` | score  |
| `target`       | choice |
| `ambush`       | noul   |

### FR-5 Resilience

- **One call at a time:** each bot has at most one Jev call in flight. A newer call cancels the older one through `AbortSignal`.
- **Timeout:** every call has a timeout (`jev.timeoutMs`).
- **Freshness check:** before acting, check that the answer is still relevant, since the situation may have changed while the call was in flight.
- **Rules fallback:** when a call times out, fails or comes back with low confidence, the bot falls back to its rules.
- **Limits:** a rate limit and a daily budget, shared by all bots (see FR-9 and FR-10).

### FR-6 Modes and chat

- **Autonomous modes:** `guard`, `hunt` and `idle`.
- **Chat commands:** `follow`, `guard here`, `hunt`, `stop`, `status` and `auto`. The bot ignores commands from anyone except its `owner`.

### FR-7 Player combat

- The bot never attacks its `owner` or players on the allowlist.
- It uses player-vs-player tactics.

### FR-8 Observability

Each log line records:

- the agent ID
- a state summary
- the question-set version
- the answers and their confidence
- the call's latency and cost
- the action taken

The API key is never logged.

### FR-12 Survive a retreat

- **No eating near hostiles:** auto-eat is paused within `rules.noEatRadiusBlocks` of a hostile. Instant heals are exempt.
- **Danger-based retreat:** the bot retreats when an estimate of the fight says it would lose. `rules.retreatHp` remains a hard floor.
- **Failing retreat:** if the distance to the threat hasn't grown by `rules.retreatMinGainBlocks` within `rules.retreatCheckMs`, the bot fights back.
- **Measured:** the survival benchmark reports survival rate per scenario, and its baseline and results are recorded in `docs/survival-benchmark.md`.

### FR-11 Swarm

The shared data travels over a `Bus` and is collected on a `Blackboard`. There are two swarm modes:

- **Cooperative:** each bot's Jev state includes its allies and the targets they have claimed.
- **Coordinated:** an optional coordinator assigns roles and focus targets.

## Non-functional requirements

- **Latency:**
  - The reflex layer never waits on I/O.
  - Jev calls default to an 800ms timeout.
  - The game tick is 50ms. Jev is never called inside a tick.
- **Cost:** the default settings target under $0.10/hour per bot. See the cost section in [architecture.md](architecture.md).
- **Security:**
  - The API key comes only from `.env` or the environment.
  - `.env` is gitignored.
  - Local servers run with `online-mode=false` and must not be exposed to the internet.
- **Testability:**
  - Core logic (observe, policy, rules, scheduler, commands, gateway, bus) is pure or injectable, so unit tests run without a Minecraft server.
  - Integration tests are opt-in.
