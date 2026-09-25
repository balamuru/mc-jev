# Tuning

Phase 7 used measurements, and not intuition, to adjust Jev's questions, the timeout, the call limit and the swarm defaults, and to check whether Jev makes the bots better than rules alone. This page records what was measured, what changed, and what did not.

Everything here can be reproduced with the commands in [setup.md](setup.md#tuning-tools). Total spend on the real API for all the experiments below was under 10 cents.

## Jev against rules alone

**Question:** does asking Jev make a bot survive more often than the rules alone?

**Method:** the [survival benchmark](survival-benchmark.md) with and without `--jev`, on all nine scenarios (8 trials each), then 20 trials each of the one scenario where the first run differed.

| Scenario                                                          | Rules only | With Jev |
| ----------------------------------------------------------------- | ---------- | -------- |
| Eight scenarios (zombies, skeleton, spider, creeper, baby zombie) | 100%       | 100%     |
| 3 zombies at 6 HP, 8 trials                                       | 88%        | 50%      |
| 3 zombies at 6 HP, **20 trials**                                  | **75%**    | **75%**  |

**Finding:** Jev is at parity with the rules, neither better nor worse. The one apparent drop (50% against 88%) disappeared with more trials: it was noise, which is what 8 trials can do. In the decision log for that scenario Jev mostly chose the same nearest zombie the rules would have.

**Why no gain?** With retreating off (see the survival benchmark), the rules already fight well against mobs, so there is little left for Jev's judgment to improve. Jev's value here is as a safety-checked second opinion that costs about $0.00003 per call, and in the situations where the rules are blunt: choosing between targets, and reading the squad.

## Jev's questions

**Method:** `npm run eval:jev` runs the question set on 17 labeled situations (easy and hopeless fights, a heavy mob, surrounded or not, target choice with and without squad claims, and armed, unarmed and passing players) and checks each answer against what a sensible judge would say.

| Question set     | Expectations held | Notes                                                                                                                                     |
| ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| v2               | 12 of 13          | A ravager (100 HP) was rated only 1.8/3 danger. Jev was given nothing but the mob's name.                                                 |
| **v3** (shipped) | **13 of 13**      | Each threat now carries two neutral facts, `max_health` and `attack_style` (`melee`, `ranged` or `explodes`). The ravager is rated 2.4/3. |

The facts are plain data, not our own verdict, so Jev's judgment stays independent of the rules.

**Player hostility.** Jev separates the cases well: an unarmed stranger far away scores about 0.06, a stranger holding a pickaxe 0.05, one with a bow standing still 0.19, an armed stranger walking toward the bot 0.50 to 0.62. None reaches the 0.85 needed to treat a stranger as hostile, so Jev-triggered pre-emptive fights essentially never happen. That is deliberate: attacking a bystander is the worst mistake the bot can make, and a real attack is caught by the reliable signal (the server naming the attacker). The threshold is unchanged.

## Timeout and cost

Measured over about 1,500 real calls through OpenRouter:

|                       | Single bot    | Squad of three                           |
| --------------------- | ------------- | ---------------------------------------- |
| Latency p50           | 184 to 191 ms | 171 ms                                   |
| Latency p99           | 376 to 680 ms | 325 ms                                   |
| Slowest call          | 743 ms        | 908 ms                                   |
| Input tokens per call | about 800     | about 1,200 (the squad is described too) |
| Cost per call         | $0.000035     | $0.000051                                |

- **`jev.timeoutMs` 800 → 1000.** The slowest calls (743 ms and 908 ms) were too close to 800. A late answer is harmless, because a stale one is discarded, but a timeout throws away a good decision. Timeouts stay rare: 2 in about 660 single-bot calls, none in the squad run.
- **`gateway.maxCallsPerMinute` 60 → 300.** Three bots in a fight make about 70 decisions a minute, so the old shared limit throttled a squad and it fell back to rules. The daily budget still caps spending.
- A full survival benchmark with Jev cost $0.015, and a full squad benchmark with Jev $0.043.

## Squad modes

**Question:** does cooperating help, and does the coordinator add anything?

**Method:** `npm run benchmark:squad`. Three bots in iron gear face a ring of six zombies, 8 trials per mode, with and without Jev. Numbers are the mean, with the standard error after the plus-or-minus sign.

| Mode        | Rules only: seconds to clear | Rules only: squad HP lost | With Jev: seconds to clear | With Jev: squad HP lost |
| ----------- | ---------------------------- | ------------------------- | -------------------------- | ----------------------- |
| independent | 11.2 ± 0.2                   | 12.1 ± 1.1                | 9.7 ± 0.3                  | 13.0 ± 0.9              |
| cooperative | 9.6 ± 0.1                    | 7.9 ± 0.9                 | 9.3 ± 0.7                  | 8.6 ± 1.4               |
| coordinated | not run                      | not run                   | 9.3 ± 0.2                  | 11.2 ± 2.0              |

- **Cooperating helps.** Spreading over the targets, so that bots don't all pile onto one, cuts the squad's damage by about a third (12.1 → 7.9 without Jev, 13.0 → 8.6 with Jev), and without Jev it also clears the wave 14% faster. All 48 trials were cleared with no deaths.
- **The coordinator did not help.** Its focus-fire directive made the squad damage 11.2 ± 2.0, no better than independent and worse than plain cooperation (8.6 ± 1.4), though the difference from cooperation is within noise. A plausible reason is that sending everyone at one target makes the bots bunch up and the others get hit while it dies, but this was not tested.
- **So `swarm.mode` now defaults to `cooperative`.** `coordinated` stays available, but there is no evidence yet that it is worth its cost.

### After the sweep-safety fix (Phase 8)

Phase 8 made bots swing only as critical hits when another player is within 2 blocks of their target, so they can't hurt each other with sword sweeps. Squad bots often stand next to each other's targets, so this affects them. One rerun of `cooperative`, rules only, 8 trials: all waves cleared, no deaths, 10.2 seconds to clear (was 9.6) and squad damage 9.3 (was 7.9). The damage average includes one outlier trial of 25; the median was 8.3. So bots are a little slower, and no longer hurt each other.

### Roles (Phase 10)

**Question:** do roles help a coordinated squad?

**Method:** a harder wave than before: 8 zombies and 2 skeletons in a ring 8 blocks away. Three bots in iron gear, and the third also carries a bow and 64 arrows. 20 trials per row. `--no-roles` turns role assignment off, so the coordinator only picks focus targets. Rules only, the coordinator assigns roles by gear, so it made the archer `ranged` and one of the others `tank`. With Jev, Jev picked the roles; the archer was nearly always `ranged` and about half the time another bot was `tank`.

| Configuration                | Seconds to clear | Squad HP lost | Deaths | Waves not cleared in 60 s |
| ---------------------------- | ---------------- | ------------- | ------ | ------------------------- |
| cooperative, rules only      | 15.0 ± 0.4       | 23.3 ± 1.1    | 0      | 0                         |
| coordinated, no roles, rules | 15.4 ± 0.4       | 24.0 ± 1.2    | 1      | 0                         |
| coordinated, roles by gear   | 22.7 ± 1.1       | 23.0 ± 1.3    | 0      | 0                         |
| coordinated, no roles, Jev   | 16.6 ± 0.5       | 27.2 ± 1.3    | 1      | 0                         |
| coordinated, roles from Jev  | 24.6 ± 1.4       | 20.3 ± 1.4    | 0      | 1                         |

- **With Jev, roles cut squad damage by a quarter** (27.2 → 20.3, about 3.6 standard errors), and no bot died. Two later reruns of the same setup (20 and 30 trials, run while chasing the uncleared wave) gave squad damage 22.1 and 21.8 and two deaths in total, so over 70 trials that is 2 deaths, against 1 in 20 without roles: still no more often, but "no deaths" was partly luck.
- **Without Jev, roles made no measurable difference to damage** (24.0 → 23.0, within noise), with no deaths against one.
- **Roles make the squad slower**, by about half, probably because the ranged bot spends time backing away from zombies instead of fighting them (not measured separately). One wave with Jev’s roles was not cleared within 60 seconds (no bot died in it). A later rerun with diagnostics caught the same thing once in 30 trials: a skeleton had ended up 21 blocks away, outside the 16-block engage radius and no longer attacking, and guard-mode bots leave such a mob alone.
- **So `swarm.coordinator.assignRoles` defaults to on.** Under the agreed rule (squad damage lower, nobody dying more often) it passes both with and without Jev, clearly so with Jev. `swarm.mode` stays `cooperative`: coordinated with roles and no Jev is no better than cooperative (23.0 against 23.3) and slower.
- **Jev without roles was the worst row** (27.2): the focus directive again did not help, as in the first squad runs.
- The two Jev runs cost $0.18 in total (40 trials of three bots plus the coordinator).

## A bug the experiments found

The first Jev squad run **crashed the whole process**: the SDK leaves a rejection nobody is listening to whenever a call is cancelled, or times out, while its response is still arriving, and Node treats that as fatal. It only shows up under load. It was reproduced against a slow local server, and `installAbortGuard` now swallows exactly those abort-type rejections. See [architecture.md](architecture.md#jev-integration).

## Not done, and worth trying

- **More trials.** 8 per cell can only detect big effects. Use `--trials 20` or more before trusting a difference of a few percent.
- **Retreat with a destination.** The survival benchmark showed fleeing on foot is harmful; running to a known safe spot might not be.
- **Question wording for `ignore`.** Jev's `ignore` answers were low confidence (mean 36%), so they rarely change anything.
- **Confidence thresholds.** `act` 0.7 and `cautious` 0.5 are unchanged. In the squad run, Jev's engage answers averaged 69% confidence with 444 of 753 at or above `act`, so the thresholds are working, but nothing tested a different value.
