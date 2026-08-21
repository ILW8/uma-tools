#!/usr/bin/env node
// Pick a running style and a skill buy order for one uma in Team Trials, by driving
// umalator-global/cli.mjs over the course distribution of a Team Trials race type.
//
//   node optimize.mjs <skill_tree.json> <sprint|mile|medium|long|dirt> [options]
//   node optimize.mjs --selfcheck
//
// See SKILL.md. No dependencies; needs the same Node 22 cli.mjs wants.
import {execFile, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, mkdtempSync} from 'node:fs';
import {availableParallelism, tmpdir} from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COURSES = JSON.parse(readFileSync(path.join(HERE, 'courses.json'), 'utf8'));
const TYPES = ['sprint', 'mile', 'medium', 'long', 'dirt'];
const STRATEGIES = {Nige: 'ProperRunningStyleNige', Senkou: 'ProperRunningStyleSenko',
	Sasi: 'ProperRunningStyleSashi', Oikomi: 'ProperRunningStyleOikomi'};

const argv = process.argv.slice(2);
const arg = (n, d) => argv.indexOf(n) > -1 ? argv[argv.indexOf(n) + 1] : d;
const has = n => argv.includes(n);
const positional = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && argv[i-1].startsWith('--') && argv[i-1] != '--selfcheck'));

// --- locate umalator-global -------------------------------------------------
function findDir() {
	const explicit = arg('--dir');
	if (explicit) return explicit;
	for (const c of [process.cwd(), path.join(process.cwd(), 'umalator-global')])
		if (existsSync(path.join(c, 'cli.mjs'))) return c;
	throw new Error('cannot find umalator-global (no cli.mjs in cwd or ./umalator-global); pass --dir');
}
const DIR = findDir();
const RUNOPTS = {cwd: DIR, encoding: 'utf8', maxBuffer: 1 << 26};
const run = args => execFileSync('node', ['cli.mjs', ...args], {...RUNOPTS, stdio: ['ignore', 'pipe', 'ignore']});
const runP = args => promisify(execFile)('node', ['cli.mjs', ...args], RUNOPTS).then(r => r.stdout);

// cli.mjs only fans out over threads in --chart mode; a compare is one core for its whole run, so the
// courses are the only parallelism available to headToHead(). Ordered results, so output is unchanged.
async function pool(items, fn) {
	const out = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({length: Math.min(items.length, Math.max(1, availableParallelism() - 1))},
		async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i); }));
	return out;
}

// --- selfcheck: every course id resolves, and matches the label -------------
if (has('--selfcheck')) {
	const cd = JSON.parse(readFileSync(path.join(DIR, 'course_data.json'), 'utf8'));
	let bad = 0;
	for (const type of TYPES) {
		const list = COURSES[type];
		if (!list) { console.error(`missing race type ${type}`); bad++; continue; }
		const sum = list.reduce((a, [, w]) => a + w, 0);
		if (Math.abs(sum - 100) > 1.5) { console.error(`${type}: weights sum to ${sum.toFixed(1)}, expected ~100`); bad++; }
		for (const [id, , label] of list) {
			const c = cd[id];
			if (!c) { console.error(`${type}: course ${id} (${label}) not in course_data.json`); bad++; continue; }
			const dist = Number(label.match(/(\d+)/)[1]);
			if (c.distance != dist) { console.error(`${type}: course ${id} is ${c.distance}m, label says ${label}`); bad++; }
			const wantDirt = type == 'dirt';
			if ((c.surface != 1) != wantDirt) { console.error(`${type}: course ${id} (${label}) surface mismatch`); bad++; }
		}
	}
	// cli.mjs must still support the flags we drive it with
	for (const f of ['--dumpstate', '--chart', '--skills', '--json'])
		if (!readFileSync(path.join(DIR, 'cli.mjs'), 'utf8').includes(f)) { console.error(`cli.mjs has no ${f}`); bad++; }
	// prereq pricing reads groupId/order out of skill_meta.json
	const sm = JSON.parse(readFileSync(path.join(DIR, 'skill_meta.json'), 'utf8'));
	if (!Object.values(sm).every(v => v.groupId != null && v.order != null))
		{ console.error('skill_meta.json entries are missing groupId/order — prereqs cannot be priced'); bad++; }
	// the ◎/○ pair that proves the order-within-group rule still holds
	if (!(sm['200261']?.order < sm['200262']?.order && sm['200261'].groupId == sm['200262'].groupId))
		{ console.error('skill_meta.json: Outer Post Proficiency ◎/○ no longer order strongest-first in one group'); bad++; }
	console.log(bad ? `selfcheck FAILED (${bad})` : `selfcheck ok — ${TYPES.map(t => `${t}:${COURSES[t].length}`).join(' ')}`);
	process.exit(bad ? 1 : 0);
}

// --- inputs -----------------------------------------------------------------
const [treeFile, rawType] = positional;
if (!treeFile || !rawType) {
	console.error('usage: node optimize.mjs <skill_tree.json> <sprint|mile|medium|long|dirt> [--dir P]');
	console.error('       [--strategy S | --strategies A,B] [--race C,C] [--min-gain N] [--nsamples N] [--top N]');
	console.error('       node optimize.mjs --selfcheck [--dir P]');
	process.exit(1);
}
const type = rawType.toLowerCase();
if (!TYPES.includes(type)) { console.error(`race type must be one of ${TYPES.join('|')}`); process.exit(1); }

const DIST = arg('--dist');  // e.g. --dist 2000: only 2000m courses of the type
const courses = COURSES[type].filter(([,,l]) => !DIST || DIST.split(',').includes(l.match(/[0-9]+/)[0]));
if (!courses.length) { console.error(`--dist ${DIST}: no ${type} courses at that distance`); process.exit(1); }
const WSUM = courses.reduce((a, [, w]) => a + w, 0);
const RACE = arg('--race');
const MIN_GAIN = parseFloat(arg('--min-gain', '0.05'));
// one cli.mjs compare is single-threaded, so headToHead() is bounded by its slowest single course, and
// doCompare() climbs a ladder to get there, and 600 is the last rung — it costs 740 samples where 601
// costs 1341 and 1000 costs 1740. The screen only has to resolve a multi-bashin gap and the verify is
// checked against a +/-25% band, so precision is not the binding constraint. Measured on Nakayama 3600,
// the slowest long course:
//   2000  28.4s  SE 0.16 bashin      500  6.5s  SE 0.29
//   1000  17.2s  SE 0.22             200  3.2s  SE 0.47
const NSAMPLES = arg('--nsamples', '600');
const SCREEN_SAMPLES = arg('--screen-samples', '500');
// the screen builds this many skills per style before comparing. Screening unbuilt umas is wrong:
// buyable_skills are invisible to it, and a style-locked skill (Angling and Scheming needs order==1,
// so only a front runner can fire it) is worth multiple bashin to exactly one style. Measured on
// Mayano Top Gun: Angling is +3.04 bashin to Nige on Tokyo 2500, enough to reverse a 1.26 bashin
// deficit to Senkou. A margin threshold can't catch this — it also flipped an 8.28 bashin gap.
const SCREEN_ROUNDS = parseInt(arg('--screen-rounds', '4'), 10);
const TOP = parseInt(arg('--top', '6'), 10);

const baseTree = JSON.parse(readFileSync(treeFile, 'utf8'));
if (!baseTree.uma) { console.error(`${treeFile} has no "uma" block — need an UmaExtractor skill_tree.json`); process.exit(1); }
const names = JSON.parse(readFileSync(path.join(DIR, 'skillnames.json'), 'utf8'));
const nameOf = id => names[id]?.at(-1) ?? id;

// --- prerequisites ----------------------------------------------------------
// The game gates the upgraded skill in a group behind the ones below it: Concentration needs Focus,
// Unstoppable needs On the Attack, every ◎ needs its ○. cli.mjs charts and prices each skill alone, so
// without this a build reports hundreds of SP it does not actually have (measured: 538 SP of hidden
// prereqs on a 13-skill long build, i.e. 702 SP "left" that was really 164).
// skill_meta's `order` ranks a group strongest-first, so anything ordered after a skill in the same
// group is below it in the tree. Chains run up to 3 deep (Muddy ○ -> Muddy ◎ -> Maestro of the Mud).
// The × members sit last but are never in buyable_skills, so they drop out on their own.
const meta = JSON.parse(readFileSync(path.join(DIR, 'skill_meta.json'), 'utf8'));
const GROUP = new Map();
for (const [id, v] of Object.entries(meta)) {
	if (!GROUP.has(v.groupId)) GROUP.set(v.groupId, []);
	GROUP.get(v.groupId).push(id);
}
// still-unbought skills that must be purchased before `id`, cheapest tier first
function prereqs(id, buyable) {
	const v = meta[id];
	if (!v) return [];
	return GROUP.get(v.groupId)
		.filter(i => meta[i].order > v.order && buyable.has(i))
		.sort((a, b) => meta[b].order - meta[a].order)
		.map(i => ({id: i, name: nameOf(i), spcost: buyable.get(i).discountedCost}));
}

const scratch = mkdtempSync(path.join(tmpdir(), 'umalator-'));
const scratchFile = n => path.join(scratch, n);

// stamped on the phase headers so a slow run can be attributed to a phase without a profiler
const T0 = Date.now();
const at = () => `[${((Date.now() - T0) / 1000).toFixed(1)}s]`;

const raceArgs = RACE ? ['--race', RACE] : [];
const dump = async (tree, course, strat) => JSON.parse(
	await runP(['--skills', tree, '--course', String(course), '--chart', '--strategy', strat, '--dumpstate', ...raceArgs]));

// uma1 = (treeA, stratA) vs uma2 = (treeB, stratB); positive mean = B ahead
async function headToHead(treeA, stratA, treeB, stratB, nsamples = NSAMPLES) {
	const rows = await pool(courses, async ([course, w, label], i) => {
		const [a, b] = await Promise.all([dump(treeA, course, stratA), dump(treeB, course, stratB)]);
		const state = scratchFile(`cmp-${i}.json`);  // one per course; they run concurrently now
		writeFileSync(state, JSON.stringify({...a, uma2: b.uma1}));
		const {results, nspurt} = JSON.parse(await runP([state, '--nsamples', nsamples, '--json']));
		const mean = results.reduce((x, y) => x + y, 0) / results.length;
		return {label, w, mean, ahead: results.filter(x => x > 0).length / results.length * 100,
			// nspurt = samples where each uma got a full last spurt; a style that can't finish the
			// spurt loses bashin no skill buys back, so it explains most of the margin's spread
			spurt: nspurt.map(x => x / results.length * 100)};
	});
	return {
		wmean: rows.reduce((a, r) => a + r.mean * r.w / WSUM, 0),
		wahead: rows.reduce((a, r) => a + r.ahead * r.w / WSUM, 0),
		wspurt: [0, 1].map(i => rows.reduce((a, r) => a + r.spurt[i] * r.w / WSUM, 0)),
		rows
	};
}

// --- greedy machinery (shared by the screen and the buy order) --------------
// one chart over every course, weighted by frequency: id -> {wmean, spcost}.
// All courses go in one cli.mjs run: charting them one at a time left half the thread pool idle in each
// course's tail (44 candidates over 31 threads) and re-spun the workers 12-21 times per round.
const WEIGHT = new Map(courses.map(([course, w]) => [course, w]));
function chartRound(workTree, strategy) {
	const agg = new Map();
	for (const r of JSON.parse(run(['--skills', workTree, '--course', courses.map(([c]) => c).join(','),
			'--chart', '--strategy', strategy, '--json', '--top', '0', ...raceArgs]))) {
		const e = agg.get(r.id) || {wmean: 0, spcost: r.spcost};
		e.wmean += r.mean * WEIGHT.get(r.courseId) / WSUM;
		agg.set(r.id, e);
	}
	return agg;
}

const newBuild = name => ({
	tree: JSON.parse(JSON.stringify(baseTree)),
	file: scratchFile(`tree-${name}.json`),
	budget: baseTree.uma.stats.SkillPoint,
	bought: []
});

function printPick(pick, n) {
	console.log(`${String(n).padStart(2)}. ${pick.wmean.toFixed(3).padStart(7)} bashin  ${String(pick.total).padStart(4)} SP  ${pick.name}`);
	// the SP above is the whole chain, so name what the rest of it bought
	for (const d of pick.deps)
		console.log(`         ${(d.wmean ?? 0).toFixed(3).padStart(7)}  ${String(d.spcost).padStart(4)} SP  prereq       ${d.name}`);
	// runners-up matter: they show which skills are substitutes for the one just taken
	for (const r of pick.runnersUp)
		console.log(`         ${r.wmean.toFixed(3).padStart(7)}  ${String(r.total).padStart(4)} SP  ${r.perSp.toFixed(5)}/SP  ${r.name}${r.deps.length ? ` (+${r.deps.length} prereq)` : ''}`);
}

// buy up to maxRounds more skills into `b`; returns false once nothing clears MIN_GAIN or SP.
// always leaves b.file in sync with b.tree so headToHead() can use it.
function greedy(b, strategy, maxRounds, verbose) {
	let exhausted = false;
	for (let i = 0; i < maxRounds; i++) {
		writeFileSync(b.file, JSON.stringify(b.tree));
		const buyable = new Map(b.tree.buyable_skills.map(s => [String(s.skillId), s]));
		const agg = chartRound(b.file, strategy);
		// price and rank each candidate as the whole chain it forces you to buy. The chain's lower tiers
		// have effects of their own, but they're charted alone against the same baseline and are usually
		// partial substitutes for the top skill, so summing would oversell — rank on the top skill's gain
		// only. That undersells a chain, which self-corrects: once greedy buys a lower tier on its own
		// merits, the tier above it reprices to its own SP and jumps the ranking next round.
		const ranked = [...agg]
			.map(([id, e]) => {
				const deps = prereqs(id, buyable).map(d => ({...d, wmean: agg.get(d.id)?.wmean}));
				const total = e.spcost + deps.reduce((a, d) => a + d.spcost, 0);
				return {id, name: nameOf(id), ...e, deps, total, perSp: e.wmean / total};
			})
			.filter(r => r.total <= b.budget && r.wmean >= MIN_GAIN)
			.sort((x, y) => y.perSp - x.perSp);
		if (!ranked.length) { exhausted = true; break; }

		const pick = {...ranked[0], runnersUp: ranked.slice(1, TOP)};
		b.budget -= pick.total;
		b.bought.push(pick);
		const chain = [...pick.deps, pick];
		for (const s of chain) b.tree.acquired_skills.push({skillId: Number(s.id), name: s.name, currentLevel: 1});
		const gone = new Set(chain.map(s => s.id));
		b.tree.buyable_skills = b.tree.buyable_skills.filter(s => !gone.has(String(s.skillId)));
		if (verbose) printPick(pick, b.bought.length);
	}
	writeFileSync(b.file, JSON.stringify(b.tree));
	return !exhausted;
}

// --- phase 1: which running style? -----------------------------------------
const apt = s => baseTree.uma.aptitudes[STRATEGIES[s]]?.grade ?? '?';
let candidates;
if (arg('--strategy')) candidates = [arg('--strategy')];
else if (arg('--strategies')) candidates = arg('--strategies').split(',').map(s => s.trim());
else candidates = Object.keys(STRATEGIES).filter(s => 'SAB'.includes(apt(s)));
if (!candidates.length) candidates = Object.keys(STRATEGIES);

console.log(`${path.basename(treeFile)} · ${type} · ${courses.length} courses · ${RACE || 'default'} conditions`);
console.log(`aptitudes: ${Object.keys(STRATEGIES).map(s => `${s} ${apt(s)}`).join('  ')}`);

let strategy = candidates[0], screen = null;
const builds = new Map();
if (candidates.length > 1) {
	console.log(`\n${at()} === style screen (${SCREEN_ROUNDS}-skill partial builds, vs ${candidates[0]}) ===`);
	for (const s of candidates) {
		const b = newBuild(s);
		greedy(b, s, SCREEN_ROUNDS, false);
		builds.set(s, b);
		console.log(`  ${s.padEnd(8)} builds: ${b.bought.map(x => x.name).join(', ') || '(nothing clears --min-gain)'}`);
	}
	const ref = candidates[0];
	screen = [{name: ref, margin: 0}];
	for (const s of candidates.slice(1)) {
		const {wmean, wahead, wspurt} = await headToHead(builds.get(ref).file, ref, builds.get(s).file, s, SCREEN_SAMPLES);
		console.log(`  ${s.padEnd(8)} ${wmean >= 0 ? '+' : ''}${wmean.toFixed(2)} bashin vs ${ref}  (ahead ${wahead.toFixed(1)}%`
			+ ` of races)  spurt ${ref} ${wspurt[0].toFixed(0)}% / ${s} ${wspurt[1].toFixed(0)}%`);
		screen.push({name: s, margin: wmean});
	}
	screen.sort((a, b) => b.margin - a.margin);
	strategy = screen[0].name;
	const gap = screen[0].margin - screen[1].margin;
	console.log(`  => ${strategy}, by ${gap.toFixed(2)} bashin over ${screen[1].name}`);
	if (gap < 2) console.log(`  ! margin under 2 bashin — the rest of the build could still flip this; rerun with --strategy ${screen[1].name} to check`);
}

// --- phase 2: greedy purchases ---------------------------------------------
console.log(`\n${at()} === ${strategy} buy order ===`);
// the screen already bought the first SCREEN_ROUNDS for this style — carry them over rather than
// re-chart them, so screening the losers is the only extra cost
const build = builds.get(strategy) ?? newBuild(strategy);
build.bought.forEach((p, i) => printPick(p, i + 1));
greedy(build, strategy, Infinity, true);

const {budget, bought} = build;
const spent = baseTree.uma.stats.SkillPoint - budget;
const nskills = bought.reduce((a, p) => a + 1 + p.deps.length, 0);
console.log(`\n${nskills} skills (${bought.length} picks + ${nskills - bought.length} prereqs) · ${spent} SP spent · ${budget} left`);
if (budget > 150) console.log(`! ${budget} SP has nothing left worth >= ${MIN_GAIN} bashin — the hint list is the constraint, not SP`);

// --- phase 3: verify the whole build against the unbuilt uma ----------------
if (!bought.length) {
	console.log(`nothing cleared --min-gain ${MIN_GAIN}, so there is no build to verify.`);
	process.exit(0);
}
console.log(`\n${at()} === verify (built vs unbuilt, both ${strategy}) ===`);
const {wmean, wahead, rows} = await headToHead(treeFile, strategy, build.file, strategy);
for (const r of rows)
	console.log(`  ${r.label.padEnd(17)} ${r.w.toFixed(1).padStart(5)}%  ${r.mean.toFixed(2).padStart(7)} bashin  built ahead ${r.ahead.toFixed(1).padStart(5)}%`);
// prereqs are in the built uma too, so credit them at the gain they charted alone — an upper bound
// where they overlap the skill above them, which is why this is only checked against a +/-25% band
const predicted = bought.reduce((a, b) => a + b.wmean + b.deps.reduce((x, d) => x + (d.wmean ?? 0), 0), 0);
console.log(`\nmeasured ${wmean.toFixed(2)} bashin (predicted ${predicted.toFixed(2)} from the marginals), ahead in ${wahead.toFixed(1)}% of races`);
if (Math.abs(wmean - predicted) > Math.max(1, 0.25 * predicted))
	console.log('! measured and predicted disagree by >25% — the greedy path is probably not near-optimal here');

console.log(`${at()} done`);

const out = arg('--out');
if (out) { writeFileSync(out, JSON.stringify({type, strategy, screen, bought, spent, left: budget, measured: wmean}, null, 1)); console.log(`wrote ${out}`); }
