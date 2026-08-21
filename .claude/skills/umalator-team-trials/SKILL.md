---
name: umalator-team-trials
description: Use when choosing a running style or deciding which skills to buy for an Umamusume uma in Team Trials, given an UmaExtractor skill_tree.json and a race type (sprint/mile/medium/long/dirt). Covers "what skills should I buy", "which strategy for this uma", "optimize this uma", "is X worth the SP".
---

# Team Trials skill optimization

## Overview

`umalator-global/cli.mjs --chart` ranks each candidate skill **in isolation** against the uma without
it, on **one** course. Team Trials rotates courses, and skills are substitutes for each other — so a
single chart answers neither "which style" nor "what do I actually buy". This skill wraps the CLI with
the two things it doesn't do:

1. **Weight over the real course distribution** for the race type, not one hand-picked course.
2. **Re-chart after every purchase**, so each number is a *marginal* gain against what you already own.

Both matter. Recovery skills routinely show 1.3 bashin standalone and 0.04 once you own a better one.

## Usage

Build the simulator worker from the TS sources first, and point the run at it — that way the
optimizer reflects any local engine edits in `uma-skill-tools/` instead of the committed bundle:

```
node umalator-global/build-worker.mjs <scratch>/worker.js
UMALATOR_WORKER=<scratch>/worker.js node .claude/skills/umalator-team-trials/optimize.mjs <skill_tree.json> <sprint|mile|medium|long|dirt>
```

`<scratch>` is any temp path (the session scratchpad is fine). The env var propagates through
`optimize.mjs` into `cli.mjs` and its worker threads; if it's unset, everything falls back to the
committed `simulator.worker.js`.

Run it from the repo root or `umalator-global/`; otherwise pass `--dir path/to/umalator-global`.
`skill_tree.json` is UmaExtractor's, and must contain the `uma` block (`--skills` alone won't do).

| flag | |
|---|---|
| `--strategy S` | skip the style screen and optimize this one |
| `--strategies A,B` | screen only these (default: every style at aptitude B or better) |
| `--race C,C` | conditions, passed to `cli.mjs` (default `firm,sunny,spring,midday,g1`) |
| `--dist D,D` | only courses of these distances (e.g. `--dist 2000`); default is the whole type |
| `--min-gain N` | stop buying below this weighted bashin (default 0.05) |
| `--top N` | runners-up to print per round (default 6) |
| `--nsamples N` | samples for the final verify (default 600) |
| `--screen-samples N` | samples for the style screen (default 500) |
| `--screen-rounds N` | skills to build per style before screening (default 4; `0` restores the old unbuilt screen) |
| `--out F` | write the result as JSON |
| `--selfcheck` | validate every course id against `course_data.json` and exit |

## What it does

**Phase 1 — style screen.** Buys `--screen-rounds` skills for *each* viable style, then head-to-heads
the partial builds. It cannot screen unbuilt umas: `buyable_skills` would be invisible, and a
style-locked skill is worth multiple bashin to exactly one style. Angling and Scheming needs
`order==1`, so only a front runner ever fires it — on Mayano Top Gun it is +3.04 bashin to Nige on
Tokyo 2500, which reverses a 1.26 bashin deficit to Senkou. **A margin threshold cannot catch this**;
the same skill flipped an 8.28 bashin gap on Kyoto 3000 once Nige had the stamina to use it. The
under-2-bashin warning still fires, but treat it as "definitely rerun with `--strategy`", not as the
boundary of where a flip is possible.

The winner's partial build carries into phase 2, so screening the losing styles is the only extra cost.

**Phase 2 — greedy buy order.** Charts all 12–21 courses, weights by frequency, buys the best
bashin-per-SP, then re-charts with that skill owned. Repeats until nothing clears `--min-gain` or SP
runs out. Runners-up print under each pick — that's where you see which skills just became worthless.

Candidates are priced as the whole **prerequisite chain** they force you to buy, not the single skill.
`cli.mjs` charts and prices each skill alone, so without this a build claims SP it doesn't have —
measured, a 13-skill long build hid 538 SP of prereqs and reported 702 SP left when the real number was
164. The chain comes from `skill_meta.json`: within a `groupId`, `order` ranks strongest-first, so
anything ordered after a skill in its group sits below it in the tree (Concentration ← Focus,
Unstoppable ← On the Attack, every ◎ ← its ○). Chains run up to 3 deep (Muddy ○ → Muddy ◎ → Maestro of
the Mud); the × members sort last but are never in `buyable_skills`, so they drop out on their own.

A chain is ranked on the **top** skill's gain alone. The lower tiers have effects too, but they're
charted against the same baseline and are usually partial substitutes, so summing would oversell. That
undersells a chain, which self-corrects — once greedy buys a lower tier on its own merits, the tier
above reprices to its own SP and jumps the ranking. In practice this is what happens: the long build
above bought all five whites unprompted and paid zero bundle premium. It also demotes gold skills whose
white is dead weight — Breath of Fresh Air went from pick #1 at a fake 153 SP to pick #17 at a real 306.

**Phase 3 — verify.** Simulates the finished build against the unbuilt uma and compares the measured
total to the sum of the marginals. They should agree within ~25%; a warning means the greedy path
probably isn't near-optimal for that uma.

## Reading the output

- **Leftover SP with a warning** means the hint list is the constraint, not SP. Don't hunt for filler.
- **A skill that ranks well every round but never gets bought** is a substitute for one already owned —
  it overlaps the effect without sharing a group (Straightaway Recovery vs Deep Breaths, both recovery).
  Group-mates are the opposite case: they're prerequisites, so you buy *both*, lower tier first.
- **`+N prereq` on a runner-up** means its SP column is the chain price, not the skill's own cost. The
  skill reappears at its own price once the tier below it is bought.
- **`spurt A% / B%` on the screen line** is the share of races each style finished with a full last
  spurt. Diagnostic, not a tiebreak — it explains where a margin comes from, not whether to trust it. A
  style that can't spurt bleeds bashin no skill buys back, but the gap survives without it: at medium
  2400 both styles spurt 0% of the time and Senkou still wins by 14 bashin, on HP drain alone.
- **Marginal, not standalone.** The column is the gain *given everything above it*. You cannot reorder
  the list and keep the numbers.

## Runtime

Measured on 32 cores against the committed bundle, i.e. before the baseline cache below,
`long --strategy Senkou --min-gain 1`: **97s** — 87s greedy charting (4 rounds × 12 courses), 10s
verify. Add roughly `--screen-rounds` × 21s for each style that loses the screen (the winner's rounds
are reused, not repeated), which is what dominates a run that doesn't pass `--strategy`.
Phase headers print elapsed seconds, so attribute before tuning. Charting repeats to the second; the
verify is 12 single-threaded compares racing, so it's the phase that moves run to run.

Both phases are parallel: a chart round passes every course to one `cli.mjs --course a,b,c`, which hands
out (course, skill) pairs to the pool on demand, and the compare phases (screen, verify) run one course
per core. Compare doesn't scale linearly — it's bounded by its slowest single course (~1.8× the mean),
so 6.8× on 12 courses, not 12×.

Charting is ~90% of a `--strategy` run, and `--min-gain` is what buys whole extra chart rounds, so lower
it last. Verify is not where the time goes — 20% of a run at the old `--nsamples 1000`, 11% at 600.
`--nsamples`/`--screen-samples` only shrink the compare phases, and what you pay is the count you asked
for **plus** a full throwaway run at every rung below it — `doCompare()` re-runs the whole comparison at
20, 120, 600, 2400 to refresh the website's graph as it sharpens, and headless every one of those is
discarded. So the flag has cliffs: 500 → 640 samples, 600 → 740, but 601 → 1341, 1000 → 1740, 2000 →
2740. Both defaults are set against the decision the number feeds rather than for precision, so raising
them buys little. Cut `--screen-rounds` only if you know the uma has no style-locked skills.

Two things measured and not worth doing. Stripping the simulator's telemetry arrays: ~0%, because a CPU
profile puts ~92% of a run in physics (`step`, `updateTargetSpeed`, `processSkillActivations`,
`hpPerSecond`) and GC at 1.1%. Pruning low-scoring candidates across greedy rounds: the chart's own
sampling ladder already spends only 16% of a round on the candidates that die at 20 samples, and dropping
them makes the work queue too shallow to balance.

One thing that was worth doing, and is done. Chart mode used to re-simulate the unchanged baseline uma once
per candidate, which is half of every round; `umalator/compare.ts` now caches the baseline's races and
replays them, so a round simulates it once. **~1.95×** inside the worker and **1.7×** end to end over a
523-candidate one-course chart (21.3s → 12.3s on 32 cores, and 10.6s → 6.4s for the same chart on a nige
uma), for byte-identical output. This is the reason the build step in Usage matters — the committed bundle
predates it. Two kinds of candidate opt out and run at the old speed: debuffs, which really do change the
baseline uma's race, and skills the uma already owns, which don't shift the builder's rng the way the rest
of the candidates do.

## Assumptions baked in

Popularity 1, firm ground, no teammates or opponents beyond the sim's 9-uma field. So this ranks
**pace and stamina value only** — not the skill-activation-count component of Team Trials scoring, which
rewards owning many cheap skills that fire. Treat the buy order as the performance floor, not the
whole score.

Ground distribution is roughly 77% firm across race types, so the default is representative; use
`--race` if you care about the wet-track tail.

## Course data

`courses.json` holds the frequency tables (150-match / 750-race sample,
[source](https://vtuberstart.com/umamusume-kyogijo)). Distributions drift as the game adds courses —
`--selfcheck` verifies every id still resolves to the right track, distance and surface, but it cannot
tell you the *weights* have gone stale. Re-check the source if results look off.

## Requires

`umalator-global/build-worker.mjs` for the build step, and `cli.mjs` honoring `UMALATOR_WORKER`
(both since the simulator-worker-ts branch). On an older checkout skip the build step and run
against the committed bundle.

`cli.mjs --dumpstate`, which prints the built state and exits so two of them can be spliced into one
compare state. If it's missing, this skill's head-to-head phases can't run.

`skill_meta.json` with `groupId` and `order` on every entry — that's the only source for prerequisites.
`--selfcheck` asserts both fields exist and that the Outer Post ◎/○ pair still orders strongest-first.
