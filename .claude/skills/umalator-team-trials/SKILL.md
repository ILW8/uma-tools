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

```
node .claude/skills/umalator-team-trials/optimize.mjs <skill_tree.json> <sprint|mile|medium|long|dirt>
```

Run it from the repo root or `umalator-global/`; otherwise pass `--dir path/to/umalator-global`.
`skill_tree.json` is UmaExtractor's, and must contain the `uma` block (`--skills` alone won't do).

| flag | |
|---|---|
| `--strategy S` | skip the style screen and optimize this one |
| `--strategies A,B` | screen only these (default: every style at aptitude B or better) |
| `--race C,C` | conditions, passed to `cli.mjs` (default `firm,sunny,spring,midday,g1`) |
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

**Phase 3 — verify.** Simulates the finished build against the unbuilt uma and compares the measured
total to the sum of the marginals. They should agree within ~25%; a warning means the greedy path
probably isn't near-optimal for that uma.

## Reading the output

- **Leftover SP with a warning** means the hint list is the constraint, not SP. Don't hunt for filler.
- **A skill that ranks well every round but never gets bought** shares a skill group with something
  already purchased (e.g. On the Attack vs Unstoppable). Correct — don't buy both.
- **Marginal, not standalone.** The column is the gain *given everything above it*. You cannot reorder
  the list and keep the numbers.

## Runtime

Measured on 32 cores, `long --strategy Senkou --min-gain 1`: **~109s** — 85s greedy charting (4 rounds ×
12 courses), 19–26s verify. Add roughly `--screen-rounds` × 21s for each style that loses the screen (the
winner's rounds are reused, not repeated), which is what dominates a run that doesn't pass `--strategy`.
Phase headers print elapsed seconds, so attribute before tuning. Charting repeats to the second; the
verify is 12 single-threaded compares racing, so it's the phase that moves run to run.

Both phases are parallel: a chart round passes every course to one `cli.mjs --course a,b,c`, which hands
out (course, skill) pairs to the pool on demand, and the compare phases (screen, verify) run one course
per core. Compare doesn't scale linearly — it's bounded by its slowest single course (~1.8× the mean),
so 6.8× on 12 courses, not 12×.

Charting is ~78% of a run, and `--min-gain` is what buys whole extra chart rounds, so lower it last.
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
them makes the work queue too shallow to balance. What is left is worth **1.9×** — chart mode
re-simulates the unchanged baseline uma once per candidate, and that run measures bit-identical across
candidates (except for candidates that debuff, which have to fall back). It needs a patched
`simulator.worker.js`, which is why it hasn't been done.

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

`cli.mjs --dumpstate`, which prints the built state and exits so two of them can be spliced into one
compare state. If it's missing, this skill's head-to-head phases can't run.
