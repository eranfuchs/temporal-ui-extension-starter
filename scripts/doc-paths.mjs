#!/usr/bin/env node
// Doc gate — every path and every command a Markdown file names must exist.
//
// WHY: this is the failure mode that produces a confident, wrong answer months
// later. A README says "see src/inject.ts"; the file moves into a project
// directory; the sentence still reads fine and nothing fails. Someone follows it,
// finds nothing, and concludes the feature was removed. The projects in
// this repository were created by MOVING every source file at once, so every path
// in every document was wrong simultaneously — which is what made a gate cheaper
// than proofreading.
//
// It checks five things, and nothing else:
//
//   1. Markdown links — [text](target) — for local targets.
//   2. Backticked path-looking strings, e.g. `src/family/tree.ts`, resolved against the
//      document's own directory, the repository root, AND each project directory.
//      Three bases because docs/how-it-works.md deliberately writes paths
//      relative to "a project directory": the mechanism is identical in all of
//      them, so naming one would be misleading.
//   3. Backticked `npm run <script>` commands, against every package.json in the
//      repository. A renamed script is the same silent rot as a moved file.
//   4. The same path citations inside NON-Markdown project files — `public/*.css`
//      comments above all, and the RESPONSIBILITY headers at the top of every
//      source file. Checks 1-3 read Markdown only, and that blind spot was not
//      theoretical: regrouping src/ into lesson directories left eight dead
//      `src/rowInfo.ts`-style citations in two content.css files, which this gate
//      reported clean because it never opened them.
//   5. A quoted spec TITLE against the spec file cited beside it. This is the one
//      check aimed at a citation that RESOLVES and is still wrong: splitting a
//      monolithic spec leaves every old filename in place, so the prose keeps
//      pointing at a real file that no longer holds the claim. Only titles
//      containing whitespace are checked — see the filter for why a single
//      identifier cannot be told apart from ordinary prose.
//
//      ITS LIMIT, MEASURED RATHER THAN GUESSED: re-introducing the two real
//      post-split citation errors this repository had, one was caught and one was
//      not. The one it missed cited a spec and then DESCRIBED it — "which counts
//      requests against a fake network" — without quoting a block, so there is
//      nothing to compare a filename against. Check 5 rewards prose that quotes
//      the block it means; prose that only paraphrases is still on trust.
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

function filesUnder(root, accept) {
    const found = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (accept(entry.name)) found.push(full);
        }
    };
    walk(root);
    return found;
}

const markdownFiles = (root) => filesUnder(root, (name) => /\.md$/i.test(name));

// Temporal payload encodings. They live in a payload's `metadata.encoding` as
// `type/subtype`, and a doc about a codec server cannot discuss them without
// naming them — `binary/encrypted` above all.
//
// Listed one by one rather than matched by shape. "Two words separated by a
// slash" also describes `01-family-tree/dist` and `docs/features`, so exempting
// the shape would blind the gate to every citation of a directory or of a file
// written without its extension — which is most of what it is here to check.
// An encoding not on this list is still checked, and adding one is a deliberate
// edit to this file.
const PAYLOAD_ENCODINGS = new Set([
    'json/plain',
    'json/protobuf',
    'text/plain',
    'binary/plain',
    'binary/null',
    'binary/encrypted',
    'binary/protobuf',
]);

// A backticked string worth checking: it looks like a relative path, and it is
// not a command, a URL, a glob, a template or a payload encoding.
function looksLikePath(text) {
    if (!text.includes('/')) return false;
    if (PAYLOAD_ENCODINGS.has(text)) return false;
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
    const counted = { links: 0, paths: 0, commands: 0, sourcePaths: 0, titles: 0 };

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

    // 4. Path citations inside non-Markdown project files.
    //
    // No backticks to key off here, so the shape has to carry it: a run beginning at
    // one of the repository's own top-level directory names and ending in an
    // extension. That is deliberately narrower than looksLikePath() — a CSS file is
    // full of slashes that are division, and a .ts file is full of import specifiers
    // and URLs. Anchoring on `src/`, `tests/`, `public/`, `docs/` or `scripts/` costs
    // the citations written without one of those prefixes and buys a check with no
    // false positives, which is the trade that makes it runnable in preflight.
    for (const dir of projectDirs) {
        for (const file of filesUnder(dir, (name) => /\.(css|html|ts)$/.test(name))) {
            const where = relative(root, file);
            const bases = [dir, root, dirname(file)];
            readFileSync(file, 'utf8')
                .split('\n')
                .forEach((line, index) => {
                    for (const match of line.matchAll(/\b(?:src|tests|public|docs|scripts)\/[\w./-]*\.\w+/g)) {
                        const path = match[0];
                        counted.sourcePaths++;
                        if (isExempt(path)) continue;
                        if (!bases.some((base) => existsSync(join(base, path)))) {
                            findings.push(`${where}:${index + 1}: cites a path that exists nowhere: ${path}`);
                        }
                    }
                });
        }
    }

    // 5. A quoted spec title against the spec cited beside it.
    const specTitles = new Map();
    for (const dir of projectDirs) {
        for (const spec of filesUnder(dir, (name) => /\.spec\.ts$/.test(name))) {
            for (const match of readFileSync(spec, 'utf8').matchAll(/\b(?:describe|it)\((['"`])([^'"`]+)\1/g)) {
                const title = match[2].replace(/\s+/g, ' ').trim();
                if (!specTitles.has(title)) specTitles.set(title, new Set());
                specTitles.get(title).add(spec);
            }
        }
    }

    for (const doc of docs) {
        const where = relative(root, doc);
        // Paragraphs, because a citation and the title it supports are written in the
        // same breath but rarely on the same line. Fenced blocks are excluded: a fence
        // may legitimately SHOW a describe() next to a different path.
        const paragraphs = [];
        let current = [];
        let inFence = false;
        readFileSync(doc, 'utf8')
            .split('\n')
            .forEach((line, index) => {
                if (/^\s*```/.test(line)) {
                    inFence = !inFence;
                    if (current.length) paragraphs.push(current);
                    current = [];
                    return;
                }
                if (inFence) return;
                if (line.trim() === '') {
                    if (current.length) paragraphs.push(current);
                    current = [];
                } else {
                    current.push({ line, no: index + 1 });
                }
            });
        if (current.length) paragraphs.push(current);

        for (const paragraph of paragraphs) {
            const text = paragraph.map((entry) => entry.line).join('\n');

            // Whitespace-normalised, so a title that WRAPPED across a line still
            // matches the single-spaced title in the spec. That newline is the entire
            // reason the first version of this check reported clean on a real mismatch.
            //
            // And only titles containing whitespace: `codecDecodeCall` is both a
            // describe title and the ordinary way prose refers to the function, so a
            // single identifier cannot be read as a citation of the block. Requiring a
            // sentence-like title is what removed the only two false positives this
            // check has ever produced.
            const quoted = new Set(
                [...text.matchAll(/`([^`]+)`/g)]
                    .map((match) => match[1].replace(/\s+/g, ' ').trim())
                    .filter((title) => specTitles.has(title) && /\s/.test(title)),
            );
            if (quoted.size === 0) continue;

            // Resolved to absolute paths, not compared by suffix: several projects
            // have a `tests/unit/apiInject.spec.ts`, and a suffix match would credit
            // 03 for a block that only 02's copy contains.
            const cited = new Set();
            for (const match of text.matchAll(/[\w./-]*tests\/[\w./-]*\.spec\.ts/g)) {
                for (const base of [dirname(doc), root, ...projectDirs]) {
                    const absolute = resolve(base, match[0].replace(/^\.*\//, ''));
                    if (existsSync(absolute)) {
                        cited.add(absolute);
                        break;
                    }
                }
            }
            if (cited.size === 0) continue;

            for (const title of quoted) {
                counted.titles++;
                const holders = [...specTitles.get(title)];
                if (holders.some((holder) => cited.has(holder))) continue;
                findings.push(
                    `${where}:${paragraph[0].no}: quotes the block "${title}", which lives in ` +
                        `${holders.map((holder) => relative(root, holder)).join(', ')}, beside a citation of ` +
                        `${[...cited].map((entry) => relative(root, entry)).join(', ')}`,
                );
            }
        }
    }

    if (!quiet) {
        console.log(`doc-paths: read ${docs.length} Markdown file(s) under ${relative(ROOT, root) || '.'}`);
        console.log(`  links checked: ${counted.links}`);
        console.log(`  backticked paths checked: ${counted.paths}`);
        console.log(`  npm commands checked: ${counted.commands}`);
        console.log(`  paths cited in source files checked: ${counted.sourcePaths}`);
        console.log(`  quoted spec blocks checked: ${counted.titles} (of ${specTitles.size} known)`);
    }

    if (findings.length > 0) {
        console.error(`\ndoc-paths: ${findings.length} finding(s)\n`);
        for (const finding of findings) console.error(`  ${finding}`);
        console.error('');
        return 1;
    }

    if (!quiet) {
        console.log(
            `doc-paths: clean — ${counted.links} link(s), ${counted.paths} path(s), ${counted.commands} command(s), ` +
                `${counted.sourcePaths} source citation(s), ${counted.titles} spec block(s)`,
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
    const makeTree = (name, markdown, extra = {}) => {
        const treeRoot = join(dir, name);
        // Nested under src/family/, so the fixture exercises the same shape the real
        // projects have: a citation the gate must resolve through a lesson directory
        // rather than straight off src/.
        mkdirSync(join(treeRoot, '01-a', 'src', 'family'), { recursive: true });
        writeFileSync(join(treeRoot, '01-a', 'src', 'family', 'tree.ts'), 'export const x = 1;\n');
        writeFileSync(
            join(treeRoot, '01-a', 'package.json'),
            JSON.stringify({ name: '01-a', version: '0.0.0', scripts: { build: 'true' } }),
        );
        writeFileSync(
            join(treeRoot, 'package.json'),
            JSON.stringify({ name: 'root', version: '0.0.0', scripts: { preflight: 'true' } }),
        );
        writeFileSync(join(treeRoot, 'README.md'), markdown);
        for (const [path, contents] of Object.entries(extra)) {
            const full = join(treeRoot, path);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, contents);
        }
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
                    'See [the project](01-a/) and `src/family/tree.ts`, built with `npm run build`.',
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
        const projectRelative = drive(makeTree('relative', 'Every project has a `src/family/tree.ts`.\n'));
        check(
            'resolves a path written relative to a project directory',
            projectRelative.status === 0,
            `exit ${projectRelative.status}: ${projectRelative.output.trim()}`,
        );

        // The codec docs name payload encodings, which are metadata values, not
        // files. Both halves matter: the listed ones pass, and one that is not
        // listed is still checked — the exemption is a list, not a shape.
        const encodings = drive(
            makeTree('encodings', 'Readable: `json/plain`, `text/plain`, `binary/null`. Not: `binary/encrypted`.\n'),
        );
        check(
            'accepts Temporal payload encodings, which are not paths',
            encodings.status === 0,
            `exit ${encodings.status}: ${encodings.output.trim()}`,
        );

        const unlistedEncoding = drive(makeTree('unlisted', 'Also handles `binary/invented`.\n'));
        check(
            'still checks a type/subtype token that is not a known encoding',
            unlistedEncoding.status === 1 && unlistedEncoding.output.includes('binary/invented'),
            `exit ${unlistedEncoding.status}: ${unlistedEncoding.output.trim()}`,
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

        // ── Check 4: citations inside non-Markdown project files ──────────────
        // The case that motivated it: a CSS comment naming the source file that
        // styles the element it describes, left behind when src/ was regrouped.
        const cssGood = drive(
            makeTree('cssgood', '# Fixture\n', {
                '01-a/public/content.css': '/* Written by src/family/tree.ts. */\n.x { top: 0; }\n',
            }),
        );
        check('accepts a live path cited in a CSS comment', cssGood.status === 0, cssGood.output.trim());

        const cssDead = drive(
            makeTree('cssdead', '# Fixture\n', {
                '01-a/public/content.css': '/* Written by src/rowInfo.ts. */\n.x { top: 0; }\n',
            }),
        );
        check(
            'rejects a dead path cited in a CSS comment, which no Markdown check reads',
            cssDead.status === 1 && cssDead.output.includes('src/rowInfo.ts'),
            `exit ${cssDead.status}: ${cssDead.output.trim()}`,
        );

        // ── Check 5: a quoted spec block against the spec cited beside it ──────
        const specs = {
            '01-a/tests/unit/a.spec.ts': "describe('the shape of one row', () => {});\n",
            '01-a/tests/unit/b.spec.ts': "describe('the shape of the whole family', () => {});\ndescribe('mergeDecoded', () => {});\n",
        };

        const titleRight = drive(
            makeTree(
                'titleright',
                [
                    '# Fixture',
                    '',
                    'Asserted in `tests/unit/b.spec.ts` — the `the shape of the whole family`',
                    'block, from outside.',
                    '',
                    'Write a citation like this:',
                    '',
                    '```markdown',
                    'Asserted in `tests/unit/a.spec.ts` — the `the shape of the whole family` block.',
                    '```',
                    '',
                ].join('\n'),
                specs,
            ),
        );
        check(
            'accepts a quoted block beside the spec that holds it, and ignores a fenced example',
            titleRight.status === 0,
            `exit ${titleRight.status}: ${titleRight.output.trim()}`,
        );

        // The post-split failure this check exists for: the cited file still EXISTS,
        // so checks 1-3 pass. The title is wrapped across a line on purpose — that
        // newline defeated the first version of this check, and without the
        // whitespace normalisation this case goes green and reports nothing.
        const titleMoved = drive(
            makeTree(
                'titlemoved',
                [
                    '# Fixture',
                    '',
                    'Asserted in `tests/unit/a.spec.ts` — the `the shape of the whole',
                    'family` block, from outside.',
                    '',
                ].join('\n'),
                specs,
            ),
        );
        check(
            'rejects a quoted block cited beside a spec that no longer holds it',
            titleMoved.status === 1 && titleMoved.output.includes('the shape of the whole family'),
            `exit ${titleMoved.status}: ${titleMoved.output.trim()}`,
        );

        // The negative control for the whitespace rule. `mergeDecoded` is a describe
        // title in b.spec.ts AND the ordinary way prose names the function; treating
        // it as a citation of the block made this check produce false positives on
        // two real paragraphs. Prose about one spec may name a function tested in
        // another.
        const titleIdentifier = drive(
            makeTree(
                'titleidentifier',
                [
                    '# Fixture',
                    '',
                    'The row rules are in `tests/unit/a.spec.ts`; they call `mergeDecoded`',
                    'to build the fixture.',
                    '',
                ].join('\n'),
                specs,
            ),
        );
        check(
            'does not treat a single-identifier block title as a citation',
            titleIdentifier.status === 0,
            `exit ${titleIdentifier.status}: ${titleIdentifier.output.trim()}`,
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
