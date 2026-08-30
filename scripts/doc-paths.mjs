#!/usr/bin/env node
// Doc gate — every path and every command a Markdown file names must exist.
//
// WHY: this is the failure mode that produces a confident, wrong answer months
// later. A README says "see src/inject.ts"; the file moves into a project
// directory; the sentence still reads fine and nothing fails. Someone follows it,
// finds nothing, and concludes the feature was removed. The three projects in
// this repository were created by MOVING every source file at once, so every path
// in every document was wrong simultaneously — which is what made a gate cheaper
// than proofreading.
//
// It checks three things, and nothing else:
//
//   1. Markdown links — [text](target) — for local targets.
//   2. Backticked path-looking strings, e.g. `src/tree.ts`, resolved against the
//      document's own directory, the repository root, AND each project directory.
//      Three bases because docs/how-it-works.md deliberately writes paths
//      relative to "a project directory": the mechanism is identical in all of
//      them, so naming one would be misleading.
//   3. Backticked `npm run <script>` commands, against every package.json in the
//      repository. A renamed script is the same silent rot as a moved file.
//
// What it deliberately does NOT check: prose. A doc can claim anything about
// behaviour and this gate will not notice — see `npm run surface` and the unit
// specs for the claims that ARE enforced. It also cannot check a NUMBER, which is
// why counts should not be written into prose at all: name the command that
// prints the number instead.
//
// Usage
//   node scripts/doc-paths.mjs              check the repository
//   node scripts/doc-paths.mjs --dir <p>    check a different tree (for tests)
//   node scripts/doc-paths.mjs --selftest   prove the gate still detects
//
// Exit status: 0 clean, 1 findings, 2 could not check — including having no
// Markdown to read.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverProjects, ROOT } from './projects.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.idea']);

// Paths that legitimately do not exist in a fresh clone. Citing them is correct;
// requiring them to be present is not.
//   dist/            — produced by `npm run build`
//   leakgate.local.txt — gitignored by design; a fork may not have one
const NOT_YET_PRESENT = [/(^|\/)dist(\/|$)/, /(^|\/)leakgate\.local\.txt$/, /(^|\/)node_modules(\/|$)/];

function markdownFiles(root) {
    const found = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.md$/i.test(entry.name)) found.push(full);
        }
    };
    walk(root);
    return found;
}

// A backticked string worth checking: it looks like a relative path, and it is
// not a command, a URL, a glob or a template.
function looksLikePath(text) {
    if (!text.includes('/')) return false;
    if (/\s/.test(text)) return false; // a command line, not a path
    if (text.includes('://')) return false; // a URL
    if (/[{}<>*?"'`|$]/.test(text)) return false; // a template or a glob
    if (text.startsWith('/')) return false; // an API route, not a file
    if (/^[a-z]+:/i.test(text)) return false; // a scheme (mailto:, chrome:)
    // A scoped npm package — `@types/chrome`, `@temporalio/client`. Found by this
    // gate's first real run, which flagged two mentions of a package this project
    // deliberately does NOT depend on. Resolving those against node_modules would
    // be worse than skipping them: the check would pass or fail depending on
    // whether someone had installed the thing the sentence says to avoid.
    if (text.startsWith('@')) return false;
    return /\/[\w.-]*$/.test(text);
}

function isExempt(path) {
    return NOT_YET_PRESENT.some((re) => re.test(path));
}

function main(argv) {
    const dirIdx = argv.indexOf('--dir');
    const root = dirIdx >= 0 ? resolve(argv[dirIdx + 1]) : ROOT;
    const quiet = argv.includes('--quiet');

    const docs = markdownFiles(root);
    if (docs.length === 0) {
        console.error(`doc-paths: no Markdown files under ${root} — nothing to check.`);
        console.error('doc-paths: treat this as UNVERIFIED, not clean.');
        return 2;
    }

    // Every base a relative path in a doc might sensibly be written against.
    const projectDirs = discoverProjects(root).map((project) => project.dir);

    // Every npm script the repository actually defines.
    const scripts = new Set();
    for (const packagePath of [join(root, 'package.json'), ...projectDirs.map((dir) => join(dir, 'package.json'))]) {
        if (!existsSync(packagePath)) continue;
        try {
            for (const name of Object.keys(JSON.parse(readFileSync(packagePath, 'utf8')).scripts ?? {})) {
                scripts.add(name);
            }
        } catch {
            /* a malformed package.json is preflight's problem, not this gate's */
        }
    }

    const findings = [];
    const counted = { links: 0, paths: 0, commands: 0 };

    for (const doc of docs) {
        const where = relative(root, doc);
        const bases = [dirname(doc), root, ...projectDirs];
        const resolvesAnywhere = (path) => bases.some((base) => existsSync(join(base, path)));

        readFileSync(doc, 'utf8').split('\n').forEach((line, index) => {
            const at = `${where}:${index + 1}`;

            // 1. Markdown links.
            const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
            let link;
            while ((link = linkRe.exec(line)) !== null) {
                let target = link[1];
                if (/^(https?|mailto|chrome|chrome-extension):/i.test(target)) continue;
                if (target.startsWith('#')) continue;
                target = target.split('#')[0];
                if (!target) continue;
                counted.links++;
                if (isExempt(target)) continue;
                if (!existsSync(join(dirname(doc), target))) {
                    findings.push(`${at}: link target does not exist: ${target}`);
                }
            }

            // 2. Backticked paths.
            const codeRe = /`([^`]+)`/g;
            let code;
            while ((code = codeRe.exec(line)) !== null) {
                const text = code[1];

                // 3. npm scripts, from the same backticks.
                const command = /^npm (?:run |run-script )?([\w:-]+)$/.exec(text);
                if (command) {
                    const name = command[1];
                    // `npm install` / `npm test` are npm's own, not ours.
                    if (name !== 'install' && name !== 'ci') {
                        counted.commands++;
                        if (name !== 'test' && !scripts.has(name)) {
                            findings.push(`${at}: names \`npm run ${name}\`, which no package.json defines`);
                        }
                    }
                    continue;
                }

                if (!looksLikePath(text)) continue;
                const path = text.replace(/\/$/, '');
                counted.paths++;
                if (isExempt(path)) continue;
                if (!resolvesAnywhere(path)) {
                    findings.push(`${at}: cites a path that exists nowhere: ${text}`);
                }
            }
        });
    }

    if (!quiet) {
        console.log(`doc-paths: read ${docs.length} Markdown file(s) under ${relative(ROOT, root) || '.'}`);
        console.log(`  links checked: ${counted.links}`);
        console.log(`  backticked paths checked: ${counted.paths}`);
        console.log(`  npm commands checked: ${counted.commands}`);
    }

    if (findings.length > 0) {
        console.error(`\ndoc-paths: ${findings.length} finding(s)\n`);
        for (const finding of findings) console.error(`  ${finding}`);
        console.error('');
        return 1;
    }

    if (!quiet) {
        console.log(
            `doc-paths: clean — ${counted.links} link(s), ${counted.paths} path(s), ${counted.commands} command(s)`,
        );
    }
    return 0;
}

// ── Self-test ─────────────────────────────────────────────────────────────
function selftest() {
    const dir = mkdtempSync(join(tmpdir(), 'docpaths-selftest-'));
    let failures = 0;
    const check = (name, condition, detail) => {
        console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${condition ? '' : ` — ${detail}`}`);
        if (!condition) failures++;
    };

    // A tree with one project, one real source file, and one npm script.
    const makeTree = (name, markdown) => {
        const treeRoot = join(dir, name);
        mkdirSync(join(treeRoot, '01-a', 'src'), { recursive: true });
        writeFileSync(join(treeRoot, '01-a', 'src', 'tree.ts'), 'export const x = 1;\n');
        writeFileSync(
            join(treeRoot, '01-a', 'package.json'),
            JSON.stringify({ name: '01-a', version: '0.0.0', scripts: { build: 'true' } }),
        );
        writeFileSync(
            join(treeRoot, 'package.json'),
            JSON.stringify({ name: 'root', version: '0.0.0', scripts: { preflight: 'true' } }),
        );
        writeFileSync(join(treeRoot, 'README.md'), markdown);
        return treeRoot;
    };

    const drive = (treeRoot) => run(['--dir', treeRoot, '--quiet']);

    try {
        const good = drive(
            makeTree(
                'good',
                [
                    '# Fixture',
                    '',
                    'See [the project](01-a/) and `src/tree.ts`, built with `npm run build`.',
                    'Root check: `npm run preflight`. Install once: `npm install`.',
                    'Cloud lives at `https://cloud.temporal.io/*` and the API at `/api/v1/namespaces/{ns}/workflows`.',
                    'Sizes: `wc -l src/*.ts`. Load from `chrome://extensions`.',
                    'It needs no `@types/chrome`, and does not depend on `@temporalio/client`.',
                    'The build output `01-a/dist/content.js` does not exist until you build.',
                    '',
                ].join('\n'),
            ),
        );
        check('accepts real paths, real scripts, and non-paths', good.status === 0, good.output.trim());

        const deadLink = drive(makeTree('deadlink', 'See [the guide](docs/missing.md).\n'));
        check(
            'rejects a dead Markdown link',
            deadLink.status === 1 && deadLink.output.includes('docs/missing.md'),
            `exit ${deadLink.status}: ${deadLink.output.trim()}`,
        );

        const movedFile = drive(makeTree('moved', 'The feature lives in `src/gone.ts`.\n'));
        check(
            'rejects a backticked path that exists nowhere',
            movedFile.status === 1 && movedFile.output.includes('src/gone.ts'),
            `exit ${movedFile.status}: ${movedFile.output.trim()}`,
        );

        // The reason for the three-base rule: a doc may write a path relative to
        // a project directory rather than to itself.
        const projectRelative = drive(makeTree('relative', 'Every project has a `src/tree.ts`.\n'));
        check(
            'resolves a path written relative to a project directory',
            projectRelative.status === 0,
            `exit ${projectRelative.status}: ${projectRelative.output.trim()}`,
        );

        const renamedScript = drive(makeTree('script', 'Run `npm run bulid` first.\n'));
        check(
            'rejects an npm script no package.json defines',
            renamedScript.status === 1 && renamedScript.output.includes('bulid'),
            `exit ${renamedScript.status}: ${renamedScript.output.trim()}`,
        );

        // An external link must not be resolved as a local path — otherwise the
        // gate fails on every citation of the Temporal docs.
        const external = drive(
            makeTree('external', 'See [the docs](https://docs.temporal.io/develop) and [the anchor](#idea).\n'),
        );
        check(
            'ignores external links and anchors',
            external.status === 0,
            `exit ${external.status}: ${external.output.trim()}`,
        );

        const empty = join(dir, 'empty');
        mkdirSync(empty, { recursive: true });
        const emptyRun = run(['--dir', empty]);
        check(
            'reports a tree with no Markdown as UNVERIFIED (exit 2), not clean',
            emptyRun.status === 2,
            `exit ${emptyRun.status}: ${emptyRun.output.trim()}`,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(
        failures === 0 ? '\ndoc-paths selftest: all cases behaved as required' : `\ndoc-paths selftest: ${failures} case(s) WRONG`,
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
