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

- **What it does:** aims, times attacks, strafes, shields, eats and follows paths. It uses the Mineflayer plugins pvp, pathfinder, auto-eat and armor-manager.
- **What it may not do:** it never waits on network I/O.
- **Where its instructions come from:** it follows the current **Intent**, for example `{ tactic: 'kite', targetId: 42 }`. Jev sets the Intent; when Jev is unavailable, the rules set it.

### Strategic layer

The strategic layer runs every `strategic.intervalMs`. It also runs straight away when a configured trigger event happens (`hurt`, `newThreat`, `lowHp`), but never more than once per `minGapMs`.

Each decision is one Jev request that asks four questions at the same time. Jev answers all four in the same time it would take to answer one.

| Question       | Type   | Answer                                         |
| -------------- | ------ | ---------------------------------------------- |
| `tactic`       | choice | engage, kite, retreat, heal, ignore or other   |
| `threat_level` | score  | a 4-level rubric                               |
| `target`       | choice | one of the IDs of the threats the bot can see  |
| `ambush`       | noul   | the probability that the bot is being ambushed |

The **policy** turns the answers into an Intent according to confidence:

| Confidence                     | What the bot does                         |
| ------------------------------ | ----------------------------------------- |
| At least `thresholds.act`      | Acts on the answer.                       |
| At least `thresholds.cautious` | Acts on a cautious version of the answer. |
| Below `thresholds.cautious`    | Uses the rules instead.                   |

A 0.5 answer to a yes/no question means Jev is unsure, not that the answer is "medium".

### Timing rules

These rules keep the bot from stalling while it waits for Jev:

1. **Jev stays out of `physicsTick`.** A Jev call takes roughly 70–500ms, and a game tick is only 50ms.
2. **One call at a time per bot.** A newer decision cancels the older call through `AbortSignal`.
3. **Every call has a deadline.** The per-call timeout is `jev.timeoutMs`, with at most `jev.maxRetries` retries.
4. **Answers are checked for staleness.** If the target has died or left, or the bot's HP has changed a lot since the call started, the answer is thrown away.
5. **Every failure has a fallback.** On timeout, error, rate limit, budget exhausted or low confidence, the rules decide instead, and the reflex layer keeps following the last Intent.

## Several bots and swarms (Phase 6)

```
  BotAgent A ─┐                 ┌─► Blackboard (threats, claims, positions, roles)
  BotAgent B ─┼─► Bus (typed) ──┤
  BotAgent C ─┘                 └─► Coordinator (optional, no in-game body)
       │
       └──────► JevGateway (one per process: global rate limit + daily budget)
```

- **No shared state between bots.** Each `BotAgent` owns its own Mineflayer bot, layers, mode and logger. `src/index.ts` starts one agent per entry in `config.bots[]`.
- **One `JevGateway` per process.** Every bot calls Jev through it, so one rate limit and one daily budget cover all bots. Every call is tagged with the ID of the bot that made it.
- **`Bus` interface.** It has two methods, `publish(topic, event)` and `subscribe(topic, handler)`, and its events are typed plain JSON. The first implementation, `InProcessBus`, is built on EventEmitter.
- **Blackboard.** Built from bus events. It records the threats each bot has seen and which bot has claimed which target, and drops old entries.
- **Modes:**
  - **Independent:** bots ignore the bus.
  - **Cooperative:** each bot's Jev request includes its allies and the targets they have claimed.
  - **Coordinated:** an optional coordinator sends a periodic Jev request covering the whole blackboard and assigns roles and focus targets. If the coordinator is slow or down, the bots keep acting on their own.

### When to use a network event system

One Node process can run roughly 10–20 bots, so a bus inside the process is enough for now. Bus events are designed to serialize as plain JSON, so the transport can be swapped later without changing bot code.

| Need                                             | Transport                         |
| ------------------------------------------------ | --------------------------------- |
| Bots spread across several processes or machines | Core NATS                         |
| Replaying fights for debugging or training       | NATS JetStream                    |
| Large-scale analytics over many long sessions    | Kafka or Flink (overkill for now) |

Until then, the JSONL decision logs cover replay and analysis.

## Jev integration

- **SDK:** `@typesafe-ai/sdk`, using `TypeSafeClient({ apiKey, baseURL })`.
- **OpenRouter:**
  - Set `TYPESAFE_BASE_URL=https://openrouter.ai/api` and put your OpenRouter key in `TYPESAFE_API_KEY`. Requests then go to `https://openrouter.ai/api/v1/systemone`.
  - The `jev-latest` model maps to `typesafe/jev-1.13`.
  - Responses include `usage.cost`, which the gateway adds up.
  - `client.models.list()` doesn't work through OpenRouter, so don't use it.
- **Questions and thresholds** all live in `src/strategic/questions.ts` and carry a version number. Each log line records that version.

## Configuration

- **Where it lives:** `config/default.json`, or the file named in `MC_JEV_CONFIG`. `src/config.ts` validates it with zod.
- **Structure:**

  | Section    | Contents                                                                                                    |
  | ---------- | ----------------------------------------------------------------------------------------------------------- |
  | `server`   | host, port and Minecraft version                                                                            |
  | `gateway`  | limits shared by all bots: `maxCallsPerMinute`, `dailyBudgetUsd`                                            |
  | `defaults` | settings for each bot: `reflex`, `strategic`, `jev`                                                         |
  | `bots[]`   | `username`, `role`, `owner`, and `overrides` that are merged into `defaults`, including nested `thresholds` |

- **Environment:** `MC_HOST` and `MC_PORT` override the server. `TYPESAFE_API_KEY` and `TYPESAFE_BASE_URL` set the Jev API. Without a key, bots run on rules only.

## Cost

Jev costs **$0.042 per million input tokens**. Output tokens are free. The price is the same through OpenRouter and TypeSafe. One decision uses about 1,000 tokens: the snapshot plus the four questions.

| Strategic rate (one bot) | Cost per hour | 8 hours a day for 30 days |
| ------------------------ | ------------- | ------------------------- |
| 1 call/s                 | ~$0.15        | ~$36                      |
| 0.5 calls/s (default)    | ~$0.08        | ~$18                      |
| On events only           | < $0.04       | < $10                     |

Cost grows in proportion to the number of bots. The reflex layer is free. These safeguards keep costs down:

- `gateway.maxCallsPerMinute`
- `gateway.dailyBudgetUsd`: once it is reached, bots use rules only
- a cost total printed at shutdown

The real figures come from `usage.cost` in the logs.
