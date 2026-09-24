# Plan: closing the gaps against the original plan

## Context

A review of the implementation against the original plan found six gaps (see the review in the conversation of 2026-09-24):

1. **Shielding (FR-3)** is not implemented. Nothing ever raises a shield.
2. **Strafing (FR-3)** only happens against players, never against mobs.
3. **Coordinator roles (FR-11).** The plan said the coordinator would assign roles (`tank` / `ranged` / `support` / `scout`). It only picks a focus target, and roles are labels nothing acts on.
4. **Line-of-sight and field-of-view filtering (FR-2)** has never been tested on real terrain.
5. **The coordinator uses `bots[0]`'s confidence thresholds** for the whole squad.
6. **Bot-vs-bot matches (Phase 5 test plan)** were never run. The player combat test uses a scripted client, not a second `BotAgent`.

Two housekeeping items came up in the same review: the CI action versions, which GitHub has deprecated, and 6 moderate `npm audit` warnings.

The approach follows what Phase 7 taught: **every new behavior is measured, and it only ships switched on if the benchmark shows it helps, or at least doesn't hurt.** Otherwise it ships switched off, with the numbers recorded.

## Phase 8: Shield and strafing against mobs (gaps 1, 2)

**What to build**

- **Equipping.** `mineflayer-armor-manager` already knows shields are off-hand items. Confirm it equips one to the off-hand on a real server, and add an explicit equip if it doesn't.
- **A pure `shieldAction` function** in `src/reflex/shield.ts`, the same style as `pvpAction`. Rules:
  - **Raise** between swings, when a melee threat is within reach and the weapon is still recharging.
  - **Lower** just before the swing is ready. In Java Edition you can't attack while blocking.
  - **Raise** when a creeper within 4 blocks is fusing, or when a ranged mob is within its range and the bot is not about to swing.
  - **Lower** while chasing, because blocking slows walking to a crawl.
  - **Stay lowered** for a few seconds after an axe hit disables the shield (the `shieldDisabled` state, if Mineflayer exposes it, or a cooldown after the shield-break sound).
- **Actuator.** Call `activateItem(true)` and `deactivateItem()` from `MineflayerActuator.tick`. Blocking must never delay a ready swing.
- **Strafing against mobs.** Reuse the `Strafer`, but only against melee mobs within 3 blocks while the weapon recharges. Strafing too early delays reaching the target.
- **Config:** `rules.shield` and `rules.strafeMobs` (booleans), each overridable per bot.

**Tests**

- **Unit tests** for `shieldAction`: raise and lower timing, never blocking when a swing is ready, the creeper and ranged cases, the lockout after an axe hit, no shield in the inventory.
- **Actuator tests** with a fake bot: `activateItem` and `deactivateItem` calls line up with swings.
- **Integration test:** a bot with a shield against a zombie and a skeleton takes measurably less damage than the same bot without one. It records both numbers, and the check is only that the shielded bot takes less, not by how much.

**Benchmark gate**

- Add scenarios to the survival benchmark: `skeleton-shield`, `zombie-x3-lowhp-shield` and `creeper-shield` (the same as the existing scenarios, with a shield in the gear).
- Run each combination of `shield` and `strafeMobs` for 20 trials on the scenarios where they apply.
- **Decision rule:** each switch ships on by default only if survival is not lower and mean damage taken is lower. Record the numbers in `docs/survival-benchmark.md`.

**Result (done 2026-09-24):** the shield cut creeper damage by about 17% but lowered survival against three zombies at low HP (34/40 against 37/40, and 17/20 against 18/20). Strafing against mobs showed no measurable effect. Both ship off. A creeper-only shield went on the backlog. The benchmark was also fixed: creeper craters had been trapping bots. The integration tests also found a safety bug: a sword swing on the ground sweeps into anyone next to the target, including the owner. The bot now only swings as a critical hit when another player is close to its target.

## Phase 9: Bow combat

The `ranged` role needs a bot that can fight with a bow. It is also useful on its own: a bow lets a bot hit a creeper before it gets close, or a skeleton across a gap.

**What to build**

- **Aiming.** An arrow falls on an arc, so aiming at the target is not enough.
  - **`minecrafthawkeye` was checked and rejected (2026-09-24).** It keeps its state in module-level globals tied to one bot, so it cannot run several bots in one process, and it equips weapons and draws the bow on its own ticks, which would fight our actuator for control.
  - **So we write our own:** a pure `bowAim` function in `src/reflex/bow.ts` that computes the pitch for a given distance and height difference from Java Edition arrow physics (launch speed at full draw, gravity, drag). It leads a moving target by its velocity times the flight time.
- **Drawing and releasing.** A pure `bowAction` function decides each tick whether to draw (`activateItem()`), hold, or release (`deactivateItem()`):
  - Release only after a full draw (about 20 ticks) and with a clear line of sight. Use the existing raycast.
  - Don't draw when the target is within melee reach. Switch to the sword instead.
  - Don't draw with no arrows. Check the inventory, counting `arrow`, `spectral_arrow` and `tipped_arrow`.
  - Keep distance while shooting: back off if a melee mob comes closer than about 6 blocks, then fall back to melee if it keeps coming.
- **Weapon choice** in the actuator: bow at range (about 8 to 24 blocks) when there are arrows and a bow; melee weapon up close. `bestWeapon` gains a range-aware sibling.
- **Rules:**
  - A bot with a bow and arrows engages ranged-first targets (skeletons, creepers) at range when `rules.bow` is on.
  - Otherwise nothing changes.
- **Config:** `rules.bow` (boolean, per bot) and `rules.bowRangeBlocks` (min and max).
- **Safety:** before releasing, check that the arrow's path to the target doesn't pass near a protected player (the owner, allies or other bots). The same protection that applies to melee applies to arrows.

**Tests**

- **Unit tests:**
  - `bowAim`: pitch increases with distance and is higher for targets above the bot; the lead scales with target speed; out-of-range targets are refused.
  - `bowAction`: full-draw timing, no drawing in melee reach, no drawing without arrows, no release when line of sight is blocked or a protected player is in the way.
- **Actuator tests** with a fake bot: the draw, hold and release sequence; switching between bow and sword with distance.
- **Integration tests on a real server:**
  - A bot with a bow and arrows kills a stationary target (a mob with `NoAI`) at 12 and 20 blocks.
  - It kills a skeleton at range.
  - It never releases while the owner stands between it and the target.

**Benchmark gate**

- Add survival scenarios with bow and arrows in the gear: `creeper-bow`, `skeleton-bow` and `zombie-x3-bow`.
- Run 20 trials each with `rules.bow` on and off.
- **Decision rule:** `rules.bow` ships on by default only if survival is not lower and mean damage taken is lower. Also record hit rate (arrows that hit, out of arrows fired).

**Result (done 2026-09-24):** with the bow on, all 60 benchmark trials were won and damage fell in every scenario (creeper 0.0 against 18.9, skeleton 0.4 against 2.6, three zombies 0.9 against 3.3), with 72% to 97% of arrows hitting. `rules.bow` ships on. The benchmark found a bug: arrow knockback pushed targets past the engage radius and the bot gave up on them, so a bot that can shoot now keeps its target out to `bowMaxBlocks`. Two parts of the plan were left to the `ranged` role in Phase 10: backing off from a melee mob while shooting (the bot switches to melee under 6 blocks instead), and preferring skeletons and creepers over nearer targets. `rules.bowRangeBlocks` became `rules.bowMinBlocks` and `rules.bowMaxBlocks`.

## Phase 10: Roles that change behavior (gaps 3, 5)

**Role behaviors** (in `ModeController`, only in a swarm)

| Role      | Behavior                                                                                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fighter` | Today's behavior. The default.                                                                                                                                                                                       |
| `tank`    | Engages the threat closest to the most hurt ally, not the nearest to itself. Keeps its shield up whenever it isn't swinging, if Phase 8 shipped shields.                                                             |
| `support` | Goes to help a hurt ally before taking a fresh target of its own, and uses a lower help threshold.                                                                                                                   |
| `scout`   | In `hunt` mode, wanders twice as far, and on seeing threats reports them to the blackboard before engaging (with a short delay).                                                                                     |
| `ranged`  | Uses the Phase 9 bow combat: keeps 10 to 20 blocks from threats and shoots, prefers skeletons and creepers, and falls back to melee only when cornered. Needs a bow and arrows; without them it acts as a `fighter`. |

**Coordinator role assignment**

- Add a second question to the coordinator's existing Jev request: one `choice` per bot (`fighter`, `tank`, `support`, `ranged`) given the squad's HP and gear. `ranged` is only offered for a bot that has a bow and arrows.
- This adds no extra calls, because Jev answers all the questions in one request in parallel.
- Roles are held for `directiveTtlMs`, and a bot then falls back to its configured `bots[].role`.
- Assignments below `cautious` confidence are ignored.
- **Deterministic fallback when there is no Jev:** the bot with the most armor points becomes the tank, a bot with a bow and arrows becomes ranged, and the rest are fighters. This lets coordinated mode run without a key.
- **Thresholds:** add `swarm.coordinator.thresholds` (defaulting to `defaults.jev.thresholds`) and stop reading `bots[0]`.

**Tests**

- Unit tests for each role's decisions.
- Coordinator tests: the role question is present, answers are parsed and applied, low-confidence answers are ignored, directives expire, and the deterministic fallback works.
- Agent tests: a tank picks the threat near a hurt ally, a support goes to help first, and a ranged bot keeps its distance.
- Integration test: a coordinated squad of three on a real server, where one bot is assigned `tank`.

**Benchmark gate**

- `benchmark:squad` gets a harder wave, for example 8 zombies plus 2 skeletons, because the current wave is too easy to show differences. It also gets a gear option so one bot can carry a bow.
- Run `cooperative` against `coordinated` with roles, 20 trials each, with and without Jev.
- **Decision rule:** roles stay on in `coordinated` mode only if squad damage is lower and nobody dies more often. Either way, record the result in `docs/tuning.md`.

**Result (done 2026-09-24):** on a harder wave (8 zombies and 2 skeletons, one bot with a bow), roles from Jev cut squad damage from 27.2 ± 1.3 to 20.3 ± 1.4 with no deaths (against one). Roles by gear, without Jev, made no measurable difference (24.0 against 23.0). Both meet the rule, so `swarm.coordinator.assignRoles` ships on; `swarm.mode` stays `cooperative`. Roles slow clearing by about half. The tank's shield and the scout's engagement delay were not built (shields are off, and the scout's report is synchronous).

## Phase 11: Test coverage and housekeeping (gaps 4, 6)

- **Line of sight on real terrain.** Add an integration test that builds a wall with `/fill` between the bot and a zombie, and asserts:
  - with `requireLineOfSight: true`, the zombie is not visible while the wall stands;
  - it becomes visible when the wall is removed;
  - with the setting off, the zombie is always visible.
  - Do the same for `fovDegrees`, turning the bot away from the zombie.
- **Bot-vs-bot match.** Two `buildApp` instances on one server, each with its own single bot (so they don't protect each other).
  - One is provoked by a scripted hit (`/damage … by …`, or by making the other attack first).
  - Assert that the second bot fights back, that the fight ends, and that the protected-player rules still hold for their owners.
  - If practical, run 10 matches as a small benchmark: a shield against no shield, or a sword against an axe.
- **A known intermittent failure:** `combat.test.ts` › "fights one zombie at low HP, but retreats from a group" failed twice in about 12 full-suite runs during Phase 8, only under full-suite load, and never in 8 solo runs. The first cause (an uncontrolled starting HP) was fixed; the second failure was not captured. Find it, for example by keeping the full output of failed runs.
- **CI:** bump `actions/checkout` and `actions/setup-node` to their current major versions, and pin `runs-on` so the Ubuntu 26 switch doesn't happen unannounced.
- **npm audit:** check whether a newer Mineflayer resolves the 6 moderate warnings. If it doesn't, document why they don't apply (they are in the online-mode authentication path, which offline bots never use) and leave them.

## Order and size

| Phase                               | Size                                                                                                       | Depends on                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 8: Shield and strafing against mobs | Medium: new pure module, actuator changes, benchmark runs of about 30 minutes                              | none                                                       |
| 9: Bow combat                       | Large: aiming, draw and release timing, weapon switching, arrow safety, benchmark runs of about 30 minutes | none (uses the existing raycast and protection checks)     |
| 10: Roles                           | Medium to large: mode logic, coordinator, harder squad benchmark of about 45 minutes                       | Phase 8 for the tank's shield, Phase 9 for the ranged role |
| 11: Coverage and housekeeping       | Small                                                                                                      | none                                                       |

Each phase ends as before: `npm run check` and the integration suite passing twice in a row, docs updated (requirements, phases, architecture, setup, tuning), then a commit and a push. CI must be green before the next phase starts. Expected Jev spend for all the benchmark runs is under $0.30.

## Decisions (agreed 2026-09-24)

1. **Bow combat** is its own phase (Phase 9), and the `ranged` role uses it.
2. **Defaults:** a new behavior (shield, mob strafing, bow, roles) ships on by default only if the benchmark shows it helps. Otherwise it ships off, with the numbers recorded.
3. **Commits:** each phase is committed and pushed once its checks, tests and docs are done, without asking first. This plan document goes in with the first phase's commit.
