# Survival benchmark

The benchmark measures how often a bot survives a fight, so that changes to its fighting and retreating are judged by numbers and not by feel. It was built for Phase 2.5 and is the main tool for tuning in Phase 7.

## How it works

`npm run benchmark:survival` starts a throwaway Paper server (flat world, night, no natural mob spawns) and one bot. For each trial it:

1. Resets the bot: clears its inventory, gives it the scenario's gear, heals it, then damages it down to the scenario's starting HP.
2. Summons the mobs in a ring 8 blocks away.
3. Watches for up to 30 seconds. The trial is **won** if every mob dies, **survived** if the bot is still alive at the timeout, and **died** if the bot dies.

Natural regeneration is turned off so that starting HP is a controlled variable. Each scenario is run 8 times. Results are printed as a table and saved to `logs/survival-<label>-<time>.json`. See [setup.md](setup.md) for the options.

## Results

Survival is the fraction of 8 trials in which the bot was alive at the end. The four configurations are:

- **Baseline:** the Phase 2 bot. It retreats at 6 HP or below, and auto-eat can start eating with a zombie next to it.
- **Hardened, retreat on:** Phase 2.5 with the danger estimate, no eating near hostiles and failed-retreat detection, and retreating still allowed (`rules.retreat: true`).
- **Never retreat:** the same code with retreating forced off.
- **Final (default):** `rules.retreat: false`, which is what ships.

| Scenario          | Description                                | Baseline   | Hardened, retreat on | Never retreat | Final (default) | Baseline end HP | Final end HP |
| ----------------- | ------------------------------------------ | ---------- | -------------------- | ------------- | --------------- | --------------- | ------------ |
| `zombie-lowhp`    | 1 zombie, bot at 6 HP, iron gear           | 2/8 (25%)  | 8/8 (100%)           | -             | 8/8 (100%)      | 4.2             | 5.8          |
| `zombie-x3-lowhp` | 3 zombies, bot at 6 HP, iron gear          | 2/8 (25%)  | 2/8 (25%)            | 6/8 (75%)     | 7/8 (88%)       | 3.2             | 2.3          |
| `skeleton-lowhp`  | 1 skeleton, bot at 6 HP, iron gear         | 1/8 (12%)  | 2/8 (25%)            | 8/8 (100%)    | 8/8 (100%)      | 6.0             | 4.1          |
| `zombie-x3`       | 3 zombies, full HP, iron gear              | 8/8 (100%) | 8/8 (100%)           | -             | 8/8 (100%)      | 16.9            | 16.0         |
| `zombie-x2-weak`  | 2 zombies, full HP, wooden sword, no armor | 8/8 (100%) | 8/8 (100%)           | 8/8 (100%)    | 8/8 (100%)      | 15.1            | 15.1         |
| `baby-zombie`     | 1 baby zombie, bot at 10 HP, iron gear     | 8/8 (100%) | 8/8 (100%)           | -             | 8/8 (100%)      | 10.0            | 10.0         |
| `spider`          | 1 spider, bot at 10 HP, iron gear          | 8/8 (100%) | 8/8 (100%)           | -             | 8/8 (100%)      | 9.8             | 9.8          |
| `skeleton`        | 1 skeleton, bot at 10 HP, iron gear        | 8/8 (100%) | 8/8 (100%)           | -             | 8/8 (100%)      | 7.9             | 8.5          |
| `creeper`         | 1 creeper, full HP, no armor               | 7/8 (88%)  | 8/8 (100%)           | 8/8 (100%)    | 8/8 (100%)      | 16.7            | 15.0         |

## What the numbers say

1. **The biggest win was not fleeing a fight the bot would win.** With 6 HP and iron gear against one zombie, the baseline retreated and survived 2 times in 8. Fighting wins every time and takes almost no damage. The calibrated danger estimate lets the bot see that this fight is safe.
2. **Retreating, as implemented, does more harm than good.** In the two low-HP scenarios where the bot really is in danger, fighting on survived far more often than fleeing did: 100% against 12% (one skeleton) and 75–88% against 25% (three zombies). Our retreat is a bare "run away from the nearest threat", with no safe place to run to. A skeleton shoots the bot in the back, and zombies chase it and come at it from several sides. So `rules.retreat` now defaults to **off**. The retreat logic, the danger estimate and the failed-retreat detection are still there, tested, and can be switched on per bot.
3. **Nothing got worse** in the scenarios the bot already handled (100% both before and after), within the noise of 8 trials.

## Phase 8: shield and strafing against mobs

Two behaviors were added in Phase 8 and each was measured before choosing its default. The rule (agreed beforehand): a behavior ships on only if survival is not lower and mean damage taken is lower.

**Shield** (`rules.shield`): raised between swings and against creepers and archers, lowered for every ready swing and while chasing. Three scenarios were added, each with a shield in the off-hand. Damage counts a death as losing all the starting HP; the plus-or-minus figure is the standard error.

| Scenario                                           | Trials  | Shield on: survived | Shield on: damage | Shield off: survived | Shield off: damage |
| -------------------------------------------------- | ------- | ------------------- | ----------------- | -------------------- | ------------------ |
| `skeleton-shield` (10 HP, iron gear)               | 20 each | 20/20               | 1.5 ± 0.3         | 20/20                | 1.7 ± 0.2          |
| `zombie-x3-lowhp-shield` (6 HP, iron gear)         | 40 each | 34/40               | 3.7 ± 0.3         | 37/40                | 4.3 ± 0.2          |
| `creeper-shield` (full HP, wooden sword, no armor) | 20 each | 20/20               | 8.0 ± 0.8         | 20/20                | 9.6 ± 0.2          |

- It **helps against creepers**: about 17% less damage, around two standard errors.
- It makes **no clear difference against a skeleton**.
- **Against three zombies at low HP, survival was lower with the shield in both runs** (17/20 against 18/20 at first, then 34/40 against 37/40 in a 40-trial rerun). That isn't statistically decisive, but it points the same way twice, and the rule requires survival not to be lower. A likely reason: a raised shield takes a few ticks to become effective, only blocks from the front, and three zombies surround the bot, while blocking delays its own movement.
- **So `rules.shield` defaults to off.** A shield used only against creepers, where it clearly helps, is on the backlog.

**Strafing against mobs** (`rules.strafeMobs`): side-stepping a melee mob within 3 blocks while the weapon recharges. 20 trials each way.

| Scenario          | Strafe on: survived | Strafe on: damage | Strafe off: survived | Strafe off: damage |
| ----------------- | ------------------- | ----------------- | -------------------- | ------------------ |
| `zombie-x3-lowhp` | 19/20               | 3.7 ± 0.3         | 18/20                | 3.8 ± 0.3          |
| `zombie-x2-weak`  | 19/20               | 3.5 ± 1.0         | 20/20                | 4.8 ± 1.0          |
| `baby-zombie`     | 20/20               | 0.0 ± 0.0         | 20/20                | 0.1 ± 0.1          |
| `spider`          | 20/20               | 0.2 ± 0.1         | 20/20                | 0.2 ± 0.1          |

Every difference is within noise, and one scenario lost a survival, so **`rules.strafeMobs` defaults to off.**

**A flaw in the benchmark, found and fixed.** Creeper explosions left craters in the flat test world. Over 20 trials they piled up until the bot or the creeper was stuck in a pit where neither could reach the other, and trials ran out the clock. It showed up as 11 to 13 timeouts in 20 creeper trials, with the shield on or off. The benchmark and the integration tests now turn off the `mob_griefing` gamerule, and the creeper numbers above come from the rerun. The earlier creeper results (8 trials, run last in each benchmark) had fewer explosions before them and show no timeouts, but they ran without this fix. `--trace` prints what the bot sees and intends every second, which is how this was found.

## Phase 9: bow combat

The bow scenarios start the mob 16 blocks away, so there is room to shoot, and carry a bow and 64 arrows on top of the usual gear. 20 trials each way. Damage counts a death as losing all the starting HP; the plus-or-minus figure is the standard error.

| Scenario                                        | Bow on: survived | Bow on: damage | Bow off: survived | Bow off: damage | Arrows that hit |
| ----------------------------------------------- | ---------------- | -------------- | ----------------- | --------------- | --------------- |
| `creeper-bow` (full HP, wooden sword, no armor) | 20/20            | 0.0 ± 0.0      | 3/20              | 18.9 ± 0.7      | 60/82 (73%)     |
| `skeleton-bow` (10 HP, iron gear)               | 20/20            | 0.4 ± 0.2      | 20/20             | 2.6 ± 0.4       | 58/81 (72%)     |
| `zombie-x3-bow` (6 HP, iron gear)               | 20/20            | 0.9 ± 0.2      | 19/20             | 3.3 ± 0.3       | 88/91 (97%)     |

- **Survival is never lower and damage is lower in every scenario, so `rules.bow` ships on.**
- **Every bow trial was won** (all mobs dead within 30 seconds). A creeper dies before it gets close, and three zombies walking in a line are easy targets. The skeleton is harder to hit, because it strafes.
- **The creeper gap is partly a melee weakness.** Without the bow, the bot sprints 16 blocks at the creeper, arrives with momentum right next to it, and the explosion kills it (`--trace` shows it dying about 3.4 seconds in, every time). In the 8-block `creeper` scenario the creeper walks to the bot instead, and the bot survives. Keeping away from creepers in melee is on the backlog under enemy-specific tactics.
- **A bug the benchmark found.** The first run had 11 creeper and 6 skeleton timeouts, with no damage taken. An arrow's knockback pushed the target past `engageRadiusBlocks` (16), the rules stopped counting it as a threat, and the bot went idle while the mob wandered off. A bot that can shoot now keeps its current target out to `bowMaxBlocks`; the table above is the rerun. The first run passed the gate as well (20/20, 20/20 and 19/20 with the bow).

## Caveats

- **Small samples.** With 8 trials, 75% against 88% is not a real difference, and neither are the end-HP differences in the creeper scenario (explosion damage is either large or nothing). Only the big gaps (25% against 88–100%) are trustworthy. Run `--trials 20` before drawing any finer conclusion.
- **A narrow test.** The world is flat, the mobs start 8 blocks away, there is no terrain to hide behind, no shelter, no door and no healing during the trial.
- **The danger model was calibrated on these same scenarios**, so it looks better here than it may elsewhere.
- **What the benchmark cannot show.** With regeneration off, food does not matter, so "no eating near hostiles" is checked by an integration test instead (`test/integration/combat.test.ts`).
- **Untested ideas** from the backlog might reverse the retreat finding. A retreat that runs to a known safe spot, or that breaks line of sight from archers, is a different thing from the one measured here.

## Reproducing

```bash
# the shipped defaults
npm run benchmark:survival -- --label mine

# retreating allowed again, or forced off, to compare policies
npm run benchmark:survival -- --label retreat-on --rules '{"retreat":true}'
npm run benchmark:survival -- --label retreat-off --rules '{"retreat":false}'

# bow on and off (Phase 9)
npm run benchmark:survival -- --scenarios creeper-bow,skeleton-bow,zombie-x3-bow --trials 20 --label bow-on --rules '{"bow":true}'
npm run benchmark:survival -- --scenarios creeper-bow,skeleton-bow,zombie-x3-bow --trials 20 --label bow-off --rules '{"bow":false}'

# more trials for a single scenario
npm run benchmark:survival -- --scenarios zombie-x3-lowhp --trials 20
```
