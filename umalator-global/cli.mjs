#!/usr/bin/env node
// Headless driver for umalator-global.
//
// Runs the committed simulator.worker.js (the exact bundle the website ships) inside a vm context with
// `self`/`postMessage` shimmed, so no build step and no browser are involved.
//
// usage: node cli.mjs <share url | #hash | state.json> [--chart] [--nsamples N] [--top N] [--skills F] [--json]
//        node cli.mjs --skills F --course ID --chart [--strategy S] [--top N] [--json]
//
//   default        compare uma1 vs uma2 (the "真っ向勝負" tab)
//   --chart        rank every candidate skill for uma1 (the "skill effect value" table), one thread per core
//   --top N        chart rows to print, best mean first (default 40, 0 for all)
//   --skills F     chart only the skills buyable in F (UmaExtractor's skill_tree.json), priced with its costs
//   --course ID    chart the uma in F instead of one from a share link (F must have the `uma` block)
//   --strategy S   Nige/Senkou/Sasi/Oikomi/Oonige, defaults to the card's own
//   --race C,C,..  race conditions by name (firm sunny summer midday g1 ...), unnamed ones keep the default
//   --json         dump the raw numbers instead of a table
//
// `node cli.mjs --selfcheck` runs the assertions on the skill list/cost bookkeeping copied out of the tsx.
// cli.md has the longer version: what the flags do, what's assumed, and what the numbers mean.
//
// ponytail: drives the prebuilt worker rather than the TS sources, because umalator/compare.ts currently
// needs RaceSolverBuilder methods (otherHorse, withItidoriarasoi, 4-arg addSkill) that don't exist in the
// pinned uma-skill-tools submodule. Switch to bundling the sources once the submodule catches up.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';

const dir = path.dirname(fileURLToPath(import.meta.url));
const readJson = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const skillmeta = readJson('skill_meta.json');
const skilldata = readJson('skill_data.json');
const skillnames = readJson('skillnames.json');
const courses = readJson('course_data.json');
const umas = readJson('umas.json');

const DEFAULT_SEED = 2615953739;  // keep in sync with umalator/app.tsx

function makeWorker() {
	let onmessage, last;
	const ctx = vm.createContext({
		self: {addEventListener: (_, fn) => { onmessage = fn; }},
		postMessage: m => { last = m; },
		console
	});
	vm.runInContext(fs.readFileSync(path.join(dir, 'simulator.worker.js'), 'utf8'), ctx, {filename: 'simulator.worker.js'});
	// the handlers are synchronous and post progress updates as they go; only the last one is complete
	return message => { last = undefined; onmessage({data: message}); return last; };
}

// --- chart (skill table) ------------------------------------------------------------------------

// one skill per 'chart' message instead of the whole slice at once: the rounds inside doChart() are
// per-skill anyway, so this costs nothing and keeps a skill that throws from taking the slice with it.
function chartSlice({data, skills}) {
	const post = makeWorker();
	const rows = [];
	for (const id of skills) {
		try {
			const r = post({msg: 'chart', data: {...data, skills: [id]}}).results.get(id);
			rows.push({id, min: r.min, max: r.max, mean: r.mean, median: r.median, nsamples: r.results.length});
		} catch (_) {
			// ponytail: stand-in for getActivateableSkills(), which lives in BasinnChart.tsx and isn't reachable
			// from the worker bundle. Skills it would reject blow up in buildSkillData instead; drop them.
		}
		parentPort.postMessage({tick: 1});
	}
	parentPort.postMessage({rows});
}

async function runChart(data, skills) {
	const jobs = Math.max(1, Math.min(os.availableParallelism() - 1, skills.length));
	// dealt round-robin, not in contiguous blocks: neighbouring ids are variants of the same skill and cost
	// about the same to simulate, so blocks come out badly unbalanced
	const slices = Array.from({length: jobs}, (_, j) => skills.filter((_, i) => i % jobs == j));
	process.stderr.write(`ranking ${skills.length} skills across ${jobs} threads\n`);
	let done = 0;
	const rows = await Promise.all(slices.map(slice => new Promise((resolve, reject) => {
		const w = new Worker(fileURLToPath(import.meta.url), {workerData: {chart: {data, skills: slice}}});
		w.on('message', m => {
			if (m.rows) resolve(m.rows);
			else if (process.stderr.isTTY) process.stderr.write(`\r${++done}/${skills.length}`);
		});
		w.on('error', reject);
	})));
	if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
	return rows.flat();
}

// skill lists, from app.tsx / SkillList.tsx / HorseDef.tsx
const NOT_REAL_UNIQUES = ['1400011', '1400021'];
const allSkills = Object.keys(skilldata).filter(id => NOT_REAL_UNIQUES.indexOf(id) == -1);
const isPurpleSkill = id => skillmeta[id].iconId.slice(-1) == '4';
const universallyAccessiblePinks = Object.keys(skilldata).filter(id => id[0] == '4' || id[0] == '9' && id.length > 6);
const isGeneralSkill = id => skilldata[id].rarity < 3 || universallyAccessiblePinks.indexOf(id) > -1;
const baseSkillsToTest = allSkills.filter(id => !isPurpleSkill(id) && isGeneralSkill(id));

const skillGroups = Object.keys(skilldata).sort((a,b) =>
	isPurpleSkill(a) - isPurpleSkill(b) || skilldata[a].rarity - skilldata[b].rarity || +b - +a
).reduce((groups, id) => {
	const groupId = skillmeta[id].groupId;
	if (groups.has(groupId)) groups.get(groupId).push(id);
	else groups.set(groupId, [id]);
	return groups;
}, new Map());

function chartSkills(o, uma) {
	switch (o.chartMode) {
	case 'selected': return o.chartSkills || [];
	case 'inherit': return baseSkillsToTest.filter(id => id[0] == '9');
	default: return baseSkillsToTest.filter(id => {
		const existing = uma.skills.get(skillmeta[id].groupId);
		const group = skillGroups.get(skillmeta[id].groupId);
		const owned = Array.from(uma.skills.values());
		return !(
			existing == id || group.indexOf(id) < group.indexOf(existing)
			|| id[0] == '9' && owned.includes('1' + id.slice(1))
			|| id[0] == '9' && id.length > 6 && owned.includes(id.slice(2))
		);
	});
	}
}

// costForId()/scaleBaseCost() from components/SkillList.tsx
function costForId(id, hints, owned) {
	const group = skillGroups.get(skillmeta[id].groupId);
	const existing = owned.get(skillmeta[id].groupId);
	let cost = 0;
	for (let i = 0; i < group.length; ++i) {
		if (group[i] != existing) {
			const hint = hints[group[i]] || 0;
			cost += Math.floor(skillmeta[group[i]].baseCost * (1 - (hint <= 3 ? 0.1 * hint : 0.3 + 0.05 * (hint - 3))));
		}
		if (group[i] == id) break;
	}
	return cost;
}

// UmaExtractor's skill_tree.json: what this account can actually buy right now, at the price it's charged
// (discountedCost already has the hints and the tree's own discount baked in, so costForId() isn't used).
// ids are numbers there and strings everywhere here.
const availableSkills = tree => new Map(tree.buyable_skills.map(s => [String(s.skillId), s.discountedCost]));

// --- state --------------------------------------------------------------------------------------

async function loadState(input) {
	if (input.endsWith('.json')) return JSON.parse(fs.readFileSync(input, 'utf8'));
	// share links are gzip -> base64 -> urlencoded, after the '#' (see serialize() in umalator/app.tsx)
	const gz = Uint8Array.from(atob(decodeURIComponent(input.slice(input.indexOf('#') + 1))), c => c.charCodeAt(0));
	const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
	return JSON.parse(await new Response(stream).text());
}

// SkillSet() from components/HorseDefTypes.ts: debuffs (iconId 3xxxx) get unique keys so they stack
function skillSet(ids) {
	let ndebuff = 0;
	return new Map(ids.map(id => [
		skillmeta[id].iconId[0] == '3' ? skillmeta[id].groupId + '-' + ndebuff++ : skillmeta[id].groupId,
		id
	]));
}

// The same file also dumps the career uma. Speed/Stamina/... are its current stats; the Max* fields are
// that career's stat caps, not the uma, so they're ignored. Building the state here means a chart can run
// straight off the game data instead of round-tripping through the site to make a share link.
const APTITUDES = ['ProperDistanceShort', 'ProperDistanceMile', 'ProperDistanceMiddle', 'ProperDistanceLong',
	'ProperRunningStyleNige', 'ProperRunningStyleSenko', 'ProperRunningStyleSashi', 'ProperRunningStyleOikomi',
	'ProperGroundTurf', 'ProperGroundDirt'];
const STRATEGIES = ['', 'Nige', 'Senkou', 'Sasi', 'Oikomi'];  // as indexed by umas.json, per HorseDef.tsx
// the race itself isn't in the game data anywhere, so --race takes the conditions by name and everything
// left out keeps the site's default. Ground is named the way the global client names it (ja 良/稍重 are
// firm/good there, not good/yielding).
const DEFAULT_RACEDEF = {ground: 1, weather: 1, season: 1, time: 2, grade: 100};
const RACE_CONDITIONS = {
	firm: ['ground', 1], good: ['ground', 2], soft: ['ground', 3], heavy: ['ground', 4],
	sunny: ['weather', 1], cloudy: ['weather', 2], rainy: ['weather', 3], snowy: ['weather', 4],
	spring: ['season', 1], summer: ['season', 2], autumn: ['season', 3], winter: ['season', 4], sakura: ['season', 5],
	morning: ['time', 1], midday: ['time', 2], evening: ['time', 3], night: ['time', 4],
	g1: ['grade', 100], g2: ['grade', 200], g3: ['grade', 300], op: ['grade', 400]
};
function racedefFor(names) {
	return (names || '').split(',').filter(x => x).reduce((def, name) => {
		if (!(name.toLowerCase() in RACE_CONDITIONS)) {
			console.error(`--race: no such condition '${name}' (${Object.keys(RACE_CONDITIONS).join(' ')})`);
			process.exit(1);
		}
		const [field, value] = RACE_CONDITIONS[name.toLowerCase()];
		return {...def, [field]: value};
	}, DEFAULT_RACEDEF);
}
// uniqueSkillForUma() from components/HorseDefTypes.ts
const uniqueSkillFor = (outfitId, starCount) =>
	(10000 * (1 + 9 * +(starCount > 2)) + 10000 * (+outfitId.slice(-2) - 1) + +outfitId.slice(1,-2) * 10 + 1).toString();

function stateFromTree(tree, courseId, strategy, racedef) {
	const {stats, aptitudes} = tree.uma;
	const course = courses[courseId];
	const outfitId = String(stats.CardId);
	// a group only gets one slot in SkillSet(), so learned tiers go in worst-first and the best one wins it
	const owned = tree.acquired_skills.map(s => String(s.skillId)).filter(id => id in skilldata)
		.sort((a, b) => skillGroups.get(skillmeta[a].groupId).indexOf(a) - skillGroups.get(skillmeta[b].groupId).indexOf(b));
	// 1-2★ uniques have a different id than 3★+ ones; go by whichever the uma actually owns
	const starCount = owned.includes(uniqueSkillFor(outfitId, 1)) ? 1 : 3;
	const unique = tree.acquired_skills.find(s => String(s.skillId) == uniqueSkillFor(outfitId, starCount));
	const outfit = umas[stats.CharaId].outfits[outfitId];
	strategy = strategy || STRATEGIES[outfit.strategy];
	const apt = i => aptitudes[APTITUDES[i]].grade;
	return {
		name: `${umas[stats.CharaId].name[1]} ${outfit.epithet}`,
		courseId, seed: DEFAULT_SEED, usePosKeep: true, useCompeteTop: true, useIntChecks: false,
		racedef,
		uma1: {
			outfitId, starCount, strategy,
			speed: stats.Speed, stamina: stats.Stamina, power: stats.Power, guts: stats.Guts, wisdom: stats.Wiz,
			// the ten grades the game reports collapse to the three the sim wants (HorseDef.tsx)
			distanceAptitude: apt(course.distanceType - 1),
			surfaceAptitude: apt(7 + course.surface),
			strategyAptitude: apt(4 + STRATEGIES.indexOf(strategy.replace('Oonige', 'Nige')) - 1),
			skills: owned,
			uniqueLv: unique ? unique.currentLevel : 1,
			mood: stats.Motivation - 3,  // 1..5 in game, -2..2 here
			popularity: 1
		}
	};
}

function deserializeUma(o) {
	return {
		mood: 2, popularity: 1, starCount: 3, uniqueLv: 1, ...o,
		skills: skillSet(o.skills),
		samplePolicies: new Map(Object.entries(o.samplePolicies || {}))
	};
}

// racedefToParams() in umalator/app.tsx. chart mode passes the order range for uma1's strategy, compare doesn't.
const ORDER_RANGE_FOR_STRATEGY = {Nige: [1,1], Senkou: [2,4], Sasi: [5,9], Oikomi: [5,9], Oonige: [1,1]};
function racedefToParams(racedef, strategy) {
	return {
		groundCondition: racedef.ground, weather: racedef.weather, season: racedef.season,
		time: racedef.time, grade: racedef.grade,
		skillId: '', orderRange: strategy != null ? ORDER_RANGE_FOR_STRATEGY[strategy] : null, numUmas: 9
	};
}

// --- main ---------------------------------------------------------------------------------------

if (!isMainThread) {
	chartSlice(workerData.chart);
} else {

const argv = process.argv.slice(2);

// the only logic here that isn't the shipped bundle's is the skill list/cost bookkeeping copied out of the
// tsx, so that's what this checks. Left-Handed ○ (200022, 90 sp) is a prerequisite for ◎ (200021, 110 sp).
if (argv.includes('--selfcheck')) {
	const eq = function (actual, expected, what) {
		if (actual === expected) return true;
		console.error(`FAIL ${what}: got ${actual}, want ${expected}`);
		return false;
	};
	const inGroup20002 = state => chartSkills({chartMode: 'all'}, state).filter(id => skillmeta[id].groupId == '20002').length;
	const ok = [
		eq(costForId('200021', {}, new Map()), 200, 'unowned ◎ costs both tiers'),
		eq(costForId('200021', {}, new Map([['20002','200022']])), 110, 'owning ○ leaves only ◎'),
		eq(costForId('200022', {'200022': 3}, new Map()), 62, 'hint 3 is a 30% discount (90*0.7 floors to 62, as in game)'),
		eq(inGroup20002({skills: new Map()}), 2, 'both tiers are candidates when neither is owned'),
		eq(inGroup20002({skills: new Map([['20002','200021']])}), 0, 'owning ◎ hides it and the ○ below it'),
		eq(chartSkills({chartMode: 'all'}, {skills: new Map()})
			.filter(id => availableSkills({buyable_skills: [{skillId: 200022, discountedCost: 62}]}).has(id))
			.join(), '200022', 'numeric skillIds from the tree match the string ids used here'),
		// Mayano Top Gun [Scramble☆Zone] (CardId 102401, unique 100241) on Tokyo turf 2400m, which is a
		// medium-distance course, so the aptitudes the sim gets are #2 (medium), #8 (turf) and #6 (sasi).
		...(uma1 => [
			eq(skillSet(uma1.skills).get('20166'), '201662', 'the better of two learned tiers wins the group slot'),
			eq(uma1.starCount, 3, 'owning the 3★ form of the unique means the uma is 3★+'),
			eq(uma1.uniqueLv, 5, 'unique level comes from the acquired skill'),
			eq(uma1.mood, 2, 'motivation 5 is mood +2'),
			eq(uma1.distanceAptitude, 'B', 'medium distance is aptitude #2'),
			eq(uma1.surfaceAptitude, 'S', 'turf is aptitude #8'),
			eq(uma1.strategyAptitude, 'F', 'sasi is aptitude #6')
		])(stateFromTree({
			acquired_skills: [{skillId: 100241, currentLevel: 5}, {skillId: 201662}, {skillId: 201661}],
			uma: {
				stats: {CharaId: 1024, CardId: 102401, Speed: 1214, Stamina: 1186, Power: 915, Guts: 972, Wiz: 674, Motivation: 5},
				aptitudes: Object.fromEntries(APTITUDES.map((n, i) => [n, {grade: 'SABCDEFGSA'[i]}]))
			}
		}, 10606, 'Sasi', racedefFor('summer,heavy')).uma1)
	].every(x => x);
	console.log(ok ? 'ok' : 'FAILED');
	process.exit(+!ok);
}

const VALUE_FLAGS = ['--nsamples', '--top', '--skills', '--course', '--strategy', '--race'];
let input = null;
for (let i = 0; i < argv.length && input == null; ++i) {
	if (VALUE_FLAGS.includes(argv[i])) ++i;  // skip the value
	else if (!argv[i].startsWith('-')) input = argv[i];
}
const arg = name => argv.indexOf(name) > -1 ? argv[argv.indexOf(name) + 1] : null;
const flag = (name, default_) => arg(name) != null ? parseInt(arg(name), 10) : default_;
const tree = arg('--skills') && JSON.parse(fs.readFileSync(arg('--skills'), 'utf8'));
const available = tree ? availableSkills(tree) : null;

if (input == null && !(tree && tree.uma && arg('--course') && argv.includes('--chart'))) {
	console.error('usage: node cli.mjs <share url | #hash | state.json> [--chart] [--nsamples N] [--top N] [--skills F] [--json]');
	console.error('       node cli.mjs --skills F --course ID --chart [--strategy S] [--race C,C] [--top N] [--json]');
	process.exit(1);
}

const o = input != null ? await loadState(input)
	: stateFromTree(tree, flag('--course'), arg('--strategy'), racedefFor(arg('--race')));
const course = courses[o.courseId];
course.slopes.sort((a, b) => a.start - b.start);  // CourseHelpers.getCourse()
const uma1 = deserializeUma(o.uma1);
const options = {
	seed: o.seed || DEFAULT_SEED,
	usePosKeep: o.usePosKeep,
	useCompeteTop: o.useCompeteTop ?? true,
	useIntChecks: o.useIntChecks || false
};
const header = `${o.name ? o.name + ' · ' : ''}course ${o.courseId} (${course.distance}m) · seed ${options.seed}`;
if (input == null) process.stderr.write(
	`${uma1.strategy} ${uma1.speed}/${uma1.stamina}/${uma1.power}/${uma1.guts}/${uma1.wisdom}` +
	` (${uma1.distanceAptitude}${uma1.surfaceAptitude}${uma1.strategyAptitude}), unique lv${uma1.uniqueLv},` +
	` ${uma1.skills.size} skills already learned · ` +
	Object.entries(o.racedef).map(([field, v]) =>
		Object.keys(RACE_CONDITIONS).find(name => RACE_CONDITIONS[name][0] == field && RACE_CONDITIONS[name][1] == v)
	).join('/') + '\n');

if (argv.includes('--chart')) {
	let skills = chartSkills({chartMode: 'all', ...o}, uma1);
	if (available) skills = skills.filter(id => available.has(id));
	const rows = await runChart({
		course,
		racedef: racedefToParams(o.racedef, uma1.strategy),
		uma: uma1,
		options: {...options, useIntChecks: false}  // app.tsx forces this off for the chart
	}, skills);
	rows.forEach(r => {
		r.spcost = available ? available.get(r.id) : costForId(r.id, o.hintLevels || {}, uma1.skills);
		r.bashinPerSp = r.mean / r.spcost;
	});
	rows.sort((a, b) => b.mean - a.mean);
	if (argv.includes('--json')) {
		console.log(JSON.stringify(rows));
	} else {
		const top = flag('--top', 40);
		console.log(`${header} · ${rows.length}/${skills.length} skills ranked`);
		console.log(['mean'.padStart(7), 'median'.padStart(8), 'min'.padStart(8), 'max'.padStart(8),
			'SP'.padStart(6), 'L/SP'.padStart(10), '  skill'].join(''));
		rows.slice(0, top > 0 ? top : rows.length).forEach(r => console.log([
			r.mean.toFixed(2).padStart(7), r.median.toFixed(2).padStart(8),
			r.min.toFixed(2).padStart(8), r.max.toFixed(2).padStart(8),
			String(r.spcost).padStart(6),
			(Number.isFinite(r.bashinPerSp) ? r.bashinPerSp.toFixed(6) : '--').padStart(10),
			'  ' + skillnames[r.id][0]
		].join('')));
	}
} else {
	const {results, runData} = makeWorker()({
		msg: 'compare',
		data: {
			nsamples: flag('--nsamples', o.nsamples),
			course,
			racedef: racedefToParams(o.racedef),
			uma1,
			uma2: deserializeUma(o.uma2),
			options
		}
	}).results;

	if (argv.includes('--json')) {
		console.log(JSON.stringify({results, nspurt: runData.nspurt}));
	} else {
		const mid = Math.floor(results.length / 2);
		const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
		const mean = results.reduce((a, b) => a + b, 0) / results.length;
		console.log(`${header} · ${results.length} samples`);
		console.log(`bashin (uma2 - uma1)  min ${results[0].toFixed(2)}  max ${results[results.length-1].toFixed(2)}  mean ${mean.toFixed(2)}  median ${median.toFixed(2)}`);
		console.log(`uma2 ahead ${(results.filter(x => x > 0).length / results.length * 100).toFixed(1)}%  ·  spurt rate ${(runData.nspurt[0] / results.length * 100).toFixed(1)}% / ${(runData.nspurt[1] / results.length * 100).toFixed(1)}%`);
	}
}

}
