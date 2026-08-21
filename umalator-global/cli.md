# cli.mjs

Headless umalator-global. It loads the committed `simulator.worker.js` — the exact bundle the website
ships — into a `vm` context with `self`/`postMessage` shimmed, so there is no build step and no browser.
No dependencies; run on Node 22 (it wants `DecompressionStream` and `os.availableParallelism`).

`UMALATOR_WORKER=<path>` runs a fresh build of `umalator/simulator.worker.ts` (see `build-worker.mjs`)
instead. Same numbers, but ~1.7x faster in chart mode: it reuses the baseline uma's races across
candidates, which the committed bundle predates.

```
node cli.mjs <share url | #hash | state.json> [--chart] [--nsamples N] [--top N] [--skills F] [--json]
node cli.mjs --skills F --course ID --chart [--strategy S] [--race C,C] [--top N] [--json]
node cli.mjs --selfcheck
```

## Two modes

**compare** (default) runs uma1 vs uma2 out of the state, the site's 真っ向勝負 tab:

```
$ node cli.mjs "https://alpha123.github.io/uma-tools/umalator-global/#H4sIA..." --nsamples 2000
course 10606 (2400m) · seed 2615953739 · 2000 samples
bashin (uma2 - uma1)  min 0.00  max 2.70  mean 1.28  median 1.26
uma2 ahead 100.0%  ·  spurt rate 100.0% / 100.0%
```

Positive bashin means uma2 finished ahead. Spurt rate is the share of races where each uma got a full
last spurt.

**--chart** ranks candidate skills for uma1 — the site's skill effect value table. Each row is that
skill's gain in bashin over the same uma without it, across the same seeded races. It fans out over one
worker thread per core bar one, and it's the expensive mode — a full table is minutes, not seconds.

```
$ node cli.mjs --skills .../skill_tree.json --course 10810 --race firm,sunny,summer --chart --top 5
Nige 1214/1186/915/972/674 (AAA), unique lv5, 2 skills already learned · firm/sunny/summer/midday/g1
Mayano Top Gun [Scramble☆Zone] · course 10810 (3000m) · seed 2615953739 · 44/44 skills ranked
   mean  median     min     max    SP      L/SP  skill
   7.29    7.08    0.00   28.21   153  0.047635  Breath of Fresh Air
   ...
```

`L/SP` is mean bashin per SP — the buy-order number. `mean` alone is what to look at when SP isn't the
constraint.

## Where the state comes from

Either a share link (paste the whole URL, or just the `#...` hash) / a `state.json` in the same shape,
**or** UmaExtractor's `skill_tree.json` via `--skills` + `--course`, which skips the site entirely.

`--skills` does two things independently of where the uma came from: it restricts the chart to the
skills that file says are **buyable right now**, and it prices them with that file's `discountedCost`
(hints and the tree's own discount already applied) instead of the state's `hintLevels`.

## Flags

| flag | |
|---|---|
| `--chart` | rank skills for uma1 instead of comparing two umas |
| `--top N` | chart rows to print, best mean first (default 40, `0` for all) |
| `--nsamples N` | compare only; the chart picks its own (see below) |
| `--skills F` | UmaExtractor's `skill_tree.json` |
| `--course ID[,ID..]` | build the uma from `F` instead of a share link; needs `--chart` and an `uma` block in `F` |
| `--strategy S` | `Nige` \| `Senkou` \| `Sasi` \| `Oikomi` \| `Oonige`, defaults to the card's own |
| `--race C,C` | conditions by name, anything omitted keeps the default |
| `--json` | raw numbers instead of a table |
| `--dumpstate` | print the built state as JSON and exit, instead of simulating |
| `--selfcheck` | run the assertions and exit |

`--dumpstate` is how you get a two-uma state out of `--skills`: dump twice with different `--strategy`
(or different trees), then feed `{...a, uma2: b.uma1}` back in as a `state.json` to compare them.

Chart several courses in one run by passing them all to `--course` — one table each, or with `--json`
one flat array with a `courseId` on every row. Prefer this over a run per course: the pool is fed
(course, skill) pairs, so it stays full instead of draining in each course's tail, and the workers spin
up and compile the bundle once. Measured over 12 courses it is a bit over 2x.

Pairs are handed to threads one at a time as they finish, not dealt out up front. Their costs span ~10x
(see the escalation note below), so a static split leaves the pool waiting on whichever thread drew the
slow ones — measured at 20% of a round.

`--race` vocabulary: `firm good soft heavy` / `sunny cloudy rainy snowy` /
`spring summer autumn winter sakura` / `morning midday evening night` / `g1 g2 g3 op`.
Default is `firm,sunny,spring,midday,g1`.

Course ids:

```
node -e "const c=require('./course_data.json'),t=require('./tracknames.json');for(const[k,v]of Object.entries(c))if(v.raceTrackId==10008)console.log(k,t[v.raceTrackId][1],v.distance+'m',v.surface==1?'turf':'dirt')"
```

## Things to know

**Ground names are the global client's.** `firm` is JA 良 and `good` is 稍重 — not the other way round.

**The extractor's `Max*` stats are that career's caps, not the uma.** `Speed`/`Stamina`/`Power`/`Guts`/
`Wiz` are what the uma actually has, and those are what get used.

**Three things aren't in the game data**, so they're assumed and echoed on the line above the table:
the race conditions (`--race`), the running style (`--strategy`, defaults to the card's own), and
popularity (always 1).

**Not every skill can be charted.** Uniques, purple skills and rarity≥3 skills that aren't universally
accessible are never candidates, matching the site. A few more are dropped mid-run — the site filters
them with `getActivateableSkills()`, which lives in a component the worker bundle doesn't export, so
here they throw and get skipped instead. `44/44 skills ranked` in the header is ranked out of attempted;
when those two differ, the missing ones were never going to produce a number.

**A skill group only gets one slot.** Learning both tiers (See Ya Later! and Playtime's Over!) shows as
the better one, and neither tier is offered as a candidate afterwards.

**`0.00` means "never mattered", not "no data".** The chart escalates: 17 races for everything, 30 more
for skills that ever gained anything, 50 more for skills whose gain varied, then 100. A skill that does
nothing in the first 17 stops there. `--json` reports the actual count per row as `nsamples`.

**Same seed, same numbers.** Everything is seeded off the state's `seed` (default 2615953739, same as
the site). Two runs of the same command are identical; to sample differently, change `seed` in a
`state.json`. The chart also forces `useIntChecks` off, as the site does.

**The data files here must match the bundle.** `skill_data.json`, `skill_meta.json`, `skillnames.json`,
`course_data.json` and `umas.json` are read from this directory, and `simulator.worker.js` is built
from the TS sources. `update.bat` regenerates all of it from `master.mdb`; don't refresh one half alone.

**`--json` shapes.** Chart: an array of `{id, min, max, mean, median, nsamples, spcost, bashinPerSp}`
plus `courseId`, sorted by mean and then by id and course, so the order doesn't depend on the threads.
Compare: `{results, nspurt}`, where `results` is the sorted per-race bashin.

**`--selfcheck` covers only the bookkeeping this file adds** — SP costs, which skills are candidates,
and the extractor→HorseState mapping. Everything else is the shipped bundle's, unchanged.
