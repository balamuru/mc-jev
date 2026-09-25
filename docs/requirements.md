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

Entities outside line of sight or field of view can be filtered out. This is a setting (`perception.requireLineOfSight`, `perception.fovDegrees`), and an integration test checks both on a real server: a zombie behind a stone wall disappears and comes back when the wall goes, and one behind a bot with a 90-degree view disappears.

### FR-3 Reflex layer

It covers chasing, aiming, attack timing (respecting the weapon's cooldown), choosing the best weapon, retreating, eating, wearing armor, holding up a shield, and strafing. It uses no network calls. Shield use (`rules.shield`) and strafing against mobs (`rules.strafeMobs`) are implemented but off by default, because the survival benchmark showed no clear gain from either (Phase 8). Strafing against players is always on. A bot with a bow and arrows shoots at targets between `rules.bowMinBlocks` and `rules.bowMaxBlocks` away (`rules.bow`, on by default since Phase 9: the benchmark showed less damage in every bow scenario), aims for the arrow's arc and leads moving targets, and never releases when the arrow's path passes near a protected player.

### FR-4 Strategic layer

The trigger events are `hurt`, `newThreat` and `lowHp`, plus the periodic interval. The layer asks only when a threat is present. Each call asks four questions about the same state:

| Question       | Type   | Answer                                                       |
| -------------- | ------ | ------------------------------------------------------------ |
| `tactic`       | choice | `engage`, `retreat` or `ignore` (what the bot can carry out) |
| `target`       | choice | one of the visible threats, or `none`                        |
| `threat_level` | score  | four levels, from "no real danger" to "deadly"               |
| `ambush`       | noul   | the probability of being surrounded                          |

Jev's judgment is merged with the rules by a confidence-gated policy (see [architecture.md](architecture.md)). Jev can always make the bot more careful, but it cannot make it less careful at critical HP.

### FR-5 Resilience

- **One call at a time:** each bot has at most one Jev call in flight. A newer call cancels the older one through `AbortSignal`, and this is not counted as a failure.
- **Timeout:** every call has a timeout (`jev.timeoutMs`).
- **Freshness check:** an answer is discarded if HP fell by 5 or more while it was in flight, its chosen target has gone, or the threats are gone.
- **Rules fallback:** when a call times out, fails, is refused, comes back malformed or with low confidence, the rules decide.
- **Limits:** a rate limit and a daily budget, shared by all bots (see FR-9 and FR-10). After a rate-limit or server error, calls pause for 5 seconds. A rejected key or empty account stops Jev for the run.

### FR-6 Modes and chat

- **Autonomous by default.** Each bot has a default mode (`bots[].mode`): `guard` (hold position and fight what comes near), `hunt` (seek out hostiles) or `idle` (do nothing).
- **Chat commands** from the bot's `owner`: `follow`, `guard here`, `hunt`, `stop`, `auto`, `status` and `help`. The bot ignores commands from anyone else, and a bot with no owner obeys nobody.
- **Exact matching.** Only whole messages that are commands count, so ordinary chat is never mistaken for one. A message can start with a bot's name to command just that bot.
- **Standing down.** After `stop` the bot neither fights nor moves nor asks Jev, until `auto` or another command.
- The bot confirms each command in chat.

### FR-7 Player combat

- **Only in self-defence, by default.** A bot fights a player only if the player has attacked it (the server names the attacker, or a swing near the bot matched a drop in its HP with no mob beside it), or Jev is very sure the player is about to attack (see below).
- **No collateral damage.** A sword swing on the ground sweeps into anyone next to the target, so when another player is within 2 blocks of the target the bot only swings as a critical hit, which does not sweep.
- **Never the owner, allies or other bots.** A bot's owner, its `allies` and every other bot in the config are protected. This is enforced in code in three places (the rules, Jev's target list, and the actuator itself), so no judgment by Jev and no chain of events can make a bot attack them.
- **Jev judges strangers.** For up to three unfamiliar players in view, Jev is asked whether each is about to attack. A player is treated as hostile only if Jev is at least 85% sure, they hold a weapon, and they are within 8 blocks. A hostile marking lasts 10 seconds without further evidence. An attacker stays hostile for 20 seconds after their last hit.
- **Tactics against players.** The bot jumps so that hits land as critical hits, does not sprint while in reach (sprinting cancels critical hits), and side-steps back and forth while close.
- **Switch.** `rules.pvp: false` means the bot never fights players, whatever they do.

### FR-8 Observability

Every decision, applied or not, is one line in `logs/decisions-YYYY-MM-DD.jsonl`:

- the agent, the trigger and the question-set version
- a text summary of what the bot saw
- Jev's answers and confidence
- the outcome (`applied`, `rules`, `stale`, `invalid` or `error`) and why
- the resulting intent
- the call's latency, tokens and cost

The API key is never logged.

### FR-12 Survive a retreat

- **No eating near hostiles:** auto-eat is paused within `rules.noEatRadiusBlocks` of a hostile. (Instant heals such as golden apples are not implemented yet; see the backlog.)
- **Danger-based retreat:** the bot retreats when an estimate of the fight says it would lose, and fights when the estimate says the fight is safe, even at low HP. `rules.retreatHp` applies unless the fight is clearly safe.
- **Failing retreat:** if the distance to the threat hasn't grown by `rules.retreatMinGainBlocks` within `rules.retreatCheckMs`, the bot fights back.
- **Measured:** the survival benchmark reports survival rate per scenario, and its baseline and results are recorded in `docs/survival-benchmark.md`.

### FR-10 Multiple bots

- One process runs every bot in `bots[]`, each with its own username, role, owner, default mode, allies and setting overrides.
- Bots start one at a time, `server.staggerMs` apart.
- All bots share one Jev gateway, so the rate limit and daily budget apply to the whole process.
- Each bot keeps its own state; none reads another's.

### FR-11 Swarm

Bots share observations and target claims through a `Bus` and a `Blackboard` (`swarm.mode`):

- **independent:** bots ignore each other.
- **cooperative (default):** bots claim targets so that they do not all pile onto one, help a hurt ally that was hit recently, and tell Jev about the squad.
- **coordinated:** as cooperative, plus an optional coordinator that asks Jev which threat the whole squad should focus on and, with `swarm.coordinator.assignRoles`, which role each bot should take (by gear when Jev is unavailable). A bot never depends on it: without a current directive or assignment, it chooses for itself and uses its configured role.

**Roles** change behavior in a swarm (Phase 10): a `tank` covers the most hurt ally, a `support` goes to hurt allies first, a `scout` wanders farther and reports threats at once, and a `ranged` bot keeps its distance and shoots archers and creepers first. `fighter` is the default.

The owner, allies and every other bot in the config are never attacked (see FR-7).

## Non-functional requirements

- **Latency:**
  - The reflex layer never waits on I/O.
  - Jev calls default to a 1000ms timeout (a call takes about 190ms typically, and under 750ms in every measured case).
  - The game tick is 50ms. Jev is never called inside a tick.
- **Cost:** about $0.00003 per Jev call, so under $0.06/hour per bot even with a threat present all the time (measured). See the cost section in [architecture.md](architecture.md).
- **Security:**
  - The API key comes only from `.env` or the environment.
  - `.env` is gitignored.
  - Local servers run with `online-mode=false` and must not be exposed to the internet.
- **Testability:**
  - Core logic (observe, policy, rules, scheduler, commands, gateway, bus) is pure or injectable, so unit tests run without a Minecraft server.
  - Integration tests are opt-in.
