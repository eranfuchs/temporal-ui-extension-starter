#!/usr/bin/env node
// Lineage gate — the projects duplicate files on purpose, and this is what
// keeps that duplication honest.
//
// WHY THE DUPLICATION EXISTS
//
// 01, 02 and 03 are separate extensions, each clonable and buildable on its own.
// That is a deliberate choice against the obvious alternative (one shared
// package, three thin wrappers): a reader who wants the family tree should be
// able to copy ONE directory and have a working extension, not discover that the
// interesting part lives two levels up behind an import. The cost is that
// src/family/tree.ts exists three times.
//
// WHAT GOES WRONG WITHOUT A GATE
//
// Someone fixes an ordering bug in 03/src/family/tree.ts. 01 and 02 keep the bug. Now
// the repository teaches three subtly different versions of the same lesson and
// nobody knows which one is right. That failure is silent — every project still
// builds, every test still passes, because each project tests its own copy.
//
// SO: every file that exists in more than one project must be registered in
// scripts/lineage.json, in exactly one of two lists.
//
//   shared — must be byte-identical everywhere it appears. The gate compares
//            bytes and names the first differing line.
//   forks  — allowed to differ, and must say WHY in the registry. The `why` is
//            the deliverable: "01 has no settings, so its render.ts takes no
//            options" is the lesson the repository is built around, and writing
//            it down is what stops a fork from being an accident.
//
// A duplicated file in NEITHER list fails the gate. That is the point — it
// forces "is this supposed to be the same file?" to be answered once, in
// writing, rather than discovered as a bug months later.
//
// Usage
//   node scripts/lineage.mjs                 check the repository
//   node scripts/lineage.mjs --root <path>   check a different tree (for tests)
//   node scripts/lineage.mjs --registry <p>  use a different registry
//   node scripts/lineage.mjs --selftest      prove the gate still detects
//
// Exit status: 0 clean, 1 findings, 2 could not check — which includes having
// fewer than two projects to compare. An empty comparison is UNVERIFIED, not
// clean, the same rule the leak gate follows.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverProjects, ROOT } from './projects.mjs';

// Build output and installed packages are not source and are not compared: a
// project that happens to have been built more recently would otherwise report
// a lineage break in every bundled file.
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.vite', '.idea']);

function filesUnder(dir) {
    const found = [];
    const walk = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(path, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(relative(dir, full).split('\\').join('/'));
        }
    };
    walk(dir);
    return found;
}

// Bytes, not text: an icon is compared the same way a .ts file is, and a
// trailing-newline difference is a real difference.
function firstDifference(pathA, pathB) {
    const a = readFileSync(pathA);
    const b = readFileSync(pathB);
    if (a.equals(b)) return null;
    // For text, the first differing LINE is what a human can act on.
    const textA = a.toString('utf8');
    const textB = b.toString('utf8');
    if (!textA.includes('\0') && !textB.includes('\0')) {
        const linesA = textA.split('\n');
        const linesB = textB.split('\n');
        for (let i = 0; i < Math.max(linesA.length, linesB.length); i++) {
            if (linesA[i] !== linesB[i]) return `first differs at line ${i + 1}`;
        }
    }
    return `differ in bytes (${a.length} vs ${b.length})`;
}

function loadRegistry(path) {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const normalise = (list, kind) =>
        (raw[kind] ?? []).map((entry) => (typeof entry === 'string' ? { path: entry, why: '' } : entry));
    return { shared: normalise(raw, 'shared'), forks: normalise(raw, 'forks') };
}

function main(argv) {
    const rootIdx = argv.indexOf('--root');
    const root = rootIdx >= 0 ? argv[rootIdx + 1] : ROOT;
    const registryIdx = argv.indexOf('--registry');
    const registryPath = registryIdx >= 0 ? argv[registryIdx + 1] : join(ROOT, 'scripts', 'lineage.json');
    const quiet = argv.includes('--quiet');

    if (!existsSync(registryPath)) {
        console.error(`lineage: no registry at ${registryPath}`);
        return 2;
    }

    let registry;
    try {
        registry = loadRegistry(registryPath);
    } catch (err) {
        console.error(`lineage: registry is not valid JSON: ${err.message}`);
        return 2;
    }

    const projects = discoverProjects(root).filter((project) => !project.incomplete);
    if (projects.length < 2) {
        console.error(
            `lineage: ${projects.length} complete project(s) under ${root} — nothing to compare across.`,
        );
        console.error('lineage: treat this as UNVERIFIED, not clean.');
        return 2;
    }

    // path → [project, …], for every file in every project.
    const owners = new Map();
    for (const project of projects) {
        for (const file of filesUnder(project.dir)) {
            if (!owners.has(file)) owners.set(file, []);
            owners.get(file).push(project);
        }
    }

    const findings = [];
    const registered = new Map();
    for (const kind of ['shared', 'forks']) {
        for (const entry of registry[kind]) {
            if (registered.has(entry.path)) {
                findings.push(
                    `${entry.path}: listed in both "shared" and "forks" — the registry contradicts itself`,
                );
                continue;
            }
            registered.set(entry.path, { kind, why: entry.why ?? '' });
        }
    }

    // 1. Every registry entry must have a reason. An unexplained fork is the
    //    thing this gate exists to prevent, and an unexplained "shared" is a
    //    claim nobody can check later.
    for (const [path, { kind, why }] of registered) {
        if (!why.trim()) findings.push(`${path}: registered as "${kind}" with no "why"`);
    }

    // 2. Every registry entry must exist somewhere. A stale entry makes the
    //    registry look more thorough than it is — the exact shape of a gate
    //    quietly checking nothing.
    for (const path of registered.keys()) {
        if (!owners.has(path)) findings.push(`${path}: in the registry but exists in no project`);
    }

    // 3. Every duplicated file must be registered.
    const duplicated = [...owners.entries()].filter(([, list]) => list.length > 1);
    for (const [path, list] of duplicated) {
        if (registered.has(path)) continue;
        findings.push(
            `${path}: exists in ${list.map((p) => p.id).join(' and ')} but is in neither list — ` +
                'add it to scripts/lineage.json as "shared" (must stay identical) or "forks" (may differ, say why)',
        );
    }

    // 4. Shared files must be byte-identical wherever they appear.
    let comparisons = 0;
    for (const [path, { kind }] of registered) {
        if (kind !== 'shared') continue;
        const list = owners.get(path) ?? [];
        if (list.length < 2) continue;
        const reference = list[0];
        for (const other of list.slice(1)) {
            comparisons++;
            const difference = firstDifference(join(reference.dir, path), join(other.dir, path));
            if (difference) {
                findings.push(
                    `${path}: ${reference.id} and ${other.id} are not identical — ${difference}. ` +
                        'Either re-sync them, or move it to "forks" with a reason.',
                );
            }
        }
    }

    // Informational: registered but present in only one project. Not a failure
    // — 03 spends time half-built — but it must be visible, because "0 of 12
    // shared files compared" and "12 compared" are the same green tick
    // otherwise.
    const singletons = [...registered.keys()].filter((path) => (owners.get(path) ?? []).length === 1);

    if (!quiet) {
        console.log(`lineage: compared ${projects.map((p) => p.id).join(', ')}`);
        console.log(`  files present in more than one project: ${duplicated.length}`);
        console.log(`  registered: ${registry.shared.length} shared, ${registry.forks.length} fork(s)`);
        console.log(`  byte comparisons made: ${comparisons}`);
        if (singletons.length > 0) {
            console.log(`  registered but in only one project (nothing to compare): ${singletons.length}`);
            for (const path of singletons) console.log(`    ${path} — only in ${owners.get(path)[0].id}`);
        }
    }

    if (findings.length > 0) {
        console.error(`\nlineage: ${findings.length} finding(s)\n`);
        for (const finding of findings) console.error(`  ${finding}`);
        console.error('');
        return 1;
    }

    // The counts are part of the verdict. "Clean" over zero comparisons is the
    // sentence every silently-broken gate in this repository's ancestry printed.
    if (!quiet) {
        console.log(
            `lineage: clean — ${comparisons} comparison(s) across ${duplicated.length} duplicated file(s)`,
        );
    }
    return 0;
}

// ── Self-test ─────────────────────────────────────────────────────────────
// Drives the real gate, as a subprocess, against a case it must reject and a
// case it must accept. Each known-bad fixture breaks exactly one rule, because
// a fixture that breaks two cannot tell you which rule stopped working.
function selftest() {
    const dir = mkdtempSync(join(tmpdir(), 'lineage-selftest-'));
    let failures = 0;
    const check = (name, condition, detail) => {
        console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${condition ? '' : ` — ${detail}`}`);
        if (!condition) failures++;
    };

    // A throwaway two-project tree. `files` maps a relative path to contents.
    const makeTree = (name, projects, registry) => {
        const treeRoot = join(dir, name);
        for (const [projectId, files] of Object.entries(projects)) {
            for (const [path, contents] of Object.entries(files)) {
                const full = join(treeRoot, projectId, path);
                mkdirSync(join(full, '..'), { recursive: true });
                writeFileSync(full, contents);
            }
            const pkg = join(treeRoot, projectId, 'package.json');
            if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: projectId, version: '0.0.0' }));
        }
        const registryPath = join(treeRoot, 'lineage.json');
        writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        return { root: treeRoot, registryPath };
    };

    const drive = (tree, extra = []) => run(['--root', tree.root, '--registry', tree.registryPath, ...extra]);

    try {
        // KNOWN-GOOD: an identical shared file, plus a fork that differs and says why.
        const good = makeTree(
            'good',
            {
                '01-a': { 'src/family/tree.ts': 'export const same = 1;\n', 'src/content.ts': 'const a = 1;\n' },
                '02-b': { 'src/family/tree.ts': 'export const same = 1;\n', 'src/content.ts': 'const b = 2;\n' },
            },
            {
                shared: [{ path: 'src/family/tree.ts', why: 'the feature' }],
                forks: [{ path: 'src/content.ts', why: 'wiring differs by design' }, { path: 'package.json', why: 'per-project name' }],
            },
        );
        const goodRun = drive(good);
        check('accepts identical shared files and an explained fork', goodRun.status === 0, `exit ${goodRun.status}: ${goodRun.output.trim()}`);
        check('  reports how many comparisons it actually made', /1 comparison/.test(goodRun.output), goodRun.output.trim());

        // KNOWN-BAD 1: a shared file that drifted. The whole reason the gate exists.
        const drifted = makeTree(
            'drifted',
            {
                '01-a': { 'src/family/tree.ts': 'export const same = 1;\n' },
                '02-b': { 'src/family/tree.ts': 'export const same = 2;\n' },
            },
            { shared: [{ path: 'src/family/tree.ts', why: 'the feature' }], forks: [{ path: 'package.json', why: 'per-project name' }] },
        );
        const driftedRun = drive(drifted);
        check(
            'rejects a shared file that drifted',
            driftedRun.status === 1 && driftedRun.output.includes('not identical'),
            `exit ${driftedRun.status}: ${driftedRun.output.trim()}`,
        );
        check('  names the first differing line', driftedRun.output.includes('line 1'), driftedRun.output.trim());

        // KNOWN-BAD 2: duplicated in neither list. The silent case — both copies
        // are fine today, and nobody has decided whether they may diverge.
        const unregistered = makeTree(
            'unregistered',
            {
                '01-a': { 'src/family/rows.ts': 'export const x = 1;\n' },
                '02-b': { 'src/family/rows.ts': 'export const x = 1;\n' },
            },
            { shared: [], forks: [{ path: 'package.json', why: 'per-project name' }] },
        );
        const unregisteredRun = drive(unregistered);
        check(
            'rejects a duplicated file that is in neither list',
            unregisteredRun.status === 1 && unregisteredRun.output.includes('src/family/rows.ts'),
            `exit ${unregisteredRun.status}: ${unregisteredRun.output.trim()}`,
        );

        // KNOWN-BAD 3: a registry entry pointing at nothing.
        const stale = makeTree(
            'stale',
            { '01-a': { 'src/family/tree.ts': 'a\n' }, '02-b': { 'src/family/tree.ts': 'a\n' } },
            {
                shared: [{ path: 'src/family/tree.ts', why: 'the feature' }, { path: 'src/gone.ts', why: 'deleted last week' }],
                forks: [{ path: 'package.json', why: 'per-project name' }],
            },
        );
        const staleRun = drive(stale);
        check(
            'rejects a registry entry that exists in no project',
            staleRun.status === 1 && staleRun.output.includes('src/gone.ts'),
            `exit ${staleRun.status}: ${staleRun.output.trim()}`,
        );

        // KNOWN-BAD 4: the same path in both lists — "identical" and "may differ"
        // at once. Reading order would decide which rule applies, silently.
        const both = makeTree(
            'both',
            { '01-a': { 'src/family/tree.ts': 'a\n' }, '02-b': { 'src/family/tree.ts': 'b\n' } },
            {
                shared: [{ path: 'src/family/tree.ts', why: 'the feature' }],
                forks: [{ path: 'src/family/tree.ts', why: 'also a fork, apparently' }, { path: 'package.json', why: 'per-project name' }],
            },
        );
        const bothRun = drive(both);
        check(
            'rejects a path listed as both shared and fork',
            bothRun.status === 1 && bothRun.output.includes('contradicts itself'),
            `exit ${bothRun.status}: ${bothRun.output.trim()}`,
        );

        // KNOWN-BAD 5: a fork with no reason. The registry's value is the reason;
        // an empty one turns the gate into a rubber stamp you can silence by
        // adding a line.
        const unexplained = makeTree(
            'unexplained',
            { '01-a': { 'src/content.ts': 'a\n' }, '02-b': { 'src/content.ts': 'b\n' } },
            { shared: [], forks: [{ path: 'src/content.ts', why: '' }, { path: 'package.json', why: 'per-project name' }] },
        );
        const unexplainedRun = drive(unexplained);
        check(
            'rejects a fork registered with no reason',
            unexplainedRun.status === 1 && unexplainedRun.output.includes('no "why"'),
            `exit ${unexplainedRun.status}: ${unexplainedRun.output.trim()}`,
        );

        // UNVERIFIED: one project cannot be compared with anything. Must not
        // report clean — a single-project tree trivially satisfies every rule.
        const lonely = makeTree(
            'lonely',
            { '01-a': { 'src/family/tree.ts': 'a\n' } },
            { shared: [{ path: 'src/family/tree.ts', why: 'the feature' }], forks: [] },
        );
        const lonelyRun = drive(lonely);
        check(
            'reports a single-project tree as UNVERIFIED (exit 2), not clean',
            lonelyRun.status === 2,
            `exit ${lonelyRun.status}: ${lonelyRun.output.trim()}`,
        );

        // Build output must be out of scope: 01 building after 02 would otherwise
        // report every bundled file as a lineage break.
        const built = makeTree(
            'built',
            {
                '01-a': { 'src/family/tree.ts': 'a\n', 'dist/content.js': 'built from 01\n', 'node_modules/x/i.js': 'dep\n' },
                '02-b': { 'src/family/tree.ts': 'a\n', 'dist/content.js': 'built from 02, differently\n', 'node_modules/x/i.js': 'dep\n' },
            },
            { shared: [{ path: 'src/family/tree.ts', why: 'the feature' }], forks: [{ path: 'package.json', why: 'per-project name' }] },
        );
        const builtRun = drive(built);
        check(
            'ignores dist/ and node_modules/',
            builtRun.status === 0,
            `exit ${builtRun.status}: ${builtRun.output.trim()}`,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(
        failures === 0 ? '\nlineage selftest: all cases behaved as required' : `\nlineage selftest: ${failures} case(s) WRONG`,
    );
    return failures === 0 ? 0 : 1;
}

function run(args) {
    try {
        const output = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, output };
    } catch (err) {
        return { status: err.status ?? 2, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
}

const argv = process.argv.slice(2);
process.exit(argv.includes('--selftest') ? selftest() : main(argv));
