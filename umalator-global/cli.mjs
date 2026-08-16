#!/usr/bin/env node
// Headless driver for umalator-global.
//
// Runs the committed simulator.worker.js (the exact bundle the website ships) inside a vm context with
// `self`/`postMessage` shimmed, so no build step and no browser are involved.
//
// usage: node cli.mjs <share url | #hash | state.json> [--chart] [--nsamples N] [--top N] [--skills F] [--json]
//
//   default        compare uma1 vs uma2 (the "真っ向勝負" tab)
//   --chart        rank every candidate skill for uma1 (the "skill effect value" table), one thread per core
//   --top N        chart rows to print, best mean first (default 40, 0 for all)
//   --skills F     chart only the skills buyable in F (UmaExtractor's skill_tree.json), priced with its costs
//   --json         dump the raw numbers instead of a table
//
// `node cli.mjs --selfcheck` runs the assertions on the skill list/cost bookkeeping copied out of the tsx.
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
			.join(), '200022', 'numeric skillIds from the tree match the string ids used here')
	].every(x => x);
	console.log(ok ? 'ok' : 'FAILED');
	process.exit(+!ok);
}

let input = null;
for (let i = 0; i < argv.length && input == null; ++i) {
	if (argv[i] == '--nsamples' || argv[i] == '--top' || argv[i] == '--skills') ++i;  // skip the value
	else if (!argv[i].startsWith('-')) input = argv[i];
}
if (input == null) {
	console.error('usage: node cli.mjs <share url | #hash | state.json> [--chart] [--nsamples N] [--top N] [--skills F] [--json]');
	process.exit(1);
}
const flag = (name, default_) => argv.indexOf(name) > -1 ? parseInt(argv[argv.indexOf(name) + 1], 10) : default_;
const available = argv.includes('--skills')
	? availableSkills(JSON.parse(fs.readFileSync(argv[argv.indexOf('--skills') + 1], 'utf8')))
	: null;

const o = await loadState(input);
const course = courses[o.courseId];
course.slopes.sort((a, b) => a.start - b.start);  // CourseHelpers.getCourse()
const uma1 = deserializeUma(o.uma1);
const options = {
	seed: o.seed || DEFAULT_SEED,
	usePosKeep: o.usePosKeep,
	useCompeteTop: o.useCompeteTop ?? true,
	useIntChecks: o.useIntChecks || false
};
const header = `course ${o.courseId} (${course.distance}m) · seed ${options.seed}`;

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
