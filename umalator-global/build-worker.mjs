// Build umalator/simulator.worker.ts to an arbitrary outfile, replicating build.mjs's options
// (minify, defines, node:assert stub, data redirects) without touching the shipped artifacts.
// The usual use is driving cli.mjs with a fresh build: UMALATOR_WORKER=<outfile> node cli.mjs ...
// ab.mjs uses it too, to check a build against the committed bundle.
//
// usage: node build-worker.mjs <outfile> [--debug]
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const dir = path.dirname(fileURLToPath(import.meta.url));
const outfile = process.argv.slice(2).find(a => !a.startsWith('--'));
const debug = process.argv.includes('--debug');
if (!outfile) {
	console.error('usage: node build-worker.mjs <outfile> [--debug]');
	process.exit(1);
}

// keep in sync with the entry/redirects in build.mjs
const redirect = {
	"^@tanstack/": args => path.join(dir, '..', 'vendor', args.path.slice(10), 'index.ts'),
	"^\.\.?(?:/uma-skill-tools)?/data/": args => path.join(dir, args.path.split('/data/')[1]),
	"skill_meta.json$": _ => path.join(dir, 'skill_meta.json'),
	"umas.json$": _ => path.join(dir, 'umas.json')
};

await esbuild.build({
	entryPoints: [path.join(dir, '..', 'umalator', 'simulator.worker.ts')],
	bundle: true,
	minify: !debug,
	outfile,
	define: {CC_DEBUG: debug.toString(), CC_GLOBAL: 'true'},
	external: ['*.ttf', '*.png'],
	plugins: [
		{name: 'mockAssert', setup(build) {
			build.onResolve({filter: /^node:assert$/}, args => ({path: args.path, namespace: 'mockAssert-ns'}));
			build.onLoad({filter: /.*/, namespace: 'mockAssert-ns'}, () => ({
				contents: 'module.exports={strict:' + (debug ? 'console.assert' : 'function(){}') + '};', loader: 'js'
			}));
		}},
		{name: 'redirect', setup(build) {
			Object.keys(redirect).forEach(filter => {
				build.onResolve({filter: new RegExp(filter)}, args => ({path: redirect[filter](args)}));
			});
		}}
	]
});
console.log('built', outfile);
