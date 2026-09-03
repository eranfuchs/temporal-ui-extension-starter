// Asks esbuild what actually ends up inside each of a project's bundles.
//
// WHY THIS EXISTS
//
// There are three different questions people confuse for one:
//
//   1. what does package.json DECLARE?          — a claim, and claims rot
//   2. what does npm RESOLVE?                   — a much larger set, most of it
//                                                 build tooling that never ships
//   3. what does esbuild PUT IN A BUNDLE
//      the browser loads?                       — the only one that is attack
//                                                 surface for a user
//
// The surface gate used to answer (1) and print a verdict about (3). That gap was
// not theoretical: with the projects hoisted into one install, a package declared
// by a SIBLING project resolves fine from this one, so source could import it,
// esbuild would inline it, and a check that reads only package.json would report
// nothing. This module answers (3) by building with `metafile: true` and reading
// the input list back, so the gate's verdict is about the bytes a user runs.
//
// Nothing here writes to disk: `write: false` gets us the bundles and their sizes
// in memory, so an audit can never leave a half-built dist/ behind or race the
// real build.

import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// A path esbuild reported as a bundle input, reduced to the package it came from.
// The LAST `node_modules` wins: a nested install reads
// `node_modules/a/node_modules/b/index.js`, and the package that file belongs to
// is b, not a. Scoped names take two segments.
export function packageOf(inputPath) {
    const parts = inputPath.split('/').join(sep).split(sep);
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) return null;
    const first = parts[at + 1];
    if (!first) return null;
    if (first.startsWith('@')) return parts[at + 2] ? `${first}/${parts[at + 2]}` : null;
    return first;
}

// The directory that package's own package.json sits in, derived from the SAME input
// path esbuild reported — so a version or a license read out of it is the version and
// license of the copy that was actually inlined, not of whatever a fresh resolution
// would find today.
export function packageRootOf(inputPath) {
    const parts = inputPath.split('/');
    const at = parts.lastIndexOf('node_modules');
    if (at < 0) return null;
    const first = parts[at + 1];
    if (!first) return null;
    const end = first.startsWith('@') ? at + 3 : at + 2;
    if (parts.length < end) return null;
    return parts.slice(0, end).join('/');
}

const isThirdParty = (inputPath) => packageOf(inputPath) !== null;

// Every project keeps its build options in esbuild.config.mjs precisely so this
// can import them. Auditing a bundle built with different options would be
// auditing a different bundle.
export async function analyseBundles(projectDir) {
    const configPath = join(projectDir, 'esbuild.config.mjs');
    if (!existsSync(configPath)) {
        return { ok: false, why: 'no esbuild.config.mjs — the audit cannot know what this project bundles' };
    }

    let options;
    try {
        ({ options } = await import(pathToFileURL(configPath).href));
    } catch (err) {
        return { ok: false, why: `esbuild.config.mjs could not be imported: ${err.message}` };
    }
    if (!options?.entryPoints?.length) {
        return { ok: false, why: 'esbuild.config.mjs exports no entryPoints' };
    }

    let result;
    try {
        result = await build({
            ...options,
            absWorkingDir: projectDir,
            write: false,
            metafile: true,
            logLevel: 'silent',
        });
    } catch (err) {
        return { ok: false, why: `build failed, so nothing about its bundles was checked: ${err.message}` };
    }

    const sizeOf = new Map(result.outputFiles.map((file) => [file.path, file.contents.byteLength]));
    const entries = [];
    for (const [outputPath, output] of Object.entries(result.metafile.outputs)) {
        if (!output.entryPoint) continue; // the .map, listed beside its .js
        const absolute = join(projectDir, outputPath);
        // What each third-party package COSTS THIS BUNDLE, from the same metafile:
        // `bytesInOutput` is what survived into these bytes, which is the number a
        // reader of the dist/ directory can act on. Summing the package's files on disk
        // would report the download instead, and tree-shaking makes those differ by an
        // order of magnitude.
        const thirdPartyBytes = new Map();
        for (const [inputPath, contribution] of Object.entries(output.inputs ?? {})) {
            const name = packageOf(inputPath);
            if (!name) continue;
            thirdPartyBytes.set(name, (thirdPartyBytes.get(name) ?? 0) + (contribution.bytesInOutput ?? 0));
        }
        entries.push({
            entry: output.entryPoint,
            output: outputPath,
            bytes: sizeOf.get(absolute) ?? output.bytes,
            mapBytes: sizeOf.get(`${absolute}.map`) ?? 0,
            thirdPartyBytes,
        });
    }
    entries.sort((a, b) => a.output.localeCompare(b.output));

    // A package is DIRECT when a file of ours imports it, and transitive when only
    // another package does. The distinction is the one that matters when reading a
    // dependency list: direct packages are choices, transitive ones are
    // consequences of those choices.
    const direct = new Set();
    const importedBy = new Map();
    const bundled = new Set();
    const packageRoots = new Map();
    for (const [inputPath, input] of Object.entries(result.metafile.inputs)) {
        const own = packageOf(inputPath);
        if (own) {
            bundled.add(own);
            const root = packageRootOf(inputPath);
            if (root && !packageRoots.has(own)) packageRoots.set(own, root);
        }
        if (own) continue; // only OUR files make an import "direct"
        for (const imported of input.imports ?? []) {
            const name = packageOf(imported.path);
            if (!name) continue;
            direct.add(name);
            if (!importedBy.has(name)) importedBy.set(name, []);
            importedBy.get(name).push(inputPath);
        }
    }

    const sorted = (set) => [...set].sort();
    return {
        ok: true,
        entries,
        direct: sorted(direct),
        transitive: sorted([...bundled].filter((name) => !direct.has(name))),
        bundled: sorted(bundled),
        importedBy,
        packageRoots,
        inputCount: Object.keys(result.metafile.inputs).length,
        thirdPartyInputCount: Object.keys(result.metafile.inputs).filter(isThirdParty).length,
    };
}
