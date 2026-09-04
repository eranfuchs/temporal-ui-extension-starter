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
// Namespace import on purpose: a named import of markAsUncloneable would fail to
// LINK on a Node that does not have it, so this file would crash before it could
// explain why. The check below is the whole reason it is imported at all.
import * as workerThreads from 'node:worker_threads';

import semver from 'semver';

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
// vitest colours its summary, and an escape sequence sitting between "Test Files"
// and the count is enough to make the regex below miss the line it looks for.
const stripAnsi = (text) => text.replace(/\u001b\[[0-9;]*m/g, '');

const NODE = process.execPath;
const LOCAL_BIN = join(ROOT, 'node_modules', '.bin');

// The lowest Node major on which the DOM specs have been OBSERVED to run here,
// not a number read off a changelog: on 20.19.3 they do not run, on 22.22.3 they
// do. The exact patch release inside 22.x where that changed was not measured,
// which is precisely why checkNodeRuntime() probes for the capability instead of
// comparing version strings — the declared range is a promise to whoever clones
// this, and the probe is what actually knows.
//
// Declared up here rather than beside the check: the first thing this file does
// is run the checks, so anything they read has to already exist.
const VERIFIED_NODE_MAJOR = 22;
const ROOT_PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// Before the checks, because it must not run them: --selftest drives this file's own
// range logic on synthetic inputs and exits.
if (process.argv.includes('--selftest')) selftest();

// ── Repository-wide ──────────────────────────────────────────────────────────

console.log('repository');

// Before anything that depends on the toolchain being able to run at all.
checkNodeRuntime();
checkLockfileParity();
checkEngineRange();

// This file ran four other gates' self-tests and had none of its own, which made it
// the only gate here trusted on the strength of looking correct. It runs itself in a
// child process because the alternative is importing this file, and importing it runs
// every check in it.
runCheck('preflight self-test', NODE, ['scripts/preflight.mjs', '--selftest', '--quiet']);

// First, because it is the one whose failure cannot be undone by a later commit.
// Run without --quiet on purpose: its last line names how many files it read, and
// that number is what distinguishes a clean scan from an empty one.
runCheck('leak gate (tracked + staged + untracked files)', NODE, ['scripts/leak-gate.mjs'], { unverifiedExit: 2 });
runCheck('leak gate self-test', NODE, ['scripts/leak-gate.mjs', '--selftest', '--quiet']);

runCheck('lineage (shared files identical across projects)', NODE, ['scripts/lineage.mjs'], { unverifiedExit: 2 });
runCheck('lineage self-test', NODE, ['scripts/lineage.mjs', '--selftest', '--quiet']);

// The permission ladder is this repository's main argument, and an argument that
// is only stated in a README is one nobody notices going false.
runCheck('surface (permissions, sinks, entry points, binaries)', NODE, ['scripts/surface.mjs'], { unverifiedExit: 2 });
runCheck('surface self-test', NODE, ['scripts/surface.mjs', '--selftest', '--quiet']);

// Documentation is how anyone finds their way around three near-identical
// projects, and a path in a README rots without any symptom: the sentence still
// reads fine. Splitting one project into three moved every file at once, so every
// path in every document was wrong simultaneously and nothing complained.
runCheck('doc paths (links, anchors, cited paths, npm scripts, spec blocks)', NODE, ['scripts/doc-paths.mjs'], {
    unverifiedExit: 2,
});
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
    checkEnginesParity(project);
    runCheck(`${project.id}: typecheck (src + tests)`, join(LOCAL_BIN, 'tsc'), ['--noEmit'], {
        needs: ['node_modules/.bin/tsc'],
        cwd: project.dir,
        project: project.id,
    });
    checkUnitTests(project);
    runCheck(`${project.id}: build`, NODE, ['esbuild.mjs'], {
        needs: ['node_modules/esbuild'],
        cwd: project.dir,
        project: project.id,
    });
    // A stale dist/ is this project's most convincing lie: every manual test loads
    // dist/, so editing source and skipping the build means the browser reports on
    // code that no longer exists. Checking only that the files EXIST is what let
    // that happen in the extension behind this starter.
    checkDist(project);
}

// ── The repository-wide checks ───────────────────────────────────────────────

// The LOWEST major the declared range admits, which is the one the DOM specs have to
// survive. `semver.minVersion` answers that for the whole range; the first number in
// the string does not — it is the lowest only while the `||` branches happen to be
// written in ascending order, and nothing makes anyone write them that way.
function declaredNodeMajor(range) {
    if (!range || !semver.validRange(range)) return null;
    return semver.minVersion(range)?.major ?? null;
}

// Why a whole check for one function existing:
//
// The DOM specs run under jsdom, jsdom pulls in undici, and undici's webidl
// layer requires `markAsUncloneable` from node:worker_threads at import time. On
// a Node without it the jsdom environment cannot start — and the failure does not
// read as "your Node is too old". It reads as
// `TypeError: webidl.util.markAsUncloneable is not a function`, followed by a
// vitest summary that says every test PASSED, because the files that could not be
// collected are simply absent from the total. That is the repository's signature
// failure shape: a green tally over a suite that never ran.
//
// So this fails loudly, up front, and names the cause — and `checkUnitTests`
// below independently refuses to accept a run that collected fewer spec files
// than exist on disk, so even an unforeseen variant of this cannot pass.
function checkNodeRuntime() {
    const name = 'node can host the DOM tests (jsdom → undici)';
    const declared = ROOT_PKG.engines?.node ?? null;
    const declaredMajor = declaredNodeMajor(declared);

    if (typeof workerThreads.markAsUncloneable !== 'function') {
        record(name, 'failed', `${process.version} lacks worker_threads.markAsUncloneable`);
        console.log(
            indent(
                [
                    'jsdom cannot start on this Node: undici (via jsdom, via vitest) requires',
                    'node:worker_threads.markAsUncloneable at import time.',
                    '',
                    'The symptom if you run vitest directly is NOT an obvious version error — it is',
                    '  TypeError: webidl.util.markAsUncloneable is not a function',
                    'and a summary reporting that every collected test passed, with the DOM specs',
                    'silently missing from the total.',
                    '',
                    // The range, never a bare major. "Use Node >=22" was advice this
                    // repository does not honour — 22.0 through 22.22.1 satisfy it and are
                    // outside engines.node — so the one line telling a stuck cloner what to
                    // install is quoted from the declaration rather than restated near it.
                    declared
                        ? `Use a Node version satisfying engines.node "${declared}".`
                        : `Use Node >=${VERIFIED_NODE_MAJOR}; this repository declares no engines.node to satisfy.`,
                ].join('\n'),
            ),
        );
        return;
    }
    if (declaredMajor === null) {
        record(name, 'unverified', `cannot read a minimum major out of engines.node "${declared}"`);
        return;
    }
    if (declaredMajor < VERIFIED_NODE_MAJOR) {
        record(
            name,
            'failed',
            `package.json declares node "${declared}", but the DOM specs need >=${VERIFIED_NODE_MAJOR}`,
        );
        return;
    }
    record(name, 'ok', `${process.version}, engines.node "${declared}"`);
}

// The lockfile carries its own copy of the root version and engine range, and npm
// only rewrites them when it is run — so a version bump that touches package.json
// alone leaves the two disagreeing, silently and indefinitely. This repository asks
// a cloner to trust that its stated contracts are enforced rather than claimed, and
// the file npm actually installs from is a poor place to start breaking that.
//
// Deliberately NOT a full "is the dependency tree in sync" check: that needs the
// network and npm's own resolver. This compares the two fields a human edits, which
// are the two that have actually drifted. `npm install --package-lock-only` fixes it.
function checkLockfileParity() {
    const name = 'root package-lock.json agrees with package.json (version, engines)';
    const lockPath = join(ROOT, 'package-lock.json');
    if (!existsSync(lockPath)) {
        record(name, 'unverified', 'no package-lock.json at the repository root');
        return;
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const rootEntry = lock.packages?.[''] ?? {};
    const disagreements = [
        ['version', ROOT_PKG.version, lock.version],
        ['packages[""].version', ROOT_PKG.version, rootEntry.version],
        ['packages[""].engines.node', ROOT_PKG.engines?.node ?? null, rootEntry.engines?.node ?? null],
    ].filter(([, expected, found]) => expected !== found);

    if (disagreements.length > 0) {
        const detail = disagreements
            .map(([field, expected, found]) => `${field}: lock has "${found}", package.json has "${expected}"`)
            .join('; ');
        record(name, 'failed', detail);
        console.log(indent('Fix: npm install --package-lock-only'));
        return;
    }
    record(name, 'ok', `v${ROOT_PKG.version}, node "${ROOT_PKG.engines?.node}"`);
}

// ── Is the Node range we ADVERTISE one the locked tree actually supports? ────
//
// A different question from checkNodeRuntime(), which asks whether THIS Node can run
// the tests. This one asks whether the range in package.json is a promise the
// dependencies keep.
//
// INVARIANT: every Node version engines.node admits is admitted by every locked
// dependency too, and a range this cannot parse is reported UNCHECKED rather than
// treated as satisfied.
// Breaking it: an --engine-strict install fails for a first-time cloner before any
// check here can explain why. See docs/design-notes.md#a-node-range-the-dependencies-never-promised.
//
// The containment question is `semver.subset(ours, theirs)` — node-semver's own, the
// same implementation npm resolves with. It used to be sixty lines of range algebra
// here that understood `^`, `>=` and `||` and refused everything else; what that cost,
// and the one comparison it silently got wrong, is in
// docs/design-notes.md#two-algorithms-the-gates-had-no-business-owning.
//
// Two things the version below still has to decide for itself, because they are policy
// rather than semantics:
//   - an UNPARSEABLE range is reported unverified, never treated as satisfied. That is
//     the whole reason validRange() is called before subset() rather than catching a
//     throw: a gate that turns "I could not tell" into a pass is worse than no gate.
//   - a range that does not fit is reported per package, with the fix, because the
//     useful output is "which dependency, and what does it need".
function nodeRangeFitsWithin(ours, theirs) {
    // subset() throws on a range it cannot parse, and both are checked by the callers,
    // so a throw here means an input shape node-semver accepts as valid and cannot
    // compare. That is a case to report, not to swallow into either verdict.
    try {
        return semver.subset(ours, theirs) ? 'fits' : 'wider';
    } catch {
        return 'unknown';
    }
}

// The decision, separated from the files it normally reads so that --selftest can
// drive it on inputs no lockfile here contains. Returns exactly what record() takes,
// plus the extra lines to print underneath.
function engineRangeVerdict(declared, lockPackages) {
    if (!semver.validRange(declared)) {
        return { state: 'unverified', detail: `cannot parse engines.node "${declared}"`, lines: [] };
    }

    const tooWideFor = [];
    const unparsed = [];
    let compared = 0;
    for (const [path, meta] of Object.entries(lockPackages)) {
        if (!path) continue; // the root entry is us, not a dependency
        const range = meta.engines?.node;
        if (!range) continue;
        // Both arms end up unverified, and deliberately so: a range node-semver rejects
        // and a pair it accepts but cannot compare are the same thing to this check —
        // a dependency whose promise it did not manage to read.
        if (!semver.validRange(range) || nodeRangeFitsWithin(declared, range) === 'unknown') {
            unparsed.push(`${path} ("${range}")`);
            continue;
        }
        compared += 1;
        if (nodeRangeFitsWithin(declared, range) === 'wider') {
            tooWideFor.push(`${path.replace(/^node_modules\//, '')} needs ${range}`);
        }
    }

    if (tooWideFor.length > 0) {
        return {
            state: 'failed',
            detail: `"${declared}" is wider than ${tooWideFor.length} locked package(s) allow`,
            lines: [
                ...tooWideFor.slice(0, 6),
                ...(tooWideFor.length > 6 ? [`… and ${tooWideFor.length - 6} more`] : []),
                'Fix: narrow engines.node in the root and every project, then npm install --package-lock-only',
            ],
        };
    }
    // Reported AFTER a failure, never instead of one: a range that is provably too wide
    // is a fact, and one unreadable dependency elsewhere does not make it less of one.
    if (unparsed.length > 0) {
        return {
            state: 'unverified',
            detail: `${unparsed.length} range(s) this check cannot parse: ${unparsed.join(', ')}`,
            lines: [],
        };
    }
    return { state: 'ok', detail: `"${declared}" fits within all ${compared} declared range(s)`, lines: [] };
}

function checkEngineRange() {
    const name = 'engines.node is a range the locked dependencies support';
    const declared = ROOT_PKG.engines?.node ?? null;
    const lockPath = join(ROOT, 'package-lock.json');
    if (!declared || !existsSync(lockPath)) {
        record(name, 'unverified', declared ? 'no package-lock.json to compare against' : 'no engines.node declared');
        return;
    }
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const { state, detail, lines } = engineRangeVerdict(declared, lock.packages ?? {});
    record(name, state, detail);
    for (const line of lines) console.log(indent(line));
}

// ── The per-project checks ───────────────────────────────────────────────────

// A cloner reads the package.json of the project they cloned, not the one at the
// root, so the two must not drift. This is the same reasoning as the manifest /
// package.json version parity check above it: a promise made in two places is a
// promise that will eventually be made twice, differently.
function checkEnginesParity(project) {
    const name = `${project.id}: engines.node matches the repository root`;
    const projectRange = project.pkg.engines?.node ?? null;
    const rootRange = ROOT_PKG.engines?.node ?? null;
    if (projectRange === rootRange) {
        record(name, 'ok', `"${projectRange}"`, { project: project.id });
        return;
    }
    record(name, 'failed', `project declares "${projectRange}", root declares "${rootRange}"`, {
        project: project.id,
    });
}

function specFiles(dir) {
    const found = [];
    const walk = (path) => {
        if (!existsSync(path)) return;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            const full = join(path, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.spec.ts')) found.push(full);
        }
    };
    walk(join(dir, 'tests'));
    return found;
}


// Runs the unit tests AND checks that the run covered every spec file on disk.
//
// "vitest exited 0" is a weaker statement than it looks. A spec file that fails
// to be COLLECTED — a broken test environment, a syntax error in an import, a
// renamed glob that no longer matches — does not appear in the totals at all, so
// the summary reads `Test Files 2 passed (2)` and the exit status is 0 while a
// third of the suite has silently not run. Counting the files on disk is the only
// side of that comparison the test runner cannot get wrong.
function checkUnitTests(project) {
    const name = `${project.id}: unit tests (every spec file collected)`;
    const bin = join(LOCAL_BIN, 'vitest');
    if (!existsSync(bin)) {
        record(name, 'unverified', 'node_modules/.bin/vitest is missing — run: npm install', { project: project.id });
        return;
    }
    const onDisk = specFiles(project.dir);
    if (onDisk.length === 0) {
        record(name, 'unverified', 'no tests/**/*.spec.ts files exist', { project: project.id });
        return;
    }

    const proc = spawnSync(bin, ['run', '--reporter=dot'], { cwd: project.dir, encoding: 'utf8', shell: false });
    if (proc.error) {
        record(name, 'unverified', `could not run vitest: ${proc.error.message}`, { project: project.id });
        return;
    }
    const output = stripAnsi(`${proc.stdout ?? ''}${proc.stderr ?? ''}`);
    if (proc.status !== 0) {
        record(name, 'failed', `vitest exited ${proc.status}`, { project: project.id });
        console.log(indent(output.trim()));
        return;
    }

    const filesLine = /Test Files\s+(.*)$/m.exec(output);
    const total = filesLine ? Number(/\((\d+)\)\s*$/.exec(filesLine[1])?.[1] ?? NaN) : NaN;
    const passed = filesLine ? Number(/(\d+) passed/.exec(filesLine[1])?.[1] ?? NaN) : NaN;
    const testsLine = /Tests\s+(.*)$/m.exec(output);

    if (!Number.isFinite(total) || !Number.isFinite(passed)) {
        // Vitest changed its summary format, or printed none. Either way this
        // check no longer knows what it read, and saying so beats guessing.
        record(name, 'unverified', 'could not parse vitest\'s "Test Files" summary line', { project: project.id });
        return;
    }
    if (total !== onDisk.length || passed !== onDisk.length) {
        record(
            name,
            'failed',
            `${onDisk.length} spec file(s) on disk, vitest reported ${passed} passed of ${total}`,
            { project: project.id },
        );
        console.log(indent(`on disk: ${onDisk.map((f) => relative(project.dir, f)).join(', ')}`));
        console.log(indent(output.trim()));
        return;
    }
    record(name, 'ok', `${passed}/${onDisk.length} spec file(s), ${testsLine?.[1]?.trim() ?? 'tests ?'}`, {
        project: project.id,
    });
}

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
// manifest rather than hardcoded, because the projects ship different sets
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

// ── Self-test ────────────────────────────────────────────────────────────────
//
// Every other gate in this repository proves it still detects; this file did not, and
// it is the file that decides whether anything else ran. The gap mattered most for the
// range comparison, whose stated invariant is that a range it cannot read comes back
// UNVERIFIED — the one outcome no happy-path run ever exercises, and the one whose
// failure looks exactly like a pass.
//
// Scope, deliberately narrow: the range decision and the minimum-major reading, which
// are the parts with logic. The rest of this file spawns builds and test runs, and a
// self-test that shelled out to those would be the preflight run itself.
//
// Not a conformance suite for node-semver. Every case below is a decision THIS file
// makes on top of it: which state a verdict maps to, and which end of a `||` range the
// DOM-spec floor is compared against.
function selftest() {
    const quiet = process.argv.includes('--quiet');
    const cases = [];
    const check = (label, passed, detail) => {
        cases.push({ label, passed });
        if (!quiet || !passed) console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${passed ? '' : ` — ${detail}`}`);
    };

    const lock = (ranges) => Object.fromEntries(ranges.map((range, i) => [`node_modules/p${i}`, { engines: { node: range } }]));
    const verdict = (declared, ranges) => engineRangeVerdict(declared, lock(ranges));

    const fits = verdict('^22.22.2 || ^24.15.0 || >=26.0.0', ['>=10', '>=18', '^22 || ^24 || >=26']);
    check('accepts a range every dependency admits', fits.state === 'ok', `got ${fits.state}: ${fits.detail}`);

    // The case the check exists for. `>=22` admits 23, and a dependency that stops at 22
    // does not — so an --engine-strict install breaks for a cloner on 23.
    const wider = verdict('>=22', ['^22']);
    check(
        'fails a range wider than a dependency allows, and names it',
        wider.state === 'failed' && wider.lines.some((line) => line.includes('p0 needs ^22')),
        `got ${wider.state}: ${wider.detail}`,
    );

    // The invariant. Not "ok", not "failed" — the third state, or the gate is lying.
    const badOurs = verdict('twenty-two or later', ['>=10']);
    check(
        'reports an unreadable declared range UNVERIFIED, not satisfied',
        badOurs.state === 'unverified' && badOurs.detail.includes('cannot parse'),
        `got ${badOurs.state}: ${badOurs.detail}`,
    );

    const badTheirs = verdict('^22.22.2', ['>=10', 'whatever node you like']);
    check(
        'reports an unreadable dependency range UNVERIFIED, and names the package',
        badTheirs.state === 'unverified' && badTheirs.detail.includes('node_modules/p1'),
        `got ${badTheirs.state}: ${badTheirs.detail}`,
    );

    // A failure outranks an unreadable neighbour. Reversing these two returns would turn
    // a provable break into "inconclusive" as soon as one dependency was unparseable.
    const bothWrong = verdict('>=22', ['^22', 'nonsense']);
    check(
        'reports a provable break as FAILED even beside a range it cannot read',
        bothWrong.state === 'failed',
        `got ${bothWrong.state}: ${bothWrong.detail}`,
    );

    // A dependency with no engines field promises nothing, so it is not a comparison.
    // Counting it would inflate the number this check reports as evidence.
    const silent = engineRangeVerdict('^22.22.2', {
        '': { engines: { node: 'ignored — this entry is us' } },
        'node_modules/a': {},
        'node_modules/b': { engines: { node: '>=10' } },
    });
    check(
        'counts only the dependencies that declare a range',
        silent.state === 'ok' && silent.detail.includes('all 1 declared'),
        `got ${silent.state}: ${silent.detail}`,
    );

    // The lowest major the range admits, whatever order the branches are written in.
    // The regex this replaced read the FIRST number in the string, which is the lowest
    // only by convention — and the DOM-spec floor is compared against it.
    check(
        'reads the minimum major from a reordered range',
        declaredNodeMajor('>=26.0.0 || ^22.22.2') === 22,
        `got ${declaredNodeMajor('>=26.0.0 || ^22.22.2')}`,
    );
    check(
        'reads no major at all out of a range it cannot parse',
        declaredNodeMajor('twenty-two') === null,
        `got ${declaredNodeMajor('twenty-two')}`,
    );

    const failures = cases.filter((c) => !c.passed);
    console.log(
        failures.length === 0
            ? `preflight selftest: all ${cases.length} case(s) behaved as required`
            : `preflight selftest: ${failures.length} case(s) WRONG`,
    );
    process.exit(failures.length === 0 ? 0 : 1);
}

// ── Verdict ──────────────────────────────────────────────────────────────────

// A project that produced NO result of any kind is not a pass. This is the shape
// the repository's own history of silent gates keeps taking: the outer loop
// reports a total, and nobody notices the total is over an empty set. Recorded
// before the tally, so it counts.
//
// An UNVERIFIED result counts as a result: a numbered directory that is not yet
// a project (a new rung, before it has a package.json) already says so above, and that is
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
