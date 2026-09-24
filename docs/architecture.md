# Architecture

mc-jev runs one or more Minecraft bots. Each bot works in a loop: it senses the world, summarizes what it sees, decides what to do, and acts. The work is split across two layers that run at different speeds:

- **Reflex layer**: fast rules written as plain code.
- **Strategic layer**: slower decisions made by Jev, TypeSafe's typed-decision model.

Many parts described here are planned for later phases. [phases.md](phases.md) shows what exists today.

## One bot

```
                 ┌──────────────────────────── BotAgent ─────────────────────────────┐
 Minecraft  ◄──► │ Mineflayer bot                                                    │
 server          │   │ events (entityHurt, health, entitySpawn…)                     │
                 │   ▼                                                               │
                 │ observe()  ──►  Snapshot  ──┬──────────────► Reflex layer         │
                 │                              │                every N game ticks  │
                 │                              │                rules → actions     │
                 │                              │                  ▲                 │
                 │                              ▼                  │ current Intent  │
                 │                      Strategic scheduler        │                 │
                 │                      every intervalMs + events  │                 │
                 │                              │                  │                 │
                 │                              ▼                  │                 │
                 │                   JevGateway (shared) ──► policy (confidence gate) │
                 └──────────────────────────────┼────────────────────────────────────┘
                                                ▼
                                  OpenRouter /api/v1/systemone (Jev)
```

### Reflex layer

The reflex layer runs on `physicsTick`, once every `reflex.everyTicks` game ticks. Minecraft's game clock is fixed at 20 Hz, so one game tick is 50ms.

- **What it does:**
  - **Chases** its target with pathfinder and **aims** at it when close.
  - **Attacks** only when the target is within reach and the weapon's cooldown has passed (for example 13 ticks for a sword).
  - **Equips** the best sword or axe in the inventory.
  - **Retreats** from a threat by pathfinding away from it.
  - **Eats** through auto-eat and **wears armor** through armor-manager, and puts a shield or totem in the off-hand.
  - **Shield and strafing** (off by default, `rules.shield` and `rules.strafeMobs`): raises a shield between swings and against creepers and archers, never while a swing is ready (`src/reflex/shield.ts`), and side-steps melee mobs while the weapon recharges. Against players it always strafes and jumps for critical hits.
  - **Bow** (`rules.bow`, on by default): with a bow and arrows, a target between `rules.bowMinBlocks` and `rules.bowMaxBlocks` is shot instead of chased (`src/reflex/bow.ts`). The pitch comes from simulating Java Edition arrow physics (launch speed 3 blocks per tick at full draw, gravity 0.05, drag 0.99) and solving for the angle that lands on the target, and a moving target is led by its measured velocity times the flight time. The bot draws for 20 ticks, then releases only with a clear line of sight along the whole arc (a raycast per segment) and no protected player within 1.5 blocks of the path; otherwise it holds the draw. Closer than `bowMinBlocks` it switches to its melee weapon. A drawn bow is cancelled by switching hotbar slots, never by releasing, so a cancelled shot never flies. While shooting, the rules keep the current target out to `bowMaxBlocks` even past `engageRadiusBlocks`, because an arrow knocks it back.
- **Combat is our own code:** `mineflayer-pvp` is not used, because it is unmaintained and depends on a deprecated Mineflayer event.
- **What it may not do:** it never waits on network I/O.
- **Where its instructions come from:** it follows the current **Intent**, for example `{ tactic: 'kite', targetId: 42 }`. Jev sets the Intent; when Jev is unavailable, the rules set it.

### Rules (the fallback policy)

`decideByRules` picks an Intent from the snapshot alone. The strategic layer can override it when Jev is available and confident; otherwise the rules decide, so a bot fights without Jev.

- **Threats:** visible hostile mobs within `rules.engageRadiusBlocks`. Neutral mobs (endermen, wolves, iron golems, piglins and a few more) are never threats unless they attack first, because provoking an enderman starts a fight the bot doesn't need.
- **No threats:** idle.
- **Danger estimate.** `estimateFight` guesses the damage the bot would take while killing every threat, nearest first. It uses each mob's HP and damage rate (`src/reflex/danger.ts`), the bot's best weapon and armor, and when each mob would arrive. Melee mobs only matter once they reach the bot and land hits only a fraction of the time. Ranged mobs count from the start. A creeper's explosion counts unless the bot would kill it inside its 1.5 second fuse. The numbers are calibrated against the survival benchmark (see [survival-benchmark.md](survival-benchmark.md)).
- **Retreat** when the expected damage is at least `rules.dangerMargin` of current HP, or when HP is at or below `rules.retreatHp` and the fight isn't clearly safe (expected damage under 30% of HP). Once retreating, the bot keeps going until HP is back to `rules.resumeHp` and the fight looks comfortably winnable, so it doesn't flip between fighting and fleeing at the threshold.
- **Otherwise engage** the nearest threat, staying on the current target unless another is at least 3 blocks closer.
- **Never attacked:** passive animals, villagers and players.

Two other reflexes protect a retreating bot:

- **No eating near hostiles.** Eating slows the bot and cancels its sprint, so auto-eat is paused while any hostile is within `rules.noEatRadiusBlocks` and resumed afterwards.
- **Failed retreats.** Every `rules.retreatCheckMs` the bot checks that it has gained at least `rules.retreatMinGainBlocks` on the threat. If not (cornered, stuck or outrun), it fights back for `rules.fightBackMs` and then lets the rules decide again.

### Strategic layer

The strategic layer (`src/strategic/layer.ts`) watches the bot's snapshots. It asks Jev about the situation every `strategic.intervalMs`, and straight away when a configured trigger event happens (`hurt`, `newThreat`, `lowHp`), never more often than once per `minGapMs`. It asks only when a threat is present, so an idle bot costs nothing.

Each decision is one Jev request that asks four questions about the same state. Jev answers all of them in parallel, in about the time of one.

| Question       | Type   | Answer                                                                          |
| -------------- | ------ | ------------------------------------------------------------------------------- |
| `tactic`       | choice | `engage`, `retreat` or `ignore` (only tactics the bot can carry out)            |
| `target`       | choice | one of the visible threats (by id), or `none`                                   |
| `threat_level` | score  | four levels, from "no real danger" to "deadly"                                  |
| `ambush`       | noul   | the probability that the bot is being surrounded or attacked from several sides |

The state sent with the questions is a small JSON object: the bot's HP, food, weapon and armor points, and up to six threats with their kind, distance, direction, whether they are approaching, and what they hold. It is about 700 tokens. The questions are versioned (`QUESTION_SET_VERSION` in `src/strategic/questions.ts`), and every logged decision records the version.

**How Jev's answers are used.** `decideWithJev` (`src/strategic/policy.ts`) merges Jev's judgment with the rules' intent. The rules are the safety net:

| Situation                                                                                                              | Result                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| HP is at or below `rules.retreatHp` and the rules retreat                                                              | The rules' retreat stands, whatever Jev says.                              |
| Jev says `retreat` with at least `thresholds.cautious` confidence, or is sure the threat level is 2.5 or more out of 3 | Retreat. Jev can always make the bot more careful.                         |
| Jev sees an ambush (0.85 or more) with two or more threats                                                             | Retreat.                                                                   |
| The rules retreat and Jev says `engage` with at least `thresholds.act` confidence                                      | Jev overrules the rules and the bot engages.                               |
| Jev says `engage` with at least `thresholds.cautious` confidence                                                       | Engage. Jev's `target` is used if it is confident and still a real threat. |
| Jev says `ignore` with `act` confidence, and the nearest threat is over 8 blocks away and not approaching              | Idle.                                                                      |
| Anything else (low confidence)                                                                                         | The rules decide.                                                          |

Jev's intent is held as an override for 1.5 intervals, and then the rules take over again unless a newer decision refreshes it. If the answer is a "no change", the override is cleared at once.

A noul near 0.5 means Jev is unsure, not "medium".

**Files.** `src/strategic/` holds `jev.ts` (SDK wrapper), `gateway.ts` (limits), `questions.ts`, `policy.ts` and `layer.ts` (scheduling).

### Modes and orders

Above the rules sits a `ModeController` (`src/control/modes.ts`) that holds the bot's current order and picks the intent for each reflex step. Combat still follows the rules in every mode except `idle`.

| Mode     | What the bot does                                                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `guard`  | Fights what comes near. With a post (`guard here`) it walks back to the post when idle, and gives up a chase beyond 14 blocks from it. |
| `follow` | Fights threats first, then follows the owner.                                                                                          |
| `hunt`   | Engages hostiles out to the perception radius, and wanders about 15 blocks at a time when nothing is in sight.                         |
| `idle`   | Stands down: no fighting, no moving, no Jev calls. Set by `stop`, or as a bot's default mode.                                          |

A bot starts in its configured default mode and returns to it on `auto`. Orders come from chat (`src/control/commands.ts`): the message must be exactly a command, and only the bot's owner is obeyed. The bot answers in chat. Two more intents exist for this: `follow` (stay near an entity) and `goto` (walk to a point).

**Who decides.** Each reflex step, the highest of these wins: a fight-back after a failed retreat, then Jev's override, then the current mode (which uses the rules). While standing down the strategic layer is held off, and it treats whatever is around as new when the bot resumes.

### Player combat

Players are never threats just for being there. A player becomes a threat when:

1. **They attacked the bot.** `ProvocationTracker` (`src/perception/provocation.ts`) listens for `entityHurt`, which names the attacker, and falls back to matching a nearby player's arm swing to a drop in the bot's HP (ignoring drops when a hostile mob is within 4 blocks). An attacker stays hostile for 20 seconds after their last hit.
2. **Jev is very sure they are about to attack.** The strategic layer asks one yes/no question for each of up to three unfamiliar players in view. A player is marked hostile for 10 seconds only if Jev says at least 85%, they hold a weapon and they are within 8 blocks. A wrong answer here makes the bot attack a bystander, so this is the strictest threshold in the system.

Both routes set a `provoked` flag on the player in the snapshot, and from there the normal rules apply: the player is a threat like a mob.

**The owner, allies and other bots are never attacked.** `isProtectedPlayer` is checked in the rules (`threatsIn`), when building the targets Jev may choose from, and again in the actuator before it ever engages or swings, so even a mistake in one layer cannot lead to an attack. The owner is added to the protected set wherever it is used, so it does not depend on how the config was assembled. `rules.pvp: false` turns off all fighting against players.

**No sweep damage to bystanders.** A full-strength sword swing made on the ground also hits everything within about a block of the target. So whenever another player (the owner, an ally, another bot or a stranger) stands within 2 blocks of the target and the bot holds a sword, it swings only mid-jump, as a critical hit, which never sweeps (`src/reflex/sweep.ts`). The integration tests found this: the owner lost health while standing next to something the bot was fighting.

Against a player, the actuator (`src/agent/actuator.ts` with the timing in `src/reflex/pvp.ts`) jumps so the hit lands as a critical hit, stops sprinting while in reach (sprinting cancels critical hits), and strafes so the player has a harder time landing hits.

### Timing rules

These rules keep the bot from stalling while it waits for Jev:

1. **Jev stays out of `physicsTick`.** A call takes about 270ms in practice (measured through OpenRouter) and a game tick is only 50ms. The reflex layer never waits for it.
2. **One call at a time per bot.** A newer decision cancels the older call through `AbortSignal`; the cancelled call is not counted as a failure.
3. **Every call has a deadline.** The per-call timeout is `jev.timeoutMs`, with at most `jev.maxRetries` retries.
4. **Answers are checked for staleness.** An answer is thrown away, and recorded as stale, if HP fell by 5 or more while it was in flight, if its chosen target has left, or if the threats are gone.
5. **Every failure has a fallback.** On timeout, error, rate limit, exhausted budget or low confidence, the rules decide. The reflex layer keeps following whatever intent it has.
6. **Back-off and shut-off.** After a 429, a 5xx or a network failure the gateway pauses all calls for 5 seconds. A rejected key or an account with no credit stops Jev for the rest of the run, and the log says so once.

## Several bots and swarms

```
  BotAgent A ─ SwarmMember ─┐              ┌─► Blackboard (allies, claims, threats, focus)
  BotAgent B ─ SwarmMember ─┼─► Bus (JSON) ┤
  BotAgent C ─ SwarmMember ─┘              └─► Coordinator (optional, no in-game body)
       │
       └──────► JevGateway (one per process: global rate limit + daily budget)
```

`buildApp` (`src/app.ts`) assembles all of this from the config: one `BotAgent` per entry in `bots[]`, one gateway, one bus, one blackboard and, in `coordinated` mode, one coordinator. Bots are started one at a time, `server.staggerMs` apart (the first immediately), so a server's login throttle is not tripped.

- **No shared state between bots.** Each `BotAgent` owns its own Mineflayer bot, layers, mode and logger.
- **One `JevGateway` per process.** Every bot calls Jev through it, so one rate limit and one daily budget cover all bots, and each bot has at most one call in flight.
- **`Bus`** (`src/swarm/bus.ts`): `publish(event)` and `subscribe(type | '*', handler)`. Events (`src/swarm/events.ts`) are plain JSON: `heartbeat`, `threats`, `damaged`, `claim`, `release`, `died`, `left` and `directive`. The first implementation, `InProcessBus`, delivers synchronously and isolates handler errors.
- **`Blackboard`** (`src/swarm/blackboard.ts`): built from bus events. It knows which bots are alive (a bot that stops reporting for 10 seconds is dropped), which hostiles anyone has seen, who has claimed which target (first claim wins, and a claim lapses after `swarm.claimTtlMs` without being refreshed or when its owner dies), and the coordinator's current focus.
- **`SwarmMember`** (`src/swarm/member.ts`): one bot's link to the swarm. Each reflex step it reports the bot's position, HP, visible hostiles, damage and target, and it answers three questions for the bot's decisions: which targets are taken, what is the squad's focus, and who needs help.

### Swarm modes (`swarm.mode`)

| Mode          | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `independent` | Bots ignore each other and the bus. Same as running separate bots.                                                                                                                                                                                                                                                                                                                                                                                       |
| `cooperative` | The default (it cut squad damage by about a third in the benchmark, see [tuning.md](tuning.md)). Bots claim the target they fight. A bot whose nearest target is taken moves to the nearest free one (unless it is already in melee with it or nothing else is free). A bot with nothing to fight goes to help an ally that is hurt (at or below `swarm.helpHp`) and was hit in the last 5 seconds. Jev is told about the squad and asked to spread out. |
| `coordinated` | Not better than cooperative in the benchmark. As cooperative, plus a coordinator: every `swarm.coordinator.intervalMs`, when the squad has at least two bots and two known threats, it asks Jev which one threat everybody should focus on and broadcasts a directive that lasts `directiveTtlMs`. If the coordinator is slow, unsure or down, the directive lapses and every bot chooses for itself.                                                    |

Roles (`bots[].role`) are labels shared with the squad and shown to Jev; they do not change what a bot does yet.

### When to use a network event system

One Node process should manage roughly 10–20 bots (not measured), so a bus inside the process is enough for now. Bus events are designed to serialize as plain JSON, so the transport can be swapped later without changing bot code.

| Need                                             | Transport                         |
| ------------------------------------------------ | --------------------------------- |
| Bots spread across several processes or machines | Core NATS                         |
| Replaying fights for debugging or training       | NATS JetStream                    |
| Large-scale analytics over many long sessions    | Kafka or Flink (overkill for now) |

Until then, the JSONL decision logs cover replay and analysis.

## Jev integration

- **SDK:** `@typesafe-ai/sdk`, wrapped in `createJevClient` (`src/strategic/jev.ts`). The wrapper turns the SDK's exceptions into a few kinds (`timeout`, `auth`, `payment`, `rate-limited`, `server`, `network`, `invalid`, `aborted`) that the gateway reacts to.
- **OpenRouter:**
  - Set `TYPESAFE_BASE_URL=https://openrouter.ai/api` and put your OpenRouter key in `TYPESAFE_API_KEY`. Requests then go to `https://openrouter.ai/api/v1/systemone`.
  - The `jev-latest` model maps to `typesafe/jev-1.13`.
  - Responses carry the call's real cost in `usage.cost`, which the gateway adds up. Without it, cost is computed from tokens.
  - `client.models.list()` doesn't work through OpenRouter, so it isn't used.
- **An SDK bug is worked around.** When a call is cancelled or times out while its response body is still arriving, the SDK leaves a rejection that nothing listens to, and Node treats that as fatal, which would take every bot down. `installAbortGuard` (`src/strategic/jev.ts`, installed by the first `createJevClient`) swallows exactly those abort-type rejections and re-throws everything else. It was found by a benchmark crash and reproduced against a slow local server.
- **The gateway** (`JevGateway`) is created once and shared by every bot. It enforces `gateway.maxCallsPerMinute` and `gateway.dailyBudgetUsd` across all bots, allows one call at a time per bot, and never throws: every call returns either an answer or a reason (`no-client`, `disabled`, `budget`, `rate-limited`, `cooldown`, `timeout`, and so on) so callers can always fall back to rules.
- **Decision log.** Every decision, applied or not, is written to `logs/decisions-YYYY-MM-DD.jsonl` (`debug.decisionLogDir`). Each line records the time, bot, trigger, question version, a text summary of what the bot saw, Jev's answers and confidence, the outcome (`applied`, `rules`, `stale`, `invalid` or `error`) and why, the resulting intent, latency, tokens and cost. The API key is never logged.

## Configuration

- **Where it lives:** `config/default.json`, or the file named in `MC_JEV_CONFIG`. `src/config.ts` validates it with zod.
- **Structure:**

  | Section    | Contents                                                                                                    |
  | ---------- | ----------------------------------------------------------------------------------------------------------- |
  | `server`   | host, port and Minecraft version                                                                            |
  | `gateway`  | limits shared by all bots: `maxCallsPerMinute`, `dailyBudgetUsd`                                            |
  | `defaults` | settings for each bot: `perception`, `reflex`, `rules`, `strategic`, `jev`                                  |
  | `bots[]`   | `username`, `role`, `owner`, and `overrides` that are merged into `defaults`, including nested `thresholds` |

- **Environment:** `MC_HOST` and `MC_PORT` override the server. `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` set the Jev API. Without a key, bots run on rules only.

## Cost

Jev costs **$0.042 per million input tokens**, and output tokens are free. The price is the same through OpenRouter and TypeSafe.

**Measured** (live test through OpenRouter, one call with one threat): 711 input tokens, **$0.00003 per call** and 271ms.

| Strategic rate (one bot, threat present all the time) | Cost per hour | 8 hours a day for 30 days |
| ----------------------------------------------------- | ------------- | ------------------------- |
| 1 call/s                                              | ~$0.11        | ~$26                      |
| 0.5 calls/s (the default interval of 2 seconds)       | ~$0.05        | ~$13                      |

Bots ask only when a threat is present, so real usage is far lower. Cost grows in proportion to the number of bots. The reflex layer is free. Safeguards:

- `gateway.maxCallsPerMinute` and `gateway.dailyBudgetUsd`: once the budget is reached, all bots use rules only until the next day.
- A cost total is printed at shutdown, and every decision in the log carries its cost.
