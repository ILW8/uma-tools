# Rebuild simulator.worker.js from TypeScript (feature parity)

## Problem
`umalator-global/simulator.worker.js` was a committed esbuild bundle whose engine
(`uma-skill-tools`) was pinned behind the never-pushed version the bundle was built from,
so the worker could not be rebuilt from source.

## Decision (approved 2026-08-21)
Vendor `uma-skill-tools` into uma-tools as a plain directory at upstream `origin/master`
(8b3f5e2, 51 commits ahead of the old pin, fast-forward), then port the unpushed delta into
that TS. Imports stay `../uma-skill-tools/...`; sibling apps unaffected.

## Ported delta (origin/master → shipped bundle), verified complete
- **ConditionParser**: tokenizer accepts negative integer literals.
- **ActivationConditions**: new — `activate_count_later_half`, `fan_count`, `furlong`,
  `is_abroad`, `is_activate_heal_skill`, `is_other_character_activate_advantage_skill`,
  `is_popularity_top_character_activate_advantage_skill`, `near_infront_count`,
  `order_rate_in50_continue`, `phase_laterhalf`, `phase_latter_half_straight_random`.
  Changed — `activate_count_middle` gains filterEq; `corner` filterNeq supports corner≠N;
  `motivation`/`popularity` read from the horse; `running_style_count_*_otherself` read
  `extra.otherHorse.strategy`; `is_hp_empty_onetime` uses `hp.remainingHp() <= 0`.
- **RaceSolver**: per-skill rngs (`skillRngs`, djb2-xor of skillId over one main-rng pair())
  replace `gorosiRng`; effect-target filtering moved to runtime (`SkillEffect.target`);
  `getScaledDuration`/`getScaledModifier` (durationScaling/modifierScaling switch, incl. the
  9999 → scalingFunc sentinel); itidoriarasoi pseudo-skill state (`isItidoriarasoi`, forced
  removal at 8 sections); counters `activateCountThisFrame/HealThisFrame/HealLastFrame/
  TagGroup6/LaterHalf` + `usedSkills` gated on `tags.length > 0`; `pendingRemoval` keyed by
  skillId+perspective; `doActivateRandomGold` filters by perspective, sorts candidates by
  skillId, draws from the activating skill's rng; PowerUp also bumps `rawPower`; Recovery
  count gated on modifier > 0; downhill target-speed bonus sign fixed (`-slopePer/1e5`).
- **HpPolicy**: `hasRemainingHp()` → `remainingHp(): number`; `competeTopModifier`
  ([3.5,7.7] Oonige else [1.4,3.6]) applied while itidoriarasoi (kakari 1.6 only outside it).
- **RaceSolverBuilder**: `buildBaseStats(desc)` 1-arg (mood/popularity/rawPower on the horse);
  `levelScalingCoef` + skill-level scaling in `buildSkillEffects`; `buildSkillData(self, other,
  ...)` evaluates debuff conditions against the debuffed horse and passes `extra.otherHorse`;
  triggers carry `tags`; `otherHorse()`; `withItidoriarasoi()` (Nige/Oonige-only guts-based
  pseudo-skill); `withAsiwotameru()`/`withStaminaSyoubu()` rewritten as runtime-gated
  modifierScalingFunc skills on rawPower/rawStamina; `addSkill(id, perspective, level, policy)`;
  build() draws one rng pair per unique skillId for trigger sampling.
- App layer (`umalator/compare.ts`, `hpcalc.ts`, `simulator.worker.ts`,
  `components/HorseDefTypes.ts`) matched the bundle exactly — no changes.

## Verification
`scratchpad ab.mjs` fed identical messages to the shipped bundle and a fresh build
(esbuild flags replicated from build.mjs) in two vm contexts and required every postMessage
payload byte-identical: 4 compare cases (3 courses, Nige/Oonige/Senkou/Sasi, wisdom checks
on/off, uniqueLv 4/3/2), chart with 25 candidates, hpcalc with 3 debuffs — ~96MB of
serialized results, **all bit-identical**. `cli.mjs` gained a `UMALATOR_WORKER` env override
(propagates to chart worker threads) and reproduces identical numbers end-to-end. Both site
builds (`umalator-global`, `umalator`) compile; shipped artifacts left untouched.

## Known non-goals
`uma-skill-tools/tools/` and `test/` still target the old builder API (author's own harness;
the matching unpushed update was never published). The A/B bit-identity harness is the
regression suite for the port.
