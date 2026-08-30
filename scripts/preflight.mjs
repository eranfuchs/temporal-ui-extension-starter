#!/usr/bin/env node
// One command to run before every commit.
//
// It reports ok / FAILED / UNVERIFIED as three separate outcomes, and it never
// counts a check that could not run as a check that passed. That distinction is
// the entire reason this file exists rather than a list of commands in a README:
// a wrapper that swallows "the tool is not installed" into a green tick is worse
// than no wrapper, because it manufactures confidence.
//
// There is no CI for this repository. This is the only thing standing between a
// mistake and the default branch.
//
// The repository holds three independent extensions, so this runs in two layers:
// repository-wide checks once (the leak gate, the lineage gate), then the same
// per-project checks inside each project directory. A project whose checks all
// fail to run is reported as UNVERIFIED, and — see the verdict block — a project
// that ran ZERO checks fails outright. "3 projects, all green" over a project
// that was silently skipped is the same lie in a new shape.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { discoverProjects, ROOT } from './projects.mjs';

const results = [];

function record(name, state, detail, { project } = {}) {
    results.push({ name, state, detail, project: project ?? null });
    const badge = { ok: '  ok  ', failed: 'FAILED', unverified: ' ???  ' }[state];
    console.log(`[${badge}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// unverifiedExit: an exit status this particular tool uses to say "I could not
// check anything" rather than "the check failed". The leak gate exits 2 when it
// had nothing to read — before the first commit, `git ls-files` is empty — and
// folding that into FAILED would be as misleading as folding it into ok.
function runCheck(name, command, args, { needs, unverifiedExit, cwd, project } = {}) {
    for (const path of needs ?? []) {
        if (!existsSync(join(ROOT, path))) {
            record(name, 'unverified', `${path} is missing — run: npm install`, { project });
            return;
        }
    }
    const proc = spawnSync(command, args, { cwd: cwd ?? ROOT, encoding: 'utf8', shell: false });
    if (proc.error) {
        record(name, 'unverified', `could not run ${command}: ${proc.error.message}`, { project });
        return;
    }
    if (unverifiedExit !== undefined && proc.status === unverifiedExit) {
        const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim().split('\n').filter(Boolean);
        record(name, 'unverified', truncate(output[0] ?? `exit ${proc.status}`, 90), { project });
        return;
    }
    if (proc.status !== 0) {
        const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
        record(name, 'failed', `exit ${proc.status}`, { project });
        if (output) console.log(indent(output));
        return;
    }
    const firstLine = `${proc.stdout ?? ''}`.trim().split('\n').filter(Boolean).pop();
    record(name, 'ok', firstLine ? truncate(firstLine, 90) : undefined, { project });
}

const indent = (text) => text.split('\n').map((l) => `         ${l}`).join('\n');
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const NODE = process.execPath;
const LOCAL_BIN = join(ROOT, 'node_modules', '.bin');

// ── Repository-wide ──────────────────────────────────────────────────────────

console.log('repository');

// First, because it is the one whose failure cannot be undone by a later commit.
// Run without --quiet on purpose: its last line names how many files it read, and
// that number is what distinguishes a clean scan from an empty one.
runCheck('leak gate (tracked + staged files)', NODE, ['scripts/leak-gate.mjs'], { unverifiedExit: 2 });
runCheck('leak gate self-test', NODE, ['scripts/leak-gate.mjs', '--selftest', '--quiet']);

runCheck('lineage (shared files identical across projects)', NODE, ['scripts/lineage.mjs'], { unverifiedExit: 2 });
runCheck('lineage self-test', NODE, ['scripts/lineage.mjs', '--selftest', '--quiet']);

// The permission ladder is this repository's main argument, and an argument that
// is only stated in a README is one nobody notices going false.
runCheck('surface (permissions, sinks, dependencies, binaries)', NODE, ['scripts/surface.mjs'], { unverifiedExit: 2 });
runCheck('surface self-test', NODE, ['scripts/surface.mjs', '--selftest', '--quiet']);

// Documentation is how anyone finds their way around three near-identical
// projects, and a path in a README rots without any symptom: the sentence still
// reads fine. Splitting one project into three moved every file at once, so every
// path in every document was wrong simultaneously and nothing complained.
runCheck('doc paths (links, cited paths, npm scripts)', NODE, ['scripts/doc-paths.mjs'], { unverifiedExit: 2 });
runCheck('doc paths self-test', NODE, ['scripts/doc-paths.mjs', '--selftest', '--quiet']);

// ── Per project ──────────────────────────────────────────────────────────────

const projects = discoverProjects();
if (projects.length === 0) {
    record('projects discovered', 'failed', 'no NN-name directory holds a package.json');
}

for (const project of projects) {
    console.log('');
    console.log(project.id);

    if (project.incomplete) {
        // Not "skipped". A numbered directory that is not yet a project is a
        // known gap, and it stays visible in the verdict until it is filled.
        record(`${project.id}: is a project`, 'unverified', project.incomplete, { project: project.id });
        continue;
    }

    checkVersionParity(project);
    runCheck(`${project.id}: typecheck (src + tests)`, join(LOCAL_BIN, 'tsc'), ['--noEmit'], {
        needs: ['node_modules/.bin/tsc'],
        cwd: project.dir,
        project: project.id,
    });
    runCheck(`${project.id}: unit tests`, join(LOCAL_BIN, 'vitest'), ['run', '--reporter=dot'], {
        needs: ['node_modules/.bin/vitest'],
        cwd: project.dir,
        project: project.id,
    });
    runCheck(`${project.id}: build`, NODE, ['esbuild.mjs'], {
        needs: ['node_modules/esbuild'],
        cwd: project.dir,
        project: project.id,
    });
    // A stale dist/ is this project's most convincing lie: every manual test loads
    // dist/, so editing source and skipping the build means the browser reports on
    // code that no longer exists. Checking only that the files EXIST is what let
    // that happen in the extension this starter came from.
    checkDist(project);
}

// ── The per-project checks ───────────────────────────────────────────────────

function checkVersionParity(project) {
    const name = `${project.id}: manifest and package.json agree on the version`;
    if (!existsSync(project.manifestPath)) {
        record(name, 'failed', `${relative(ROOT, project.manifestPath)} does not exist`, { project: project.id });
        return;
    }
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(project.manifestPath, 'utf8'));
    } catch (err) {
        record(name, 'failed', `manifest.json is not valid JSON: ${err.message}`, { project: project.id });
        return;
    }
    if (manifest.version !== project.pkg.version) {
        record(name, 'failed', `manifest ${manifest.version} vs package.json ${project.pkg.version}`, {
            project: project.id,
        });
        return;
    }
    record(name, 'ok', `v${manifest.version}`, { project: project.id });
}

// Every path the manifest promises the browser it will find. Derived from the
// manifest rather than hardcoded, because the three projects ship different sets
// of files — 01 has no popup at all — and a hardcoded list would either fail on
// 01 or stop noticing a missing popup in 02.
function manifestReferences(manifest) {
    const paths = new Set();
    for (const value of Object.values(manifest.icons ?? {})) paths.add(value);
    for (const value of Object.values(manifest.action?.default_icon ?? {})) paths.add(value);
    if (manifest.action?.default_popup) paths.add(manifest.action.default_popup);
    if (manifest.background?.service_worker) paths.add(manifest.background.service_worker);
    for (const script of manifest.content_scripts ?? []) {
        for (const file of script.js ?? []) paths.add(file);
        for (const file of script.css ?? []) paths.add(file);
    }
    for (const resource of manifest.web_accessible_resources ?? []) {
        for (const file of resource.resources ?? []) {
            if (!file.includes('*')) paths.add(file);
        }
    }
    return [...paths];
}

function newestMtime(dir, skip = new Set()) {
    let newest = 0;
    let newestFile = null;
    const walk = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const full = join(path, entry.name);
            if (entry.isDirectory()) walk(full);
            else {
                const mtime = statSync(full).mtimeMs;
                if (mtime > newest) {
                    newest = mtime;
                    newestFile = full;
                }
            }
        }
    };
    walk(dir);
    return { newest, newestFile };
}

function checkDist(project) {
    const name = `${project.id}: dist/ is complete and newer than its sources`;
    const dist = join(project.dir, 'dist');
    if (!existsSync(dist)) {
        record(name, 'failed', 'dist/ does not exist — run: npm run build', { project: project.id });
        return;
    }
    if (!existsSync(join(dist, 'manifest.json'))) {
        record(name, 'failed', 'dist/manifest.json is missing — run: npm run build', { project: project.id });
        return;
    }

    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
    const missing = manifestReferences(manifest).filter((file) => !existsSync(join(dist, file)));
    if (missing.length > 0) {
        record(name, 'failed', `manifest names files dist/ does not have: ${missing.join(', ')}`, {
            project: project.id,
        });
        return;
    }

    const source = newestMtime(join(project.dir, 'src'));
    const assets = newestMtime(join(project.dir, 'public'));
    const built = newestMtime(dist);
    const newestSource = source.newest > assets.newest ? source : assets;
    if (built.newest < newestSource.newest) {
        record(name, 'failed', `${relative(ROOT, newestSource.newestFile)} is newer than dist/ — run: npm run build`, {
            project: project.id,
        });
        return;
    }
    record(name, 'ok', `${manifestReferences(manifest).length} manifest-named files present`, {
        project: project.id,
    });
}

// ── Verdict ──────────────────────────────────────────────────────────────────

// A project that produced NO result of any kind is not a pass. This is the shape
// the repository's own history of silent gates keeps taking: the outer loop
// reports a total, and nobody notices the total is over an empty set. Recorded
// before the tally, so it counts.
//
// An UNVERIFIED result counts as a result: a numbered directory that is not yet
// a project (03-goodies, until it is written) already says so above, and that is
// the honest status — it makes the whole run inconclusive rather than FAILED. The
// case this catches is a project the loop never reached at all.
for (const project of projects) {
    if (results.some((r) => r.project === project.id)) continue;
    record(`${project.id}: ran at least one check`, 'failed', 'not one check produced a result');
}

const failed = results.filter((r) => r.state === 'failed');
const unverified = results.filter((r) => r.state === 'unverified');
const ok = results.filter((r) => r.state === 'ok');

console.log('');
console.log(
    `${projects.length} project(s) · ${ok.length} ok · ${failed.length} FAILED · ${unverified.length} UNVERIFIED`,
);

if (failed.length > 0) {
    console.log(`\nNot ready: ${failed.map((r) => r.name).join('; ')}`);
    process.exit(1);
}
if (unverified.length > 0) {
    // Deliberately not exit 0. "All green with three checks that never ran" is
    // the exact false statement this script exists to make impossible.
    console.log(`\nInconclusive — these did not run: ${unverified.map((r) => r.name).join('; ')}`);
    console.log('Say so if you report these results.');
    process.exit(2);
}
console.log(`\nAll checks ran and passed, in ${projects.map((p) => p.id).join(', ')}.`);
