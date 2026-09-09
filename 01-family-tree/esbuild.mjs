// Build: bundle each entry point to an IIFE in dist/, then copy public/ verbatim.
//
// The options live in esbuild.config.mjs so that anything else that needs to build
// this project — a size measurement, an audit — uses exactly these settings. See
// that file for why the split exists.

import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

import { options } from './esbuild.config.mjs';

const watch = process.argv.includes('--watch');

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
