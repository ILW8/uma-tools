# Rebuild simulator.worker.js from TypeScript (feature parity)

## Problem
`umalator-global/simulator.worker.js` is a committed esbuild bundle. Its TS entry
(`umalator/simulator.worker.ts` + `compare.ts`/`hpcalc.ts`) exists in-repo, but the
`uma-skill-tools` submodule is pinned behind the (never-pushed) engine version the
bundle was built from, so the build fails and the worker can't be maintained.

## Decision (approved 2026-08-21)
Vendor `uma-skill-tools` into uma-tools as a plain directory at upstream `origin/master`
(51 commits ahead of the pin, fast-forward), then port the unpushed delta into that TS.
Imports stay `../uma-skill-tools/...`; sibling apps unaffected.

## Known unpushed delta (probed from the minified bundle)
- ActivationConditions: `activate_count_later_half`, `fan_count`, `furlong`, `is_abroad`,
  `is_activate_heal_skill`, `is_other_character_activate_advantage_skill`,
  `is_popularity_top_character_activate_advantage_skill`, `near_infront_count`,
  `order_rate_in50_continue`, `phase_latter_half_straight_random`
- RaceSolverBuilder: `otherHorse()`, `withItidoriarasoi()`, `addSkill(id, persp, level, policy)`,
  `levelScalingCoef` export
- RaceSolver: 位置取り争い (`isItidoriarasoi`) mechanics
- Plus anything a systematic module-by-module diff of the un-minified bundle vs master TS surfaces.

## Verification: bit-identity
`cli.mjs` already runs the shipped bundle headlessly with fixed seeds. Add `--worker <path>`,
build the worker from TS, and A/B shipped vs rebuilt across compare/chart/hpcalc on multiple
courses/umas/seeds requiring identical output. Same seed → same RNG stream → same numbers is
the parity bar. Shipped artifacts (`bundle.js`, `simulator.worker.js`) are not replaced by this
work; deliverable is buildable TS + the parity proof.

## Steps
1. Vendor submodule → directory at origin/master.
2. Un-minify shipped worker; diff each engine module against master TS; record delta here.
3. Port delta into vendored TS.
4. `cli.mjs --worker` A/B until bit-identical; run uma-skill-tools' own test suite as sanity.
