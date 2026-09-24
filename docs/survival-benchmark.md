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

# more trials for a single scenario
npm run benchmark:survival -- --scenarios zombie-x3-lowhp --trials 20
```
