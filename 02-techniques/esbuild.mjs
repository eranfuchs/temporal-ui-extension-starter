// Build: bundle each entry point to an IIFE in dist/, then copy public/ verbatim.
//
// One bundle per entry point, IIFE format — Chrome content scripts are NOT ES
// modules, so `import` at the top level of a content script silently does
// nothing useful. Bundling sidesteps that entirely: shared code in src/ is
// inlined into each bundle that imports it.

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const ENTRY_POINTS = [
    'src/inject.ts', // MAIN world — wraps window.fetch
    'src/content.ts', // ISOLATED world — renders
    'src/popup.ts', // toolbar popup
];

const options = {
    entryPoints: ENTRY_POINTS,
    outdir: 'dist',
    bundle: true,
    format: 'iife',
    target: 'chrome110',
    // Readable output is a feature here: this repo is meant to be read, and the
    // first thing anyone does with an unfamiliar extension is open its built
    // files in devtools. Minifying would save a few KB and cost that.
    minify: false,
    sourcemap: true,
    logLevel: 'info',
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    await cp('public', 'dist', { recursive: true });
    console.log('watching src/ — reload the unpacked extension after each rebuild');
    console.log('NOTE: changes under public/ are NOT re-copied by watch; re-run `npm run build`');
} else {
    await build(options);
    await cp('public', 'dist', { recursive: true });
    console.log('built dist/ — load it via chrome://extensions → Developer mode → Load unpacked');
}
