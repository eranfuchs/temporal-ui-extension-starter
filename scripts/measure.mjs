#!/usr/bin/env node
// Measures the repository: lines of source, lines of tests, bundle sizes, and the
// third-party packages that actually enter each bundle.
//
// It exists so that "this got simpler" is a number somebody else can reproduce
// rather than an impression. Deleting a hundred lines of hand-written queue and
// adding a dependency that bundles forty kilobytes is a trade, and a report that
// shows only one side of it is an advert.
//
// Usage
//   node scripts/measure.mjs            human-readable table
//   node scripts/measure.mjs --json     the same numbers, machine-readable
//
// Exit status: 0 measured, 2 could not measure (which is not the same as zero).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { analyseBundles } from './bundle.mjs';
import { discoverProjects, ROOT } from './projects.mjs';

const SKIP = new Set(['node_modules', 'dist', '.git', '.vite', '.idea']);
const TEXT = /\.(ts|tsx|mjs|js|json|css|html|md)$/;

function* filesUnder(dir) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) yield* filesUnder(full);
        else yield full;
    }
}

// Lines, not bytes: the question is how much there is to read. A file with no
// trailing newline still ends a line, so count separators plus one unless empty.
function measureTree(dir) {
    let files = 0;
    let lines = 0;
    for (const file of filesUnder(dir)) {
        if (!TEXT.test(file)) continue;
        const text = readFileSync(file, 'utf8');
        files++;
        if (text.length > 0) lines += text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    }
    return { files, lines };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}kb`;

// The version and license of the copy esbuild actually inlined, read from the package
// directory the metafile pointed at. UNKNOWN rather than a guess: a dependency card
// that states a license nobody read is worse than one that says it could not find it.
function describePackage(projectDir, relativeRoot) {
    try {
        const pkg = JSON.parse(readFileSync(join(projectDir, relativeRoot, 'package.json'), 'utf8'));
        return { version: pkg.version ?? 'UNKNOWN', license: pkg.license ?? 'UNKNOWN' };
    } catch {
        return { version: 'UNKNOWN', license: 'UNKNOWN' };
    }
}

// One row per third-party package in a project's bundles: what it is, where it came
// from, which bundles carry it and what it costs each of them. This is the shape the
// per-stage dependency cards in the READMEs are written from, so that a card and this
// command cannot disagree without one of them being edited.
function describeBundledPackages(projectDir, bundles) {
    const rows = [];
    for (const name of bundles.bundled) {
        const root = bundles.packageRoots.get(name);
        const inBundles = bundles.entries
            .filter((entry) => (entry.thirdPartyBytes.get(name) ?? 0) > 0)
            .map((entry) => ({ output: entry.output, bytes: entry.thirdPartyBytes.get(name) }));
        rows.push({
            name,
            ...describePackage(projectDir, root ?? ''),
            reachedBy: bundles.direct.includes(name) ? 'imported by our code' : 'pulled in by another package',
            importedBy: (bundles.importedBy.get(name) ?? []).slice(0, 4),
            inBundles,
            // Summed across bundles, because a content script and a MAIN-world script
            // each carry their own copy: two bundles importing the same package is twice
            // the bytes on disk, and a per-bundle-only figure hides that.
            totalBytes: inBundles.reduce((sum, entry) => sum + entry.bytes, 0),
        });
    }
    return rows;
}

async function main(argv) {
    const asJson = argv.includes('--json');
    const projects = discoverProjects().filter((project) => !project.incomplete);
    if (projects.length === 0) {
        console.error('measure: no complete project found — nothing measured.');
        return 2;
    }

    const report = { projects: {}, tooling: measureTree(join(ROOT, 'scripts')) };
    let unmeasured = 0;

    for (const project of projects) {
        const src = measureTree(join(project.dir, 'src'));
        const tests = measureTree(join(project.dir, 'tests'));
        const bundles = await analyseBundles(project.dir);
        if (!bundles.ok) unmeasured++;
        report.projects[project.id] = {
            version: project.pkg.version,
            src,
            tests,
            declared: Object.keys(project.pkg.dependencies ?? {}),
            bundles: bundles.ok
                ? {
                      entries: bundles.entries.map(({ entry, output, bytes, mapBytes }) => ({ entry, output, bytes, mapBytes })),
                      totalBytes: bundles.entries.reduce((sum, entry) => sum + entry.bytes, 0),
                      direct: bundles.direct,
                      transitive: bundles.transitive,
                      inputCount: bundles.inputCount,
                      thirdPartyInputCount: bundles.thirdPartyInputCount,
                      packages: describeBundledPackages(project.dir, bundles),
                  }
                : { error: bundles.why },
        };
    }

    if (asJson) {
        console.log(JSON.stringify(report, null, 2));
        return unmeasured > 0 ? 2 : 0;
    }

    for (const [id, data] of Object.entries(report.projects)) {
        console.log(`\n${id}  v${data.version}`);
        console.log(`  src           ${String(data.src.lines).padStart(6)} lines in ${data.src.files} files`);
        console.log(`  tests         ${String(data.tests.lines).padStart(6)} lines in ${data.tests.files} files`);
        if (data.bundles.error) {
            console.log(`  bundles       NOT MEASURED — ${data.bundles.error}`);
            continue;
        }
        for (const entry of data.bundles.entries) {
            console.log(`  ${entry.output.padEnd(24)} ${kb(entry.bytes).padStart(9)}   from ${entry.entry}`);
        }
        console.log(`  bundled total ${kb(data.bundles.totalBytes).padStart(9)} (source maps excluded)`);
        console.log(`  direct deps in bundles:     ${data.bundles.direct.join(', ') || 'none'}`);
        console.log(`  transitive deps in bundles: ${data.bundles.transitive.join(', ') || 'none'}`);
        console.log(
            `  bundle inputs: ${data.bundles.inputCount} (${data.bundles.thirdPartyInputCount} from node_modules)`,
        );
        for (const pkg of data.bundles.packages) {
            const where = pkg.inBundles.map((entry) => `${entry.output} ${kb(entry.bytes)}`).join(' · ');
            console.log(`    ${pkg.name} v${pkg.version} (${pkg.license}) — ${where}`);
            console.log(`      ${kb(pkg.totalBytes)} across ${pkg.inBundles.length} bundle(s), ${pkg.reachedBy}`);
        }
    }
    console.log(`\nrepository tooling (scripts/): ${report.tooling.lines} lines in ${report.tooling.files} files`);
    if (unmeasured > 0) {
        console.error(`\nmeasure: ${unmeasured} project(s) could not be measured — treat those numbers as absent, not zero.`);
        return 2;
    }
    console.log(`\nmeasured ${Object.keys(report.projects).length} project(s) under ${relative(process.cwd(), ROOT) || '.'}`);
    return 0;
}

process.exit(await main(process.argv.slice(2)));
