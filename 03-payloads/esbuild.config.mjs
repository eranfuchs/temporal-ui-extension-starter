// What this project builds, and how. Imported by esbuild.mjs (which runs the
// build) and by any audit that builds with `metafile: true` to see which packages
// actually end up in each bundle).
//
// It lives in its own file for one reason: the audit has to ask esbuild the same
// question the build asks it. A second copy of these options in the audit would
// be a copy that can drift, and the first thing it would stop noticing is a
// dependency entering a bundle the audit builds differently from the real one.
//
// No side effects here — importing this file must not write anything.

// One bundle per entry point, IIFE format — Chrome content scripts are NOT ES
// modules, so `import` at the top level of a content script silently does
// nothing useful. Bundling sidesteps that entirely: shared code in src/ is
// inlined into each bundle that imports it.
export const ENTRY_POINTS = [
    'src/inject.ts', // MAIN world — wraps window.fetch
    'src/apiInject.ts', // MAIN world — serves requests against the page's own API
    'src/content.ts', // ISOLATED world — renders
    'src/popup.ts', // toolbar popup
];

export const options = {
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
