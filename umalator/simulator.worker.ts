import type { CourseData } from '../uma-skill-tools/CourseData';
import type { RaceParameters } from '../uma-skill-tools/RaceParameters';
import { Rule30CARng } from '../uma-skill-tools/Random';

import { HorseState } from '../components/HorseDefTypes';
import { runComparison } from './compare';
import { runHpCalc } from './hpcalc';

import skillmeta from '../skill_meta.json';
import skilldata from '../uma-skill-tools/data/skill_data.json';

function mergeResults(results1, results2) {
	console.assert(results1.id == results2.id, `mergeResults: ${results1.id} != ${results2.id}`);
	const n1 = results1.results.length, n2 = results2.results.length;
	const combinedResults = results1.results.concat(results2.results).sort((a,b) => a - b);
	const combinedMean = (results1.mean * n1 + results2.mean * n2) / (n1 + n2);
	const mid = Math.floor(combinedResults.length / 2);
	const newMedian = combinedResults.length % 2 == 0 ? (combinedResults[mid-1] + combinedResults[mid]) / 2 : combinedResults[mid];
	return {
		id: results1.id,
		results: combinedResults,
		min: Math.min(results1.min, results2.min),
		max: Math.max(results1.max, results2.max),
		mean: combinedMean,
		median: newMedian,
		runData: {
			// TODO should re-compute the bashin gain from .t/.p and pick whichever is closer to new mean/median
			...(n2 > n1 ? results2.runData : results1.runData),
			minrun: results1.min < results2.min ? results1.runData.minrun : results2.runData.minrun,
			maxrun: results1.max > results2.max ? results1.runData.maxrun : results2.runData.maxrun,
		}
	};
}

function mergeResultSets(data1, data2) {
	data2.forEach((r,id) => {
		data1.set(id, mergeResults(data1.get(id), r));
	});
}

// Every candidate in a round is charted against the same unchanged uma over the same samples, and that
// baseline is half the work of the round (it is also 50% of all solver steps). Candidates are added to the
// baseline's builder from Perspective.Other, which applies only the effects that target someone other than
// their own uma (isTargetedEffect), so a candidate that merely buffs itself changes nothing about the
// baseline's race. Cache it and let every such candidate replay it.
//
// The cache needs the baseline to be not just unaffected but identical, and two things break that:
//   - an effect that targets someone else (a debuff) really does apply to the baseline uma.
//     ActivateRandomGold ignores the target filter, so it counts too.
//   - how many draws the candidate costs the builder's rng. Trigger seeds are drawn one per unique skill
//     id in order, so a candidate shifts the seed of everything added after it. asitame and staminasyoubu
//     sample immediately and don't care; itidoriarasoi ((oo)nige) samples randomly and does. Adding a
//     skill and replacing one in its group both cost exactly one draw, which is why they can share a
//     baseline — charting a skill the uma already owns costs none, so it races its own. Wisdom checks
//     would break this too (one rng per skill id, shared across perspectives), and are off in chart mode.
const isInert = (id: string) => id in skilldata &&
	skilldata[id].alternatives.every(a => a.effects.every(e => e.target == 1 && e.type != 37));

function baselineCacheable(uma: HorseState, id: string, options) {
	if (options.useIntChecks) return false;
	const replaced = uma.skills.get(skillmeta[id].groupId);
	if (replaced == id) return false;  // uma2 is uma1: nothing is added, so this one costs no extra draw
	return isInert(id) && (replaced == null || isInert(replaced));
}

// cli.mjs charts one candidate per message, so the cache has to outlive the message. Keyed on everything
// but the candidate list, and only one key at a time, which bounds it to one uma/course's traces.
let cacheKey = null;
const cacheRounds = new Map();
function baselineCache({course, racedef, uma, options}) {
	const key = JSON.stringify([course, racedef, uma, options], (_,v) => v instanceof Map ? [...v] : v);
	if (key != cacheKey) {
		cacheKey = key;
		cacheRounds.clear();
	}
	return round => cacheRounds.get(round) || cacheRounds.set(round, {traces: null}).get(round);
}

function run1Round(nsamples: number, skills: string[], course: CourseData, racedef: RaceParameters, uma: HorseState, seed: [number,number], options, baseline?) {
	const data = new Map();
	skills.forEach(id => {
		const withSkill = {...uma, skills: new Map(uma.skills.entries())};
		withSkill.skills.set(skillmeta[id].groupId, id);
		const {results, runData} = runComparison(nsamples, course, racedef, uma, withSkill, seed, options,
			baselineCacheable(uma, id, options) ? baseline : undefined);
		const mid = Math.floor(results.length / 2);
		const median = results.length % 2 == 0 ? (results[mid-1] + results[mid]) / 2 : results[mid];
		const mean = results.reduce((a,b) => a+b, 0) / results.length;
		data.set(id, {
			id, results, runData,
			min: results[0],
			max: results[results.length-1],
			mean,
			median
		});
	});
	return data;
}

function doChart({skills, course, racedef, uma, options}) {
	const seedgen = new Rule30CARng(options.seed);
	const cache = baselineCache({course, racedef, uma, options});
	// every round draws its seed whether or not anything is left to chart, so a candidate's rounds line up
	// with the same rounds of every other candidate, and with their cached baselines
	const round = (n: number, ids: string[]) => {
		const seed = seedgen.pair();
		return run1Round(n, ids, course, racedef, uma, seed, options, cache(n + ':' + seed));
	};
	let results = round(3, skills);
	postMessage({type: 'chart', results});
	let update = round(17, skills);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
	skills = skills.filter(id => results.get(id).max > 0.1);
	update = round(30, skills);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
	skills = skills.filter(id => Math.abs(results.get(id).max - results.get(id).min) > 0.1);
	update = round(50, skills);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
	update = round(100, skills);
	mergeResultSets(results, update);
	postMessage({type: 'chart', results});
}

function doCompare({nsamples, course, racedef, uma1, uma2, options}) {
	const seedgen = new Rule30CARng(options.seed);
	let results;
	for (let n = Math.min(20, nsamples), mul = 6; n < nsamples; n = Math.min(n * mul, nsamples), mul = Math.max(mul - 1, 2)) {
		results = runComparison(n, course, racedef, uma1, uma2, seedgen.pair(), options);
		postMessage({type: 'compare', results});
	}
	results = runComparison(nsamples, course, racedef, uma1, uma2, seedgen.pair(), options);
	postMessage({type: 'compare', results});
}

function doHpCalc({nsamples, course, racedef, uma, debufUma, options}) {
	const seedgen = new Rule30CARng(options.seed);
	let results;
	for (let n = Math.min(20, nsamples), mul = 6; n < nsamples; n = Math.min(n * mul, nsamples), mul = Math.max(mul - 1, 2)) {
		results = runHpCalc(n, course, racedef, uma, debufUma, seedgen.pair(), options);
		postMessage({type: 'hpcalc', results});
	}
	results = runHpCalc(nsamples, course, racedef, uma, debufUma, seedgen.pair(), options);
	postMessage({type: 'hpcalc', results});
}

self.addEventListener('message', function (e) {
	const {msg, data} = e.data;
	switch (msg) {
		case 'chart':
			doChart(data);
			break;
		case 'compare':
			doCompare(data);
			break;
		case 'hpcalc':
			doHpCalc(data);
			break;
	}
});
