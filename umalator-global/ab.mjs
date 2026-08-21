// Deep A/B: run the same worker messages through the committed simulator.worker.js and a rebuilt
// bundle (see build-worker.mjs), and require EVERY postMessage payload bit-identical — all samples,
// runData, Maps included. This is the regression suite for engine changes in uma-skill-tools:
// same seed, same messages, same bytes out. The cases cover compare/chart/hpcalc across courses,
// strategies (incl. Oonige itidoriarasoi), wisdom checks, unique levels, and debuffs. The two chart cases
// both exercise the baseline cache, the nige one on the strategy where it is riskiest.
//
// usage: node ab.mjs <rebuilt.worker.js> [--quick]
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const readJson = f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const skillmeta = readJson('skill_meta.json');
const skilldata = readJson('skill_data.json');
const courses = readJson('course_data.json');
const QUICK = process.argv.includes('--quick');

const rebuiltPath = process.argv.slice(2).find(a => !a.startsWith('--'));
const shippedPath = path.join(dir, 'simulator.worker.js');
if (!rebuiltPath) {
	console.error('usage: node ab.mjs <rebuilt.worker.js> [--quick]');
	process.exit(1);
}

function makeWorker(file) {
	let onmessage; const msgs = [];
	const ctx = vm.createContext({
		self: {addEventListener: (_, fn) => { onmessage = fn; }},
		postMessage: m => { msgs.push(m); },
		console
	});
	vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, {filename: path.basename(file)});
	return message => { msgs.length = 0; onmessage({data: message}); return msgs.slice(); };
}

// Map-aware canonical serialization (Maps come from the worker's vm realm, so no instanceof)
function canon(x) {
	return JSON.stringify(x, function (k, v) {
		if (Object.prototype.toString.call(v) == '[object Map]') return {__map: [...v.entries()].sort((a,b) => String(a[0]) < String(b[0]) ? -1 : 1)};
		if (typeof v == 'number' && !Number.isFinite(v)) return 'num:' + String(v);
		return v;
	});
}

// SkillSet() from components/HorseDefTypes.ts, same as cli.mjs
function skillSet(ids) {
	let ndebuff = 0;
	return new Map(ids.map(id => [
		skillmeta[id].iconId[0] == '3' ? skillmeta[id].groupId + '-' + ndebuff++ : skillmeta[id].groupId,
		id
	]));
}
const mkUma = o => ({
	outfitId: '', starCount: 3, uniqueLv: 1, mood: 2, popularity: 1,
	distanceAptitude: 'S', surfaceAptitude: 'A', strategyAptitude: 'A',
	samplePolicies: new Map(), ...o, skills: skillSet(o.skills)
});
const racedefToParams = (racedef, strategy) => ({
	groundCondition: racedef.ground, weather: racedef.weather, season: racedef.season,
	time: racedef.time, grade: racedef.grade, skillId: '',
	orderRange: strategy ? ({Nige:[1,1],Senkou:[2,4],Sasi:[5,9],Oikomi:[5,9],Oonige:[1,1]})[strategy] : null,
	numUmas: 9
});
const courseFor = id => { const c = courses[id]; c.slopes.sort((a,b) => a.start - b.start); return c; };

// pick skills that exercise the conditions ported from the shipped bundle, plus staples
const NEW_CONDS = ['activate_count_later_half','fan_count','furlong','is_abroad','is_activate_heal_skill',
	'is_other_character_activate_advantage_skill','is_popularity_top_character_activate_advantage_skill',
	'near_infront_count','order_rate_in50_continue','phase_latter_half_straight_random'];
const byCond = {};
for (const [id, sd] of Object.entries(skilldata)) {
	const conds = sd.alternatives.map(a => (a.precondition||'') + '&' + (a.condition||'')).join('&');
	for (const c of NEW_CONDS) if (conds.includes(c)) (byCond[c] ||= []).push(id);
}
console.log('condition coverage:', Object.fromEntries(Object.entries(byCond).map(([c,l]) => [c, l.length])));
const condSkills = [...new Set(Object.values(byCond).flatMap(l => l.slice(0,3)))].filter(id => skillmeta[id]);

const staples = ['200332','200333','201081','202303','200192','200502','200053','200401','900211','202301']
	.filter(id => id in skilldata && skillmeta[id]);

const RD = {ground: 1, weather: 1, season: 1, time: 2, grade: 100};
const RD2 = {ground: 3, weather: 3, season: 4, time: 4, grade: 200};

const base = {speed: 1600, stamina: 1300, power: 1100, guts: 800, wisdom: 1100};
const cases = [];
// compare cases on three courses / two strategies / two racedefs
const compCourses = [10606, 10501, 10105].filter(id => courses[id]);
for (const [i, cid] of compCourses.entries()) {
	const rd = i == 1 ? RD2 : RD;
	cases.push({label: `compare c${cid}`, msg: 'compare', data: {
		nsamples: QUICK ? 50 : 200,
		course: courseFor(cid),
		racedef: racedefToParams(rd),
		uma1: mkUma({...base, strategy: i == 2 ? 'Nige' : 'Senkou', skills: staples.slice(0, 5 + i)}),
		uma2: mkUma({...base, speed: 1550, guts: 900, strategy: i == 0 ? 'Sasi' : 'Senkou',
			skills: [...staples.slice(2, 6), ...condSkills.slice(0, 8)]}),
		options: {seed: 2615953739 + i, usePosKeep: true, useCompeteTop: true, useIntChecks: i != 1}
	}});
}
// unique-level scaling + Oonige itidoriarasoi (competeTopModifier [3.5,7.7] branch)
cases.push({label: 'compare oonige/uniqueLv', msg: 'compare', data: {
	nsamples: QUICK ? 50 : 200,
	course: courseFor(10606),
	racedef: racedefToParams(RD),
	uma1: mkUma({...base, outfitId: '100101', uniqueLv: 4, strategy: 'Oonige', skills: ['100011', ...staples.slice(0, 4)]}),
	uma2: mkUma({...base, outfitId: '100201', uniqueLv: 3, strategy: 'Nige', skills: ['100021', ...staples.slice(3, 7)]}),
	options: {seed: 424242, usePosKeep: true, useCompeteTop: true, useIntChecks: true}
}});
// chart case: rank candidate skills incl. the new-condition skills
const chartSkills = [...new Set([...condSkills, ...staples, '100011'])].slice(0, QUICK ? 12 : 25);
cases.push({label: 'chart c10606', msg: 'chart', data: {
	skills: chartSkills,
	course: courseFor(10606),
	racedef: racedefToParams(RD, 'Senkou'),
	uma: mkUma({...base, strategy: 'Senkou', skills: staples.slice(0, 3)}),
	options: {seed: 2615953739, usePosKeep: true, useCompeteTop: true, useIntChecks: false}
}});
// nige chart: the strategy the baseline cache has the most to lose on, since itidoriarasoi samples its
// trigger from the builder rng *after* the candidate is added. This case fails if baselineCacheable() lets
// through a candidate that doesn't cost the builder exactly one draw, e.g. one the uma already owns (which
// the staples in chartSkills cover).
cases.push({label: 'chart c10606 nige', msg: 'chart', data: {
	skills: chartSkills.slice(0, QUICK ? 8 : 15),
	course: courseFor(10606),
	racedef: racedefToParams(RD, 'Nige'),
	uma: mkUma({...base, strategy: 'Nige', skills: staples.slice(0, 3)}),
	options: {seed: 424242, usePosKeep: true, useCompeteTop: true, useIntChecks: false}
}});
// hpcalc case: probe the shipped worker for debuffs it can actually run (some skills use
// conditions the engine doesn't implement and throw)
const probe = makeWorker(shippedPath);
const debuffs = [];
for (const id of Object.keys(skilldata).filter(id => skillmeta[id] && skillmeta[id].iconId[0] == '3')) {
	if (debuffs.length >= 3) break;
	try {
		probe({msg: 'hpcalc', data: {nsamples: 2, course: courseFor(10606), racedef: racedefToParams(RD),
			uma: mkUma({...base, strategy: 'Senkou', skills: []}),
			debufUma: mkUma({...base, strategy: 'Sasi', skills: [id]}),
			options: {seed: 1, usePosKeep: true, useCompeteTop: true, useIntChecks: false}}});
		debuffs.push(id);
	} catch (e) {}
}
console.log('debuffs used:', debuffs.join(' '));
cases.push({label: 'hpcalc c10606', msg: 'hpcalc', data: {
	nsamples: QUICK ? 50 : 200,
	course: courseFor(10606),
	racedef: racedefToParams(RD),
	uma: mkUma({...base, strategy: 'Senkou', skills: staples.slice(0, 6)}),
	debufUma: mkUma({...base, strategy: 'Sasi', skills: debuffs}),
	options: {seed: 987654321, usePosKeep: true, useCompeteTop: true, useIntChecks: false}
}});

const A = makeWorker(shippedPath), B = makeWorker(rebuiltPath);
let fail = 0;
for (const c of cases) {
	const send = w => w({msg: c.msg, data: c.data});
	let ra, rb;
	try { ra = send(A); } catch (e) { fail++; console.log(`FAIL ${c.label}: shipped threw: ${String(e.message||e).slice(0,300)}`); continue; }
	try { rb = send(B); } catch (e) { fail++; console.log(`FAIL ${c.label}: rebuilt threw: ${String(e.message||e).slice(0,300)}`); continue; }
	const ca = ra.map(canon), cb = rb.map(canon);
	if (ca.length != cb.length) { fail++; console.log(`FAIL ${c.label}: message count ${ca.length} vs ${cb.length}`); continue; }
	let bad = -1;
	for (let i = 0; i < ca.length; i++) if (ca[i] != cb[i]) { bad = i; break; }
	if (bad < 0) { console.log(`OK   ${c.label} (${ca.length} messages, ${ca.reduce((a,s)=>a+s.length,0)} bytes)`); continue; }
	fail++;
	console.log(`FAIL ${c.label}: message ${bad} differs`);
	const a = ca[bad], b = cb[bad];
	let d = 0; while (d < a.length && d < b.length && a[d] == b[d]) d++;
	console.log('  shipped:', a.slice(Math.max(0, d-120), d+160));
	console.log('  rebuilt:', b.slice(Math.max(0, d-120), d+160));
}
console.log(fail ? `${fail} case(s) FAILED` : 'ALL CASES BIT-IDENTICAL');
process.exit(fail ? 1 : 0);
