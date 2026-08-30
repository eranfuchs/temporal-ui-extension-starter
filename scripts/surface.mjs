#!/usr/bin/env node
// Surface gate — checks that each extension's attack surface is the one its
// README claims, and that no project quietly grows a bigger one.
//
// WHY A GATE AND NOT A REVIEW HABIT
//
// The argument this repository makes is a ladder: 01 asks for no permissions, 02
// asks for `storage`, and the difference is visible. That argument is only worth
// anything if it stays true, and it is exactly the kind of claim that rots
// silently — someone needs a value to survive a reload, adds "storage" to 01's
// manifest, and the sentence "it asks for no permissions at all" in the README is
// now false with nothing failing.
//
// So the budget lives in scripts/surface.json and this compares it with reality:
//
//   1. every complete project has a declared budget (an unlisted project FAILS,
//      rather than being skipped — a project with no budget must not mean a
//      project with an unlimited one);
//   2. manifest permissions / optional_permissions / host_permissions are a
//      SUBSET of the budget;
//   3. background, web_accessible_resources, externally_connectable and a
//      relaxed content_security_policy are present only where budgeted;
//   4. content_script matches are on the repository-wide allowlist, and
//      <all_urls> / *://*/* are refused outright;
//   5. a project budgeted `chrome_api: false` contains no chrome.* call, no
//      @types/chrome dependency, and no "chrome" in tsconfig's types;
//   6. no source file uses a markup or code-execution sink (innerHTML, eval, …);
//   7. no runtime dependency in any project — nothing enters a bundle but code
//      in this repository;
//   8. no binary file outside the generated-icon allowlist, because a gate
//      cannot read a binary and a committed image is a file nobody reviews.
//
// Usage
//   node scripts/surface.mjs                    check the repository
//   node scripts/surface.mjs --root <path>      check a different tree (tests)
//   node scripts/surface.mjs --budget <path>    use a different budget file
//   node scripts/surface.mjs --selftest         prove the gate still detects
//
// Exit status: 0 clean, 1 findings, 2 could not check.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverProjects, ROOT } from './projects.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.vite', '.idea']);

// Sinks that turn a string into markup or into code. The workflow ids, types and
// task-queue names this extension renders are authored by whoever started the
// workflow — untrusted input, in a page we do not own.
const SINKS = [
    { id: 'innerHTML', re: /\.innerHTML\s*(=|\+=)/ },
    { id: 'outerHTML', re: /\.outerHTML\s*(=|\+=)/ },
    { id: 'insertAdjacentHTML', re: /\.insertAdjacentHTML\s*\(/ },
    { id: 'document.write', re: /\bdocument\s*\.\s*write(ln)?\s*\(/ },
    { id: 'eval', re: /(^|[^.\w])eval\s*\(/ },
    { id: 'new Function', re: /\bnew\s+Function\s*\(/ },
    { id: 'setTimeout(string)', re: /\bsetTimeout\s*\(\s*['"`]/ },
    { id: 'setInterval(string)', re: /\bsetInterval\s*\(\s*['"`]/ },
];

const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|wasm|so|dylib|dll)$/i;

// Comments are not behaviour. 01's src/content.ts says, in a comment, that there
// is no chrome.* call in the project — reading that as a chrome.* call would
// make the gate impossible to satisfy honestly, and encouraging people to delete
// the explanation is the opposite of the intent.
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
}

function filesUnder(dir) {
    const found = [];
    const walk = (path) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(path, entry.name);
            if (entry.isDirectory()) walk(full);
            else found.push(full);
        }
    };
    walk(dir);
    return found;
}

function globToRe(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`);
}

function looksBinary(buffer) {
    const limit = Math.min(buffer.length, 8000);
    for (let i = 0; i < limit; i++) if (buffer[i] === 0) return true;
    return false;
}

function main(argv) {
    const rootIdx = argv.indexOf('--root');
    const root = rootIdx >= 0 ? argv[rootIdx + 1] : ROOT;
    const budgetIdx = argv.indexOf('--budget');
    const budgetPath = budgetIdx >= 0 ? argv[budgetIdx + 1] : join(ROOT, 'scripts', 'surface.json');
    const quiet = argv.includes('--quiet');

    if (!existsSync(budgetPath)) {
        console.error(`surface: no budget at ${budgetPath}`);
        return 2;
    }
    let budget;
    try {
        budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
    } catch (err) {
        console.error(`surface: budget is not valid JSON: ${err.message}`);
        return 2;
    }

    const projects = discoverProjects(root).filter((project) => !project.incomplete);
    if (projects.length === 0) {
        console.error(`surface: no complete project under ${root} — nothing to check.`);
        console.error('surface: treat this as UNVERIFIED, not clean.');
        return 2;
    }

    const findings = [];
    const allowedMatches = new Set(budget.matches?.allowed ?? []);
    const checked = { manifests: 0, sourceFiles: 0, binaries: 0 };

    for (const project of projects) {
        const declared = budget.projects?.[project.id];
        if (!declared) {
            findings.push(
                `${project.id}: has no budget in scripts/surface.json — add one, including permissions: [] if it needs none`,
            );
            continue;
        }

        // ── The manifest ──
        if (!existsSync(project.manifestPath)) {
            findings.push(`${project.id}: public/manifest.json does not exist`);
        } else {
            checked.manifests++;
            const manifest = JSON.parse(readFileSync(project.manifestPath, 'utf8'));

            for (const key of ['permissions', 'optional_permissions', 'host_permissions']) {
                const asked = manifest[key] ?? [];
                const budgeted = new Set(declared[key] ?? []);
                for (const item of asked) {
                    if (!budgeted.has(item)) {
                        findings.push(
                            `${project.id}: manifest asks for ${key} "${item}", which is not in its budget. ` +
                                'Either it is not needed, or scripts/surface.json needs a reviewed edit saying why it is.',
                        );
                    }
                }
            }

            for (const key of ['background', 'web_accessible_resources', 'externally_connectable', 'content_security_policy']) {
                if (manifest[key] !== undefined && declared[key] !== true) {
                    findings.push(
                        `${project.id}: manifest declares "${key}" but its budget does not allow it`,
                    );
                }
            }

            for (const script of manifest.content_scripts ?? []) {
                for (const match of script.matches ?? []) {
                    if (match === '<all_urls>' || /^\*:\/\/\*\//.test(match)) {
                        findings.push(
                            `${project.id}: content script matches "${match}" — an extension that runs everywhere ` +
                                'is not a Temporal extension. Name the hosts.',
                        );
                        continue;
                    }
                    if (!allowedMatches.has(match)) {
                        findings.push(
                            `${project.id}: content script matches "${match}", which is not on the repository allowlist ` +
                                `(${[...allowedMatches].join(', ')})`,
                        );
                    }
                }
            }
        }

        // ── Runtime dependencies ──
        for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            const names = Object.keys(project.pkg[key] ?? {});
            if (names.length > 0) {
                findings.push(
                    `${project.id}: package.json has ${key} (${names.join(', ')}). ` +
                        'Nothing but code from this repository should end up in a bundle a user loads.',
                );
            }
        }

        // ── The chrome API claim ──
        if (declared.chrome_api !== true) {
            const typesDep = Object.keys(project.pkg.devDependencies ?? {}).find((name) => name === '@types/chrome');
            if (typesDep) {
                findings.push(
                    `${project.id}: budgeted chrome_api: false but devDependencies include @types/chrome`,
                );
            }
            const tsconfigPath = join(project.dir, 'tsconfig.json');
            if (existsSync(tsconfigPath)) {
                // Not JSON.parse: tsconfig.json legitimately carries comments.
                const raw = stripComments(readFileSync(tsconfigPath, 'utf8'));
                const types = /"types"\s*:\s*\[([^\]]*)\]/.exec(raw);
                if (types && /chrome/.test(types[1])) {
                    findings.push(`${project.id}: budgeted chrome_api: false but tsconfig.json includes "chrome" in types`);
                }
            }
        }

        // ── Sinks, and chrome.* usage, over the source ──
        const sourceDirs = ['src', 'tests', 'public'].map((name) => join(project.dir, name)).filter(existsSync);
        for (const dir of sourceDirs) {
            for (const file of filesUnder(dir)) {
                if (BINARY_EXT.test(file)) continue;
                if (!/\.(ts|tsx|js|mjs|cjs|html|css)$/.test(file)) continue;
                checked.sourceFiles++;
                const where = relative(root, file);
                const code = stripComments(readFileSync(file, 'utf8'));
                code.split('\n').forEach((line, index) => {
                    for (const sink of SINKS) {
                        if (sink.re.test(line)) {
                            findings.push(`${where}:${index + 1}: uses ${sink.id} — render text with textContent instead`);
                        }
                    }
                    if (declared.chrome_api !== true && /\bchrome\s*\./.test(line)) {
                        findings.push(
                            `${where}:${index + 1}: uses a chrome.* API, but ${project.id} is budgeted chrome_api: false`,
                        );
                    }
                });
            }
        }
    }

    // ── Binaries, repository-wide ──
    const allowedBinaries = (budget.binaries?.allowed ?? []).map(globToRe);
    for (const file of filesUnder(root)) {
        const where = relative(root, file).split('\\').join('/');
        const isBinary = BINARY_EXT.test(where) || looksBinary(readFileSync(file));
        if (!isBinary) continue;
        checked.binaries++;
        if (allowedBinaries.some((re) => re.test(where))) continue;
        findings.push(
            `${where}: a binary file outside the allowlist. No gate in this repository can read it — ` +
                'if it belongs here, add it to "binaries" in scripts/surface.json with a reason.',
        );
    }

    if (!quiet) {
        console.log(`surface: checked ${projects.map((p) => p.id).join(', ')}`);
        console.log(`  manifests: ${checked.manifests}`);
        console.log(`  source files scanned for sinks: ${checked.sourceFiles}`);
        console.log(`  binary files found: ${checked.binaries}`);
        const budgeted = Object.keys(budget.projects ?? {});
        console.log(`  budgets declared: ${budgeted.length} (${budgeted.join(', ')})`);
    }

    if (findings.length > 0) {
        console.error(`\nsurface: ${findings.length} finding(s)\n`);
        for (const finding of findings) console.error(`  ${finding}`);
        console.error('');
        return 1;
    }

    // The counts are the verdict, not decoration: a scan of zero source files
    // also finds zero sinks.
    if (!quiet) {
        console.log(
            `surface: clean — ${checked.manifests} manifest(s) within budget, ` +
                `${checked.sourceFiles} source file(s) free of banned sinks`,
        );
    }
    return 0;
}

// ── Self-test ─────────────────────────────────────────────────────────────
// One fixture per rule. Anything less and a rule that stopped firing would be
// invisible behind another rule that still does.
function selftest() {
    const dir = mkdtempSync(join(tmpdir(), 'surface-selftest-'));
    let failures = 0;
    const check = (name, condition, detail) => {
        console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${condition ? '' : ` — ${detail}`}`);
        if (!condition) failures++;
    };

    const BASE_MANIFEST = {
        manifest_version: 3,
        name: 'fixture',
        version: '0.0.0',
        content_scripts: [{ matches: ['https://cloud.temporal.io/*'], js: ['content.js'] }],
    };
    const BASE_BUDGET = {
        matches: { allowed: ['https://cloud.temporal.io/*'] },
        binaries: { allowed: ['*/public/icons/icon-*.png'] },
        projects: {
            '01-a': {
                permissions: [],
                host_permissions: [],
                background: false,
                web_accessible_resources: false,
                externally_connectable: false,
                content_security_policy: false,
                chrome_api: false,
                why: 'fixture',
            },
        },
    };

    // Builds a one-project tree. `manifest` and `budget` are merged over the
    // baseline so each fixture states only the thing it is testing.
    const makeTree = (name, { manifest = {}, budget = {}, files = {}, pkg = {} } = {}) => {
        const treeRoot = join(dir, name);
        const projectDir = join(treeRoot, '01-a');
        mkdirSync(join(projectDir, 'public'), { recursive: true });
        mkdirSync(join(projectDir, 'src'), { recursive: true });
        writeFileSync(
            join(projectDir, 'public', 'manifest.json'),
            JSON.stringify({ ...BASE_MANIFEST, ...manifest }, null, 2),
        );
        writeFileSync(
            join(projectDir, 'package.json'),
            JSON.stringify({ name: '01-a', version: '0.0.0', ...pkg }, null, 2),
        );
        writeFileSync(join(projectDir, 'src', 'content.ts'), files['src/content.ts'] ?? 'const rows = [];\n');
        for (const [path, contents] of Object.entries(files)) {
            if (path === 'src/content.ts') continue;
            const full = join(projectDir, path);
            mkdirSync(join(full, '..'), { recursive: true });
            writeFileSync(full, contents);
        }
        const budgetPath = join(treeRoot, 'surface.json');
        const merged = {
            ...BASE_BUDGET,
            ...budget,
            projects: { '01-a': { ...BASE_BUDGET.projects['01-a'], ...(budget.projects?.['01-a'] ?? {}) } },
        };
        writeFileSync(budgetPath, JSON.stringify(merged, null, 2));
        return { root: treeRoot, budgetPath };
    };

    const drive = (tree) => run(['--root', tree.root, '--budget', tree.budgetPath, '--quiet']);

    try {
        const good = drive(makeTree('good'));
        check('accepts a project inside its budget', good.status === 0, `exit ${good.status}: ${good.output.trim()}`);

        const permission = drive(makeTree('permission', { manifest: { permissions: ['storage'] } }));
        check(
            'rejects a permission that is not budgeted',
            permission.status === 1 && permission.output.includes('storage'),
            `exit ${permission.status}: ${permission.output.trim()}`,
        );

        const host = drive(makeTree('host', { manifest: { host_permissions: ['https://cloud.temporal.io/*'] } }));
        check(
            'rejects an unbudgeted host_permission',
            host.status === 1 && host.output.includes('host_permissions'),
            `exit ${host.status}: ${host.output.trim()}`,
        );

        const worker = drive(makeTree('worker', { manifest: { background: { service_worker: 'sw.js' } } }));
        check(
            'rejects an unbudgeted service worker',
            worker.status === 1 && worker.output.includes('background'),
            `exit ${worker.status}: ${worker.output.trim()}`,
        );

        const everywhere = drive(
            makeTree('everywhere', { manifest: { content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }] } }),
        );
        check(
            'refuses <all_urls> outright',
            everywhere.status === 1 && everywhere.output.includes('<all_urls>'),
            `exit ${everywhere.status}: ${everywhere.output.trim()}`,
        );

        const otherHost = drive(
            makeTree('otherhost', {
                manifest: { content_scripts: [{ matches: ['https://temporal.example.com/*'], js: ['content.js'] }] },
            }),
        );
        check(
            'rejects a match that is not on the allowlist',
            otherHost.status === 1 && otherHost.output.includes('allowlist'),
            `exit ${otherHost.status}: ${otherHost.output.trim()}`,
        );

        const sink = drive(makeTree('sink', { files: { 'src/content.ts': 'cell.innerHTML = row.workflowId;\n' } }));
        check(
            'rejects innerHTML',
            sink.status === 1 && sink.output.includes('innerHTML'),
            `exit ${sink.status}: ${sink.output.trim()}`,
        );

        // The complement of the sink rule: a comment mentioning a sink, and
        // textContent, must both pass. A gate that fires on prose gets disabled.
        const prose = drive(
            makeTree('prose', {
                files: {
                    'src/content.ts': '// Never assign innerHTML here; eval is banned too.\ncell.textContent = row.workflowId;\n',
                },
            }),
        );
        check(
            'does not fire on a comment that names a sink',
            prose.status === 0,
            `exit ${prose.status}: ${prose.output.trim()}`,
        );

        const chromeUse = drive(
            makeTree('chromeuse', { files: { 'src/content.ts': 'const v = chrome.storage.sync.get("x");\n' } }),
        );
        check(
            'rejects chrome.* in a project budgeted chrome_api: false',
            chromeUse.status === 1 && chromeUse.output.includes('chrome.*'),
            `exit ${chromeUse.status}: ${chromeUse.output.trim()}`,
        );

        const chromeAllowed = drive(
            makeTree('chromeok', {
                files: { 'src/content.ts': 'const v = chrome.storage.sync.get("x");\n' },
                budget: { projects: { '01-a': { chrome_api: true } } },
            }),
        );
        check(
            'allows chrome.* where it is budgeted',
            chromeAllowed.status === 0,
            `exit ${chromeAllowed.status}: ${chromeAllowed.output.trim()}`,
        );

        const types = drive(
            makeTree('types', { pkg: { devDependencies: { '@types/chrome': '^0.2.7' } } }),
        );
        check(
            'rejects @types/chrome where the chrome API is not budgeted',
            types.status === 1 && types.output.includes('@types/chrome'),
            `exit ${types.status}: ${types.output.trim()}`,
        );

        const runtimeDep = drive(makeTree('dep', { pkg: { dependencies: { lodash: '^4' } } }));
        check(
            'rejects a runtime dependency',
            runtimeDep.status === 1 && runtimeDep.output.includes('lodash'),
            `exit ${runtimeDep.status}: ${runtimeDep.output.trim()}`,
        );

        // A binary nobody can review. Written as a real NUL-containing file so the
        // detection is the same one the gate uses in anger, not an extension match.
        const binaryTree = makeTree('binary');
        writeFileSync(join(binaryTree.root, '01-a', 'public', 'screenshot.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
        const binary = drive(binaryTree);
        check(
            'rejects a binary outside the icon allowlist',
            binary.status === 1 && binary.output.includes('screenshot.bin'),
            `exit ${binary.status}: ${binary.output.trim()}`,
        );

        const iconTree = makeTree('icon');
        mkdirSync(join(iconTree.root, '01-a', 'public', 'icons'), { recursive: true });
        writeFileSync(join(iconTree.root, '01-a', 'public', 'icons', 'icon-16.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
        const icon = drive(iconTree);
        check('allows a generated icon', icon.status === 0, `exit ${icon.status}: ${icon.output.trim()}`);

        // A project with no budget must fail, not be skipped. Otherwise adding a
        // project is how you escape the gate.
        const unbudgeted = makeTree('unbudgeted', { budget: { projects: {} } });
        // makeTree always re-adds 01-a's budget, so remove it deliberately.
        writeFileSync(
            unbudgeted.budgetPath,
            JSON.stringify({ ...BASE_BUDGET, projects: {} }, null, 2),
        );
        const unbudgetedRun = drive(unbudgeted);
        check(
            'rejects a project with no declared budget',
            unbudgetedRun.status === 1 && unbudgetedRun.output.includes('no budget'),
            `exit ${unbudgetedRun.status}: ${unbudgetedRun.output.trim()}`,
        );

        // Nothing to check must not read as clean.
        const emptyRoot = join(dir, 'empty');
        mkdirSync(emptyRoot, { recursive: true });
        const emptyBudget = join(emptyRoot, 'surface.json');
        writeFileSync(emptyBudget, JSON.stringify(BASE_BUDGET, null, 2));
        const empty = run(['--root', emptyRoot, '--budget', emptyBudget, '--quiet']);
        check(
            'reports a tree with no projects as UNVERIFIED (exit 2), not clean',
            empty.status === 2,
            `exit ${empty.status}: ${empty.output.trim()}`,
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(
        failures === 0 ? '\nsurface selftest: all cases behaved as required' : `\nsurface selftest: ${failures} case(s) WRONG`,
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
