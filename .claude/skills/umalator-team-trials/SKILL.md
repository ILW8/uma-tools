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
| `--nsamples N` | samples for the final verify (default 2000) |
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

Measured on 32 cores, `long --strategy Senkou --min-gain 1`: **251s** — 212s greedy charting (4 rounds ×
12 courses), 38s verify. Add roughly `--screen-rounds` × 50s for each style that loses the screen (the
winner's rounds are reused, not repeated). Phase headers print elapsed seconds, so attribute before tuning.

**Greedy charting dominates.** Each `--chart` invocation already saturates the workers (~3s/course) and
the 12–21 courses run one after another. The compare phases (screen, verify) are one core per race, so
they run one course per core instead — 6.8× measured, not 12×, because the makespan is the slowest
course (~1.8× the mean). So: lower `--min-gain` last, since it buys whole extra 12-course chart rounds.
`--nsamples`/`--screen-samples` only shrink the phases that are already cheap. Cut `--screen-rounds`
only if you know the uma has no style-locked skills in its buyable list.

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
