#!/usr/bin/env node
// Zips one project's dist/ into a loadable/uploadable extension archive.
//
//   node scripts/package.mjs 01-family-tree   # one project
//   node scripts/package.mjs .                # the project you are standing in
//   node scripts/package.mjs                  # all of them
//
// Runs the repository-wide preflight first and refuses to package if it did not
// pass — including the "inconclusive" exit, because an archive is the one
// artefact that leaves this machine and a half-checked one is indistinguishable
// from a checked one. Preflight is repo-wide on purpose: the leak gate does not
// become less relevant because you are only shipping one of three projects.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { discoverProjects, ROOT } from './projects.mjs';

const projects = discoverProjects().filter((project) => !project.incomplete);
const requested = process.argv[2];

let selected;
if (!requested) {
    selected = projects;
} else {
    const id = requested === '.' ? basename(process.cwd()) : requested.replace(/^\.\//, '').replace(/\/$/, '');
    selected = projects.filter((project) => project.id === id);
    if (selected.length === 0) {
        console.error(`No such project: ${requested}`);
        console.error(`Known projects: ${projects.map((p) => p.id).join(', ') || '(none)'}`);
        process.exit(1);
    }
}

const preflight = spawnSync(process.execPath, ['scripts/preflight.mjs'], { cwd: ROOT, stdio: 'inherit' });
if (preflight.status !== 0) {
    console.error(`\nNot packaging: preflight exited ${preflight.status}.`);
    process.exit(preflight.status ?? 1);
}

for (const project of selected) {
    const dist = join(project.dir, 'dist');
    const archive = join(ROOT, `${project.pkg.name}-${project.pkg.version}.zip`);
    if (existsSync(archive)) rmSync(archive);

    // `zip` ships with macOS and every Linux distribution worth naming. If it is
    // absent, say what to do instead of failing with a spawn error nobody can read.
    const zip = spawnSync('zip', ['-r', '-q', archive, '.'], { cwd: dist, stdio: 'inherit' });
    if (zip.error) {
        console.error(`Could not run zip (${zip.error.message}).`);
        console.error(`Load the unpacked directory instead: chrome://extensions → Load unpacked → ${relative(ROOT, dist)}`);
        process.exit(1);
    }
    if (zip.status !== 0) process.exit(zip.status ?? 1);
    console.log(`\nWrote ${relative(ROOT, archive)}`);
}

console.log('To load one without zipping: chrome://extensions → Developer mode → Load unpacked → <project>/dist/');
