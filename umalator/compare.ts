import { CourseData } from '../uma-skill-tools/CourseData';
import { Region, RegionList } from '../uma-skill-tools/Region';
import { RaceParameters } from '../uma-skill-tools/RaceParameters';
import { RaceSolver } from '../uma-skill-tools/RaceSolver';
import { RaceSolverBuilder, Perspective } from '../uma-skill-tools/RaceSolverBuilder';
import type { GameHpPolicy } from '../uma-skill-tools/HpPolicy';
import { Rule30CARng } from '../uma-skill-tools/Random';
import { ActivationSamplePolicy, ImmediatePolicy, RandomPolicy, LogNormalRandomPolicy, ErlangRandomPolicy, StraightRandomPolicy, AllCornerRandomPolicy } from '../uma-skill-tools/ActivationSamplePolicy';

import { HorseState, SamplePolicyDesc, uniqueSkillForUma } from '../components/HorseDefTypes';

import skillmeta from '../skill_meta.json';

class FixedDistancePolicy {
	constructor(readonly pos: number) {}
	sample(_0: RegionList, nsamples: number, _1: PRNG) { return Array.from({length: nsamples}, _ => new Region(this.pos, this.pos + 10)); }

	// these should never be called because this policy is only used as an override and never reconciled with anything
	reconcile(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileImmediate(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileDistributionRandom(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileRandom(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileStraightRandom(other: ActivationSamplePolicy) { console.assert(false); }
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { console.assert(false); }
}

export function instantiateSamplePolicy(desc: SamplePolicyDesc | undefined): ActivationSamplePolicy | undefined {
	if (desc == null) return undefined;
	switch (desc.policy) {
		case 'immediate': return ImmediatePolicy;
		case 'random': return RandomPolicy;
		case 'straight-random': return StraightRandomPolicy;
		case 'all-corner-random': return AllCornerRandomPolicy;
		case 'log-normal': return new LogNormalRandomPolicy(desc.mu, desc.sigma);
		case 'erlang': return new ErlangRandomPolicy(desc.k, desc.lambda);
		case 'fixed': return new FixedDistancePolicy(desc.pos);
	}
}

export function getActivator(selfSet: Map<string, [number,number]>, otherSet: Map<String, [number,number]> | null) {
	return function (s, id, persp) {
		const skillSet = persp == Perspective.Self ? selfSet : otherSet;
		if (id == 'downhill') {
			if (!skillSet.has('downhill')) skillSet.set('downhill', 0);
			skillSet.set('downhill', skillSet.get('downhill') - s.accumulatetime.t);
		} else if (skillSet != null && id != 'asitame' && id != 'staminasyoubu') {
			if (!skillSet.has(id)) skillSet.set(id, []);
			skillSet.get(id).push([s.pos, -1]);
		}
	};
}
export function getDeactivator(selfSet: Map<string, [number,number]>, otherSet: Map<String, [number,number]> | null, course) {
	return function (s, id, persp) {
		const skillSet = persp == Perspective.Self ? selfSet : otherSet;
		if (id == 'downhill') {
			skillSet.set('downhill', skillSet.get('downhill') + s.accumulatetime.t);
		} else if (skillSet != null && id != 'asitame' && id != 'staminasyoubu') {
			const ar = skillSet.get(id);  // activation record
			// in the case of adding multiple copies of speed debuffs a skill can activate again before the first
			// activation has finished (as each copy has the same ID), so we can't just access a specific index
			// (-1).
			// assume that multiple activations of a skill always deactivate in the same order (probably true?) so
			// just seach for the first record that hasn't had its deactivation location filled out yet.
			const r = ar.find(x => x[1] == -1);
			// onSkillDeactivate gets called twice for skills that have both speed and accel components, so the end
			// position could already have been filled out and r will be undefined
			if (r != null) r[1] = Math.min(s.pos, course.distance);
		}
	};
}

// One sample of one uma: everything the chart draws, plus a few frames past the finish line. Two umas are
// compared at the moment the first of them crosses the line, so the other one's position there has to be
// available, and it can cross up to a frame or two later. Running past the line is free: RaceSolver only
// draws from the shared rng in its constructor, so extra frames can't desync the samples after this one.
export type Trace = {
	t: number[], p: number[], v: number[], hp: number[],  // as recorded up to the finish line
	tt: number[], tp: number[],                           // time and position for TAIL frames past it
	sk: Map<string,any>, sdly: number, dh: number, spurt: boolean
};

const TAIL = 3;

const last = (a: number[]) => a[a.length-1];

// position at the first frame at or after `time`. Infinity if even the tail doesn't reach it, which only
// happens when this uma finished so much earlier that it cannot be the one behind.
function posAt(tr: Trace, time: number) {
	const i = tr.t.findIndex(t => t >= time);
	if (i > -1) return tr.p[i];
	const j = tr.tt.findIndex(t => t >= time);
	return j > -1 ? tr.tp[j] : Infinity;
}

function runToFinish(s: RaceSolver, distance: number, skillPos: Map<string,any>): Trace {
	const t = [], p = [], v = [], hp = [];
	while (s.pos < distance) {
		s.step(1/15);
		t.push(s.accumulatetime.t);
		p.push(s.pos);
		v.push(s.currentSpeed + (s.modifiers.currentSpeed.acc + s.modifiers.currentSpeed.err));
		hp.push((s.hp as GameHpPolicy).hp);
	}
	const sdly = s.startDelay, spurt = s.isLastSpurt && s.lastSpurtTransition == -1;
	s.cleanup();
	const dh = skillPos.get('downhill') || 0;
	skillPos.delete('downhill');
	// a level deeper than the old loop's new Map(): the tail below still writes into skillPos (deactivating
	// a skill there has to find its activation record), and those writes are not part of this sample
	const sk = new Map();
	skillPos.forEach((v,k) => sk.set(k, v.map(r => r.slice())));
	const tt = [], tp = [];
	for (let i = 0; i < TAIL; ++i) {
		s.step(1/15);
		tt.push(s.accumulatetime.t);
		tp.push(s.pos);
	}
	skillPos.clear();
	return {t, p, v, hp, tt, tp, sk, sdly, dh, spurt};
}

// racedefToParams() in umalator/app.tsx has the same table; chart mode resolves the band there because it
// only ever has one uma, a compare has to resolve it per side.
const ORDER_RANGE_FOR_STRATEGY = Object.freeze({
	'Nige': [1,1], 'Senkou': [2,4], 'Sasi': [5,9], 'Oikomi': [5,9], 'Oonige': [1,1]
});

function orderForStrategy(b: RaceSolverBuilder, racedef: RaceParameters, uma: HorseState) {
	const range = racedef.orderRange ?? ORDER_RANGE_FOR_STRATEGY[uma.strategy];
	if (range != null) b.order(range[0], range[1]).numUmas(racedef.numUmas ?? 9);
}

export function runComparison(nsamples: number, course: CourseData, racedef: RaceParameters, uma1: HorseState, uma2: HorseState, seed: [number,number], options, baseline?: {traces: Trace[] | null}) {
	// with the baseline uma's races cached, uma1 is neither built nor simulated (see simulator.worker.ts)
	const cached = baseline != null && baseline.traces != null && baseline.traces.length >= nsamples
		? baseline.traces : null;
	let standard: RaceSolverBuilder | null = new RaceSolverBuilder(nsamples)
		.seed(...seed)
		.course(course)
		.ground(racedef.groundCondition)
		.weather(racedef.weather)
		.season(racedef.season)
		.time(racedef.time);
	// Order conditions are checked against a static band for where the uma sits in the pack, not against a
	// simulated position, and the two sides of a compare can be running different strategies: order==1
	// (Angling and Scheming) is real for a front runner and impossible for a pace chaser. So the band has to
	// be per uma, applied after the fork — before this, a null band silently dropped every order condition
	// and both sides fired front-runner skills. An explicit racedef.orderRange still wins for both, which is
	// what chart mode passes.
	const compare = standard.fork();
	orderForStrategy(standard, racedef, uma1);
	orderForStrategy(compare, racedef, uma2);
	if (cached != null) standard = null;
	standard?.horse(uma1).otherHorse(uma2);
	compare.horse(uma2).otherHorse(uma1);
	const wisdomSeeds = new Map<string, [number,number]>();
	const wisdomRng = new Rule30CARng(...seed);
	for (let i = 0; i < 20; ++i) wisdomRng.pair();   // advance the RNG state a bit because we only seeded the low bits
	// ensure skills common to the two umas are added in the same order regardless of what additional skills they have
	// this is important to make sure the rng for their activations is synced
	// sort first by groupId so that white and gold versions of a skill get added in the same order
	const common = Array.from(new Set(uma1.skills.keys()).intersection(new Set(uma2.skills.keys()))).sort((a,b) => +a - +b);
	const commonIdx = (id) => { let i = common.indexOf(skillmeta[id].groupId); return i > -1 ? i : common.length; };
	const sort = (a,b) => commonIdx(a) - commonIdx(b) || +a - +b;
	const u1id = uniqueSkillForUma(uma1.outfitId, uma1.starCount);
	const u2id = uniqueSkillForUma(uma2.outfitId, uma2.starCount);
	Array.from(uma1.skills.values()).sort(sort).forEach(id => {
		wisdomSeeds.set(id, wisdomRng.pair());
		standard?.addSkill(id, Perspective.Self, id == u1id ? uma1.uniqueLv : 1, instantiateSamplePolicy(uma1.samplePolicies.get(id)));
	});
	Array.from(uma2.skills.values()).sort(sort).forEach(id => {
		// this means that the second set of rolls 'wins' for skills on both, but this doesn't actually matter
		wisdomSeeds.set(id, wisdomRng.pair());
		compare.addSkill(id, Perspective.Self, id == u2id ? uma2.uniqueLv : 1, instantiateSamplePolicy(uma2.samplePolicies.get(id)));
	});
	// iterating twice like this is VERY ANNOYING
	// unfortunately, because we add every skill to both umas, if we add them in the same iteration uma2 will have all the
	// Other skills before its Self skills, which can cause skill desync issues when there are debuffs
	// TODO i don't really like this, this might just be masking some deeper underlying issue.
	uma1.skills.forEach(id => compare.addSkill(id, Perspective.Other, id == u1id ? uma1.uniqueLv : 1, instantiateSamplePolicy(uma1.samplePolicies.get(id))));
	uma2.skills.forEach(id => standard?.addSkill(id, Perspective.Other, id == u2id ? uma2.uniqueLv : 1, instantiateSamplePolicy(uma2.samplePolicies.get(id))));
	standard?.withAsiwotameru();
	compare.withAsiwotameru();
	if (!CC_GLOBAL) {
		standard?.withStaminaSyoubu();
		compare.withStaminaSyoubu();
	}
	if (options.usePosKeep) {
		standard?.useDefaultPacer(); compare.useDefaultPacer();
	}
	if (options.useCompeteTop) {
		standard?.withItidoriarasoi(); compare.withItidoriarasoi();
	}
	if (options.useIntChecks) {
		standard?.withWisdomChecks(wisdomSeeds);
		compare.withWisdomChecks(wisdomSeeds);
	}
	const skillPos1 = new Map(), skillPos2 = new Map();
	standard?.onSkillActivate(getActivator(skillPos1, null));
	standard?.onSkillDeactivate(getDeactivator(skillPos1, null, course));
	compare.onSkillActivate(getActivator(skillPos2, null));
	compare.onSkillDeactivate(getDeactivator(skillPos2, null, course));
	let a = standard?.build(), b = compare.build();
	const traces = [];
	// `ref` is the uma whose crossing of the finish line the sample is measured at, and it has to be
	// whichever one got there first: running the other past the finish would overestimate the difference,
	// because for example a skill can continue past the end of the course. The old loop found this out by
	// simulating the sample, checking, and re-simulating with the two umas swapped; both traces are complete
	// here, so the same check costs a swap. Which uma it starts from carries over between samples, as then.
	let ref = 1;
	const diff = [];
	let min = Infinity, max = -Infinity, estMean, estMedian, bestMeanDiff = Infinity, bestMedianDiff = Infinity;
	let minrun, maxrun, meanrun, medianrun;
	let nspurt = [0,0];
	const sampleCutoff = Math.max(Math.floor(nsamples * 0.8), nsamples - 200);
	for (let i = 0; i < nsamples; ++i) {
		const tr1 = cached != null ? cached[i] : runToFinish(a.next().value as RaceSolver, course.distance, skillPos1);
		const tr2 = runToFinish(b.next().value as RaceSolver, course.distance, skillPos2);
		if (cached == null) traces.push(tr1);
		const tr = [tr1, tr2];  // uma1 is always index 0 and uma2 always index 1

		let mark = posAt(tr[1-ref], last(tr[ref].t));
		if (last(tr[ref].p) < mark || isNaN(mark)) {  // at most one of the two can fail this
			ref = 1 - ref;
			mark = posAt(tr[1-ref], last(tr[ref].t));
		}
		const basinn = (ref == 1 ? 1 : -1) * (last(tr[ref].p) - mark) / 2.5;

		nspurt[0] += +tr1.spurt;
		nspurt[1] += +tr2.spurt;
		const data = {
			t: [tr1.t, tr2.t], p: [tr1.p, tr2.p], v: [tr1.v, tr2.v], hp: [tr1.hp, tr2.hp],
			sk: [tr1.sk, tr2.sk], sdly: [tr1.sdly, tr2.sdly], dh: [tr1.dh, tr2.dh]
		};
		diff.push(basinn);
		if (basinn < min) {
			min = basinn;
			minrun = data;
		}
		if (basinn > max) {
			max = basinn;
			maxrun = data;
		}
		if (i == sampleCutoff) {
			diff.sort((a,b) => a - b);
			estMean = diff.reduce((a,b) => a + b) / diff.length;
			const mid = Math.floor(diff.length / 2);
			estMedian = mid > 0 && diff.length % 2 == 0 ? (diff[mid-1] + diff[mid]) / 2 : diff[mid];
		}
		if (i >= sampleCutoff) {
			const meanDiff = Math.abs(basinn - estMean), medianDiff = Math.abs(basinn - estMedian);
			if (meanDiff < bestMeanDiff) {
				bestMeanDiff = meanDiff;
				meanrun = data;
			}
			if (medianDiff < bestMedianDiff) {
				bestMedianDiff = medianDiff;
				medianrun = data;
			}
		}
	}
	if (baseline != null && cached == null) baseline.traces = traces;
	diff.sort((a,b) => a - b);
	return {results: diff, runData: {nspurt, minrun, maxrun, meanrun, medianrun}};
}
