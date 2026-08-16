#!/usr/bin/env node
// Headless driver for the umalator-global comparison.
//
// Runs the committed simulator.worker.js (the exact bundle the website ships) inside a vm context with
// `self`/`postMessage` shimmed, so no build step and no browser are involved.
//
// usage: node cli.mjs <share url | #hash | state.json> [--nsamples N] [--json]
//
// ponytail: drives the prebuilt worker rather than the TS sources, because umalator/compare.ts currently
// needs RaceSolverBuilder methods (otherHorse, withItidoriarasoi, 4-arg addSkill) that don't exist in the
// pinned uma-skill-tools submodule. Switch to bundling the sources once the submodule catches up.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const readJson = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const skillmeta = readJson('skill_meta.json');
const courses = readJson('course_data.json');

const DEFAULT_SEED = 2615953739;  // keep in sync with umalator/app.tsx

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

function runWorker(message) {
	let onmessage;
	const posted = [];
	const ctx = vm.createContext({
		self: {addEventListener: (_, fn) => { onmessage = fn; }},
		postMessage: m => posted.push(m),
		console
	});
	vm.runInContext(fs.readFileSync(path.join(dir, 'simulator.worker.js'), 'utf8'), ctx, {filename: 'simulator.worker.js'});
	onmessage({data: message});  // the handlers are synchronous; progress updates first, final result last
	return posted[posted.length - 1];
}

const argv = process.argv.slice(2);
const input = argv.find(a => !a.startsWith('-'));
if (input == null) {
	console.error('usage: node cli.mjs <share url | #hash | state.json> [--nsamples N] [--json]');
	process.exit(1);
}

const o = await loadState(input);
const nsamplesArg = argv.indexOf('--nsamples');
const nsamples = nsamplesArg > -1 ? parseInt(argv[nsamplesArg + 1], 10) : o.nsamples;
const course = courses[o.courseId];
course.slopes.sort((a, b) => a.start - b.start);  // CourseHelpers.getCourse()

const {results, runData} = runWorker({
	msg: 'compare',
	data: {
		nsamples,
		course,
		// racedefToParams() in umalator/app.tsx; compare mode passes no order range
		racedef: {
			groundCondition: o.racedef.ground, weather: o.racedef.weather, season: o.racedef.season,
			time: o.racedef.time, grade: o.racedef.grade,
			skillId: '', orderRange: null, numUmas: 9
		},
		uma1: deserializeUma(o.uma1),
		uma2: deserializeUma(o.uma2),
		options: {
			seed: o.seed || DEFAULT_SEED,
			usePosKeep: o.usePosKeep,
			useCompeteTop: o.useCompeteTop ?? true,
			useIntChecks: o.useIntChecks || false
		}
	}
}).results;

if (argv.includes('--json')) {
	console.log(JSON.stringify({results, nspurt: runData.nspurt}));
} else {
	const mid = Math.floor(results.length / 2);
	const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
	const mean = results.reduce((a, b) => a + b, 0) / results.length;
	console.log(`course ${o.courseId} (${course.distance}m) · ${results.length} samples · seed ${o.seed || DEFAULT_SEED}`);
	console.log(`bashin (uma2 - uma1)  min ${results[0].toFixed(2)}  max ${results[results.length-1].toFixed(2)}  mean ${mean.toFixed(2)}  median ${median.toFixed(2)}`);
	console.log(`uma2 ahead ${(results.filter(x => x > 0).length / results.length * 100).toFixed(1)}%  ·  spurt rate ${(runData.nspurt[0] / results.length * 100).toFixed(1)}% / ${(runData.nspurt[1] / results.length * 100).toFixed(1)}%`);
}
