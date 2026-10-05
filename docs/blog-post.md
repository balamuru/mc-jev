# Never Mine Alone Again: Building an AI Bodyguard Squad in Minecraft

### How dual-speed agent architecture, sub-penny typed AI, and multi-agent coordination turn dumb NPCs into elite tactical companions.

---

You know the feeling all too well. 

You’re deep in an underground ravine at Y=-54. Your inventory is loaded with raw iron, redstone, and twelve precious diamonds. Your hunger bar is down two notches, your torches are running low, and suddenly—*tsst*. 

From the shadows behind you, a creeper is already flashing white. Two skeleton archers are rattling their bows on a ridge above, and a pack of zombies is shuffling through the water stream straight toward you. In vanilla Minecraft, this is usually the exact moment you lose your gear, smash your desk, and stare at the "Game Over!" screen.

Now, imagine an alternate reality. 

The moment that creeper hisses, an iron-clad bot named **Alpha** sprints forward, slices it with a sword, and immediately backpedals 7.5 blocks outside the blast radius before the fuse blows. Behind you, **Bravo** whips out a bow, solves a ballistic trajectory equation accounting for drag and gravity, and snipes the skeleton off the ledge. Meanwhile, **Charlie** steps in front of you with a shield, absorbing zombie hits and drawing aggro away from your low-health flank. 

And when Alpha fights next to you in tight corridors? It intentionally leaps into the air for vertical critical hits—because on-the-ground sweeps would deal collateral friendly-fire damage to *you*.

This isn't a team of try-hard human teammates. It’s an autonomous, intelligent squad running on [**mc-jev**](https://github.com/balamuru/mc-jev) — an open-source project combining deterministic fast-twitch code with **Jev**, TypeSafe’s ultra-fast typed-decision model.

Here’s the story of why traditional AI agents fail miserably in real-time gaming, and how a dual-speed cognitive architecture makes AI companions finally work.

---

## The Catch-22 of Game AI: Why Standard LLMs Die in 50ms

Over the last two years, we’ve seen countless demos of "AI agents playing Minecraft." Almost all of them follow the classic LLM prompt-and-parse pattern: 

1. Capture game state.
2. Build an enormous text prompt.
3. Call GPT-4 or Claude via API.
4. Parse the generated JSON into bot actions.

It sounds great in theory. In an active survival world, it is an absolute disaster.

Minecraft’s physics engine ticks at a relentless **20 Hz** — exactly once every **50 milliseconds**. In that tiny slice of time, arrow trajectories advance, creepers count down their fuses, and attack cooldowns recharge.

```
┌────────────────────────────────────────────────────────┐
│ The Real-Time Gaming Dilemma                           │
│                                                        │
│ Game Tick (50ms)  ████                                 │
│ LLM Call (1500ms) ████████████████████████████████████ │
└────────────────────────────────────────────────────────┘
```

When your AI takes 1.5 to 3 seconds to "think," your bot isn't an intelligent teammate; it's a glorified mannequin waiting to be slaughtered. If you prompt an LLM to control individual motor actions ("move forward 1.2 blocks, swing sword, turn 14 degrees"), it hallucinates coordinates, trips over cobblestone, and costs $20 an hour in tokens.

To augment a human player in real time, you cannot use an LLM as a motor cortex. **You need a dual-speed brain.**

---

## Enter the Dual-Speed Architecture: Reflexes vs. Strategy

The architectural breakthrough in [mc-jev](https://github.com/balamuru/mc-jev) mirrors biological evolution: separate the **fast autonomic nervous system** from the **slower cerebral cortex**.

```mermaid
flowchart TD
    subgraph SquadCoord["Multi-Agent Swarm (Blackboard Loop)"]
        BB[("Shared Blackboard\n• Target Claims\n• Squad Health & Gear\n• Observed Threats")]
        Coord["Squad Coordinator (Jev)\nRuns every 4000ms"]
        Directives["Squad Directives\n• Focus Target\n• Roles: Tank / Ranged / Support / Fighter"]
        Claims["Target Claim Manager\nAnti-Dogpiling Lock (TTL: 8s)"]
        Provocation["Provocation Dispatcher\nOwner/Ally Hurt Event"]

        BB -->|Snapshot| Coord
        Coord -->|Assigns| Directives
        Directives -->|Updates| BB
        Claims <-->|Lock / Release| BB
        Provocation -->|Broadcast Hostile| BB
    end

    subgraph StrategicBrain["Strategic Layer (Jev System 1 Decision Pipeline)"]
        Trigger{"Trigger Event?\n• Timer (2000ms)\n• hurt / lowHp / newThreat"}
        GatewayCheck{"Gateway Check\nBudget & Rate Limit OK?"}
        JevCall["Jev Model Call (~270ms)\n• tactic (engage/retreat/ignore)\n• target selection\n• threat_level (0-3)\n• ambush probability"]
        StaleCheck{"Stale Check\nHP dropped >= 5\nin-flight?"}
        PolicyGate{"Confidence & Safety Gate\n(decideWithJev)"}
        SetOverride["Set Intent Override\n(TTL: 3000ms)"]
        RulesFallback["Fallback to Deterministic Rules\n(decideByRules)"]

        Trigger -->|Yes| GatewayCheck
        GatewayCheck -->|Passed| JevCall
        GatewayCheck -->|Throttled / Over Budget| RulesFallback
        JevCall --> StaleCheck
        StaleCheck -->|Fresh| PolicyGate
        StaleCheck -->|Dropped (Stale)| RulesFallback

        PolicyGate -->|HP <= retreatHp| HardRetreat["Enforce Rules Retreat (Safety Floor)"]
        PolicyGate -->|Threat >= 2.5 or Ambush >= 0.85| JevRetreat["Retreat Intent (Cautious >= 0.5)"]
        PolicyGate -->|Engage with Act >= 0.7| JevEngage["Engage Target (Overrules Rules)"]
        PolicyGate -->|Low Confidence| RulesFallback

        HardRetreat --> SetOverride
        JevRetreat --> SetOverride
        JevEngage --> SetOverride
    end

    subgraph ReflexKinematics["Fast Reflex Loop (50ms / 20 Hz Physics Tick)"]
        Tick(["physicsTick (50ms)"])
        RetreatGain{"Failed Retreat?\nGain < 1.5 blocks"}
        FightBackLock["Fight Back Lock\n(Duration: 4000ms)"]
        ResolveActive{"Active Intent?"}
        FriendlyProximity{"Owner / Ally within 2 blocks\n& Sword equipped?"}
        JumpCrit["Jump Attack\n(Critical hit, 0 sweep AoE)"]
        ExecKinematics["Execute Mechanics\n• 13-tick weapon charge\n• Arrow ballistics & lead\n• Creeper hit-and-run kiting\n• Auto-eat when safe"]

        Tick --> RetreatGain
        RetreatGain -->|Cornered| FightBackLock
        RetreatGain -->|Escaping OK| ResolveActive
        FightBackLock --> FriendlyProximity

        ResolveActive -->|Jev Override Active| FriendlyProximity
        ResolveActive -->|No Override| EvalLocalRules["Local Rules Engine\n(decideByRules)"]
        EvalLocalRules --> FriendlyProximity

        FriendlyProximity -->|Yes| JumpCrit
        FriendlyProximity -->|No| ExecKinematics
    end

    BB -.->|Squad Context & Claims| Trigger
    BB -.->|Assigned Role & Claims| ResolveActive
    SetOverride -.->|Inject High-Level Intent| ResolveActive
    RulesFallback -.->|Clear Override| ResolveActive
```


### 1. The 50ms Reflex Layer (Pure Deterministic Code)
The reflex layer runs locally on every single `physicsTick`. It **never** waits on network I/O. Its job is purely mechanical execution:
* **The 13-Tick Rhythm:** In modern Minecraft combat, button-mashing is penalized; weapons deal maximum damage only when fully charged (13 ticks for swords). The reflex layer times every swing to the tick.
* **Arrow Ballistics Simulator:** Arrows in Minecraft aren't laser beams—they obey gravitational acceleration (0.05 blocks/tick²) and air resistance (0.99 drag). The reflex layer solves the launch pitch angle and leads moving targets by measuring their velocity vectors.
* **Friendly Sweep Prevention:** In Java Edition, swinging a sword on the ground emits a wide slashing sweep attack that damages everything nearby—including you, the owner. When the bot detects you standing within 2 blocks of its target, it automatically jump-attacks. Mid-air swings trigger critical hits with **zero** horizontal sweep!
* **The Creeper Waltz:** Swing once, immediately kite backward past 7.5 blocks while the weapon recharges, and step back in. No blown-up terrain, no lost hearts.

### 2. The Strategic Layer (Jev & TypeSafe System 1 AI)
If the reflex layer provides the muscles, what tells the bot *what* to do? 

That's where **Jev** comes in. Sitting above the reflex loop, Jev evaluates the bigger tactical picture every couple of seconds (or instantaneously when an alarm triggers, like taking sudden damage or detecting low HP).

Instead of parsing ambiguous conversational prompts, Jev is a **System 1 typed judgment model**. We feed it a lightweight JSON representation (~700 tokens) of the bot’s gear, health, and visible threats, and ask multiple typed questions in a single request:

```typescript
// Compact, typed strategic questions evaluated in parallel
{
  tactic: 'engage' | 'retreat' | 'ignore',
  target: 't1' | 't2' | 'none',
  threat_level: score(0..3),      // 0: trivial, 3: deadly
  ambush: probability(0..1.0),    // flanking / encirclement risk
  player_hostile: probability()   // is that stranger about to attack?
}
```

Jev evaluates all questions in parallel in **~270 milliseconds**, costing an astonishing **$0.00003 per call** ($0.042 per million input tokens, with free output tokens). For less than a nickel an hour of intense combat, your bot has continuous high-level tactical awareness.

---

## Multi-Agent Squads: LangGraph-Style State Coordination

A single companion is cool. A synchronized tactical squad is game-changing.

If you deploy three bots without coordination, they fight like toddlers: all three chase the same zombie while a skeleton snipes them from behind. To fix this, [mc-jev](https://github.com/balamuru/mc-jev) borrows architectural patterns familiar to distributed multi-agent systems and state graphs (like LangGraph): **an event-driven blackboard coordination loop**.

```
    Bot A (Vanguard) ──┐
    Bot B (Ranged)   ──┼──► In-Process JSON Bus ──► Shared Blackboard
    Bot C (Support)  ──┘                                  │
                                                          ▼
                                                Squad Coordinator (Jev)
```

### 1. The Blackboard & Target Claims
Bots publish JSON events over an in-memory bus: `heartbeat`, `threats`, `claim`, `damaged`, and `provoked`.
When Bot A engages a zombie, it posts a `claim` with a time-to-live. Bots B and C see the claim on the shared blackboard and automatically peel off to cover other threats. No dogpiling, no wasted DPS.

### 2. Dynamic Role Assignment
Combat is fluid. A team that stays in rigid roles wipes out. The Squad Coordinator periodically assesses the blackboard and dynamically reassigns roles based on inventory and battlefield health:
* **The Tank:** Pinpoints whichever teammate has the lowest HP and intercepts threats bearing down on them.
* **The Ranged Sniper:** Holds position 12 blocks away, focusing fire on creepers and skeleton archers.
* **The Support:** Watches for distress signals on the bus, dropping into guard posture beside wounded allies.
* **The Fighter:** High-mobility frontliner dealing raw melee damage.

### 3. The Ultimate Player Bodyguard
The bots know who their owner is. In chat, you can command them naturally:
* `follow` — They form a perimeter around you as you travel.
* `guard here` — They establish a patrol perimeter, defending your base entrance and returning to their post when idle.
* `hunt` — They comb the nearby area for hostiles to keep you safe while you mine.

And what happens if a griefer or hostile player attacks you on a multiplayer server?
The moment the server fires an `entityHurt` event where the victim is *you*, the bot’s `ProvocationTracker` sounds the alarm. A `provoked` event floods the squad bus, and every bot in your entourage instantly turns and swarms your attacker in coordinated defense.

---

## The Golden Rules for Real-Time AI Companions

Building [mc-jev](https://github.com/balamuru/mc-jev) revealed a set of principles that apply to anyone designing real-time AI agents, whether for gaming, robotics, or interactive simulations:

1. **Keep the Execution Loop Offline:** Never let a network request block your physics tick. If the API lags or goes down, your reflex code should seamlessly keep fighting.
2. **Use AI for Intent, Code for Kinematics:** Let deterministic code handle pathfinding, aiming, and weapon cooldowns. Use AI models to judge danger, allocate roles, and choose strategies.
3. **Enforce Asymmetric Confidence Gates:** Allow AI to add caution easily (e.g. retreating when an ambush is detected), but demand high confidence before overruling baseline safety rules.
4. **Economics Matter:** Real-time software cannot burn $0.05 every second on massive multimodal models. Purpose-built, typed System 1 models like Jev provide the programmable common sense you need at fraction-of-a-cent operational costs.

---

## Try It Yourself

Want an intelligent squad watching your back on your next Minecraft adventure?

The entire project is open-source, fully typed in TypeScript, and ready to run against local Paper servers or live multiplayer worlds:

👉 **GitHub Repository:** [https://github.com/balamuru/mc-jev](https://github.com/balamuru/mc-jev)

Clone the repo, spin up your bots, and experience what it feels like to never have to mine alone again.
