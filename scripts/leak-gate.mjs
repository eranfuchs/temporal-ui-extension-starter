#!/usr/bin/env node
// Leak gate — refuses to let anything organisation-specific into a repository
// that is meant to be public.
//
// WHY THIS EXISTS, AND WHY IT RUNS FROM COMMIT #1
//
// This extension was extracted from an internal one that runs inside a bank.
// The dangerous direction is not "someone reads the code" — it is a hostname,
// an internal namespace, a ticket key, or a token that rides along in a commit
// nobody re-reads. Redaction after the fact needs an exhaustive list of what to
// remove, and you find out what you missed after publication. So: every commit
// is treated as already public, and the gate runs before each one.
//
// WHAT IT DOES *NOT* CHECK: the commit author's name and email.
// Work happens on internal infrastructure under a corporate identity, and that
// identity is rewritten at publication time (`git filter-repo --mailmap`, which
// preserves author and committer dates byte-for-byte). Gating on author email
// would fail every commit for no benefit. Commit *messages*, on the other hand,
// travel verbatim — so `--history` reads them.
//
// The rules below name no company. Two of them are generic-by-construction:
//   • every URL host must be on a small allowlist, so ANY internal hostname
//     trips the gate without the gate having to know your company's domains;
//   • your own terms live in `leakgate.local.txt`, which is gitignored, because
//     a public repo that ships the list of your internal names has leaked it.
//
// Usage
//   node scripts/leak-gate.mjs              scan tracked + staged files
//   node scripts/leak-gate.mjs --history    also scan every blob and commit
//                                           message in the whole history
//   node scripts/leak-gate.mjs --dir <path> scan a plain directory
//   node scripts/leak-gate.mjs --selftest   prove the gate still detects and
//                                           still accepts (run after editing it)
//
// Exit status: 0 clean, 1 findings, 2 the gate itself could not run — which
// includes having nothing to read: an empty scan is UNVERIFIED, not clean.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// Hosts a public Temporal-facing extension has a legitimate reason to mention.
// Anything else — including every internal host in existence — is a finding.
// Keep this list SHORT; adding to it is the moment to ask "does this belong in
// a public repo at all?".
const ALLOWED_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    'cloud.temporal.io',
    'temporal.io',
    'docs.temporal.io',
    'learn.temporal.io',
    'temporal.download',
    'github.com',
    'raw.githubusercontent.com',
    'developer.chrome.com',
    'chromewebstore.google.com',
    'chrome.google.com',
    'nodejs.org',
    'www.npmjs.com',
    'npmjs.com',
    // Hosts npm itself writes into package-lock.json: the registry it resolved
    // from, plus whatever funding URLs the dependencies declare. Listed rather
    // than exempting the lockfile from the scan, because `resolved` is exactly
    // where a private registry — or a token embedded in one — would show up. A
    // new dependency with a new funding host WILL trip the gate; that is the
    // intended direction of failure. Check it is a real public project host,
    // then add it here.
    'registry.npmjs.org',
    'opencollective.com',
    'tidelift.com',
    'vitest.dev',
    'esbuild.github.io',
    'www.typescriptlang.org',
    'developer.mozilla.org',
    'opensource.org',
    'spdx.org',
    'semver.org',
    'example.com',
    'www.example.com',
]);

// Wildcard suffixes, for host families we cannot enumerate.
const ALLOWED_HOST_SUFFIXES = ['.temporal.io', '.tmprl.cloud', '.example.com'];

// Schemes whose `//…` part is not a network host and therefore cannot name a
// machine: browser-internal pages, extension origins, and in-memory payloads.
// Everything else keeps its host checked — see the comment on the URL rule.
const NON_NETWORK_SCHEMES = new Set([
    'chrome',
    'chrome-extension',
    'chrome-untrusted',
    'chrome-error',
    'chrome-search',
    'devtools',
    'edge',
    'brave',
    'opera',
    'vivaldi',
    'about',
    'moz-extension',
    'safari-web-extension',
    'extension',
    'data',
    'blob',
    'javascript',
    'view-source',
]);

// Email domains that are reserved for documentation (RFC 2606 / RFC 6761) plus
// GitHub's noreply. A real corporate address in a public repo is a finding.
const ALLOWED_EMAIL_DOMAINS = [
    'example.com',
    'example.org',
    'example.net',
    'example.invalid',
    'users.noreply.github.com',
];

const RULES = [
    {
        id: 'private-ip',
        why: 'an RFC1918 address names a machine on your internal network',
        // Loopback (127/8) is deliberately absent — the extension targets a
        // local `temporal server start-dev`, so 127.0.0.1 is expected content.
        re: /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g,
    },
    {
        id: 'aws-key-id',
        why: 'looks like an AWS access-key id',
        re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g,
    },
    {
        id: 'private-key',
        why: 'a PEM private key block',
        re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    },
    {
        id: 'jwt',
        why: 'looks like a JWT (three base64url segments starting with a JSON header)',
        re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    },
    {
        id: 'bearer-literal',
        why: 'a hard-coded bearer token',
        re: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g,
    },
    {
        id: 'slack-token',
        why: 'a Slack token',
        re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
    },
];

function isAllowedHost(host) {
    const h = host.toLowerCase();
    if (ALLOWED_HOSTS.has(h)) return true;
    return ALLOWED_HOST_SUFFIXES.some((s) => h.endsWith(s));
}

function isAllowedEmailDomain(domain) {
    const d = domain.toLowerCase();
    return ALLOWED_EMAIL_DOMAINS.some((a) => d === a || d.endsWith(`.${a}`));
}

// Load the operator's own terms. Absent file is NOT an error — a fork of this
// repo has no internal names to hide — but we say so, because a gate that is
// silently doing less than you think is worse than no gate.
function loadLocalTerms() {
    const path = join(REPO, 'leakgate.local.txt');
    if (!existsSync(path)) return { terms: [], path, present: false };
    const terms = [];
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        terms.push(
            line.startsWith('re:')
                ? { src: line.slice(3), re: new RegExp(line.slice(3), 'gi') }
                : { src: line, re: new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi') },
        );
    }
    return { terms, path, present: true };
}

// One finding per (rule, location, match) — deduped per line so a repeated
// string in one line reports once.
function scanText(text, where, localTerms) {
    const findings = [];
    const lines = text.split('\n');

    const push = (ruleId, why, lineNo, match) =>
        findings.push({ ruleId, why, where, line: lineNo, match: match.slice(0, 120) });

    lines.forEach((line, i) => {
        const lineNo = i + 1;
        for (const rule of RULES) {
            rule.re.lastIndex = 0;
            const seen = new Set();
            let m;
            while ((m = rule.re.exec(line)) !== null) {
                if (!seen.has(m[0])) {
                    seen.add(m[0]);
                    push(rule.id, rule.why, lineNo, m[0]);
                }
                if (m.index === rule.re.lastIndex) rule.re.lastIndex++;
            }
        }

        // Hosts: any absolute URL whose host is not allowlisted.
        //
        // The scheme is matched openly rather than as an http/https pair,
        // because an internal machine is just as exposed by `postgres://`,
        // `redis://`, `grpc://` or `ldap://` — those all carry a real host and
        // must stay in scope. What is subtracted instead is the small set of
        // schemes whose authority component is NOT a network host: `chrome://`
        // addresses the browser itself, and "load the unpacked extension from
        // chrome://extensions" is the first instruction in this repository.
        // Reading that as a host named "extensions" was the gate's own first
        // false positive.
        const urlRe = /\b([a-z][a-z0-9+.-]*):\/\/([^\s/?#'"`<>)\]}\\]+)/gi;
        let u;
        while ((u = urlRe.exec(line)) !== null) {
            if (NON_NETWORK_SCHEMES.has(u[1].toLowerCase())) continue;
            const host = u[2].replace(/^[^@]*@/, '').replace(/:\d+$/, '');
            if (!isAllowedHost(host)) {
                push('unknown-host', `host "${host}" is not on the public allowlist`, lineNo, u[0]);
            }
        }

        // Bare hostnames with an internal-looking TLD are missed by the URL
        // rule, so also flag any e-mail-shaped string on a non-doc domain.
        const mailRe = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
        let e;
        while ((e = mailRe.exec(line)) !== null) {
            if (!isAllowedEmailDomain(e[1])) {
                push('email', `e-mail domain "${e[1]}" is not a documentation domain`, lineNo, e[0]);
            }
        }

        for (const t of localTerms) {
            t.re.lastIndex = 0;
            if (t.re.test(line)) {
                push('local-denylist', `matches your private denylist term "${t.src}"`, lineNo, line.trim());
            }
        }
    });

    return findings;
}

const BINARY_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|mov|wasm)$/i;

function looksBinary(buf) {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
}

function git(args, opts = {}) {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

function trackedFiles() {
    try {
        return git(['ls-files', '-z']).split('\0').filter(Boolean);
    } catch {
        return null; // not a git repo
    }
}

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        if (entry === '.git' || entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else out.push(full);
    }
    return out;
}

function main(argv) {
    const wantHistory = argv.includes('--history');
    const dirIdx = argv.indexOf('--dir');
    const scanDir = dirIdx >= 0 ? argv[dirIdx + 1] : null;
    const quiet = argv.includes('--quiet');

    const local = loadLocalTerms();
    const findings = [];
    let filesScanned = 0;
    const skipped = [];

    const files = scanDir
        ? walk(scanDir).map((f) => relative(scanDir, f))
        : trackedFiles();

    if (files === null) {
        console.error('leak-gate: not a git repository and no --dir given');
        return 2;
    }

    const root = scanDir ?? REPO;
    for (const f of files) {
        // The denylist file is the one place internal terms legitimately live.
        if (f === 'leakgate.local.txt') continue;
        const full = join(root, f);
        if (!existsSync(full)) continue; // deleted-but-staged
        if (BINARY_EXT.test(f)) {
            skipped.push(f);
            continue;
        }
        const buf = readFileSync(full);
        if (looksBinary(buf)) {
            skipped.push(f);
            continue;
        }
        filesScanned++;
        findings.push(...scanText(buf.toString('utf8'), f, local.terms));
    }

    let blobsScanned = 0;
    let messagesScanned = 0;
    if (wantHistory && !scanDir) {
        // Commit messages travel verbatim into the public repository.
        const log = git(['log', '--all', '--format=%H%x1f%B%x1e']);
        for (const rec of log.split('\x1e')) {
            if (!rec.trim()) continue;
            const [sha, body] = rec.split('\x1f');
            messagesScanned++;
            findings.push(...scanText(body ?? '', `commit ${sha.trim().slice(0, 9)} (message)`, local.terms));
        }
        // Every blob ever committed, including ones deleted from the tip.
        const listing = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']);
        for (const line of listing.split('\n')) {
            const [sha, type, size] = line.split(' ');
            if (type !== 'blob') continue;
            if (Number(size) > 2 * 1024 * 1024) {
                skipped.push(`blob ${sha.slice(0, 9)} (${size} bytes)`);
                continue;
            }
            const buf = execFileSync('git', ['-C', REPO, 'cat-file', 'blob', sha], { maxBuffer: 8 * 1024 * 1024 });
            if (looksBinary(buf)) {
                skipped.push(`blob ${sha.slice(0, 9)} (binary)`);
                continue;
            }
            blobsScanned++;
            findings.push(...scanText(buf.toString('utf8'), `blob ${sha.slice(0, 9)}`, local.terms));
        }
    }

    // A scan that read nothing found nothing, and those are not the same
    // sentence. Before the first commit `git ls-files` is legitimately empty,
    // and this gate reported "ok" over zero files — a green tick for a check
    // that had not run. That is the exact failure mode the UNVERIFIED status
    // exists for, so it exits 2 rather than 0.
    if (filesScanned + blobsScanned + messagesScanned === 0) {
        console.error(
            scanDir
                ? `leak-gate: nothing to scan — no text files under ${scanDir}`
                : 'leak-gate: nothing to scan — no tracked or staged text files yet (nothing committed?)',
        );
        console.error('leak-gate: treat this as UNVERIFIED, not clean.');
        return 2;
    }

    if (!quiet) {
        const scope = scanDir
            ? `directory ${scanDir}`
            : wantHistory
              ? 'tracked files + full history'
              : 'tracked + staged files';
        console.log(`leak-gate: scanned ${scope}`);
        console.log(`  text files: ${filesScanned}`);
        if (wantHistory && !scanDir) {
            console.log(`  commit messages: ${messagesScanned}`);
            console.log(`  historical blobs: ${blobsScanned}`);
        }
        // Never let "0 terms loaded" pass for "nothing to find".
        console.log(
            local.present
                ? `  private denylist: ${local.terms.length} term(s) from leakgate.local.txt`
                : '  private denylist: NOT PRESENT (leakgate.local.txt missing) — generic rules only',
        );
        if (skipped.length > 0) {
            console.log(`  not scanned (binary): ${skipped.length} — a gate cannot read an image or a video`);
        }
    }

    if (findings.length === 0) {
        // The count is part of the verdict, not decoration: "clean" over an
        // unstated number of files is the sentence that let a zero-file scan
        // read as a pass, so any caller quoting one line quotes both.
        const counted = [`${filesScanned} text file(s)`];
        if (wantHistory && !scanDir) counted.push(`${messagesScanned} message(s)`, `${blobsScanned} blob(s)`);
        if (!quiet) console.log(`leak-gate: clean — scanned ${counted.join(', ')}`);
        return 0;
    }

    console.error(`\nleak-gate: ${findings.length} finding(s) — nothing is committed until these are gone\n`);
    for (const f of findings) {
        console.error(`  ${f.where}:${f.line}  [${f.ruleId}] ${f.why}`);
        console.error(`      ${f.match}`);
    }
    console.error('\nIf a finding is a false positive, widen the ALLOWED_* list in scripts/leak-gate.mjs');
    console.error('deliberately — and run `node scripts/leak-gate.mjs --selftest` afterwards.');
    return 1;
}

// ── Self-test ─────────────────────────────────────────────────────────────
// Every gate in this repository ships with one, because a gate that has quietly
// stopped detecting its own failure case is worse than no gate: it converts an
// unchecked risk into a false assurance. This drives the real gate, as a
// subprocess, against a case it MUST reject and a case it MUST accept.
function selftest() {
    const dir = mkdtempSync(join(tmpdir(), 'leakgate-selftest-'));
    let failures = 0;
    const check = (name, cond, detail) => {
        console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ` — ${detail}`}`);
        if (!cond) failures++;
    };

    try {
        // KNOWN-BAD: one instance of every generic rule.
        //
        // Each fixture is ASSEMBLED FROM FRAGMENTS on purpose. Written as whole
        // literals they are live secrets-shaped strings sitting in a tracked
        // file, and the gate rightly flags its own source (it did, all eight of
        // them, the first time this ran). The alternative — excluding this file
        // from the scan — would carve out exactly the blind spot anyone hiding
        // something would aim for. Splitting the strings keeps the gate honest
        // about every file in the repository, including itself.
        const bad = join(dir, 'bad');
        mkdirSync(bad, { recursive: true });
        writeFileSync(
            join(bad, 'leaky.ts'),
            [
                '// deploy target',
                `const HOST = "${'https'}://workflows.internal.corp-that-does-not-exist/api";`,
                `const DB = "${'10.42.'}7.9";`,
                `const KEY = "${'AKIA'}IOSFODNN7EXAMPLE";`,
                `const OWNER = "${'someone@'}a-real-company-domain.co.il";`,
                `const TOKEN = "${'eyJhbGciOiJIUzI1NiJ9'}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";`,
                `const AUTH = "${'Bearer '}abcdefghijklmnopqrstuvwxyz0123456789";`,
                `const SLACK = "${'xoxb-'}1234567890-abcdefghijkl";`,
                `${'-----BEGIN RSA '}PRIVATE KEY-----`,
            ].join('\n'),
        );
        const badRun = run(['--dir', bad, '--quiet']);
        check('rejects a known-bad file', badRun.status === 1, `exit ${badRun.status}`);
        for (const id of ['unknown-host', 'private-ip', 'aws-key-id', 'email', 'jwt', 'bearer-literal', 'slack-token', 'private-key']) {
            check(`  detects [${id}]`, badRun.output.includes(`[${id}]`), 'rule did not fire');
        }

        // KNOWN-GOOD: everything this repository legitimately contains.
        const good = join(dir, 'good');
        mkdirSync(good, { recursive: true });
        writeFileSync(
            join(good, 'fine.ts'),
            [
                '// The extension observes the page\'s own API calls.',
                'const OSS = "http://localhost:8233/api/v1/namespaces/default/workflows";',
                'const LOOPBACK = "http://127.0.0.1:8233/namespaces/default/workflows";',
                'const CLOUD = "https://cloud.temporal.io/namespaces/my-ns.acct/workflows";',
                'const TENANT = "https://my-ns.acct.web.tmprl.cloud/api/v1/namespaces";',
                'const DOCS = "https://docs.temporal.io/develop/typescript";',
                'const CONTACT = "maintainer@example.invalid";',
                '// Load the unpacked build from chrome://extensions.',
                'const SELF = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html";',
            ].join('\n'),
        );
        const goodRun = run(['--dir', good, '--quiet']);
        check('accepts a known-good file', goodRun.status === 0, `exit ${goodRun.status}: ${goodRun.output.trim()}`);

        // The URL rule subtracts browser-internal schemes (above) but MUST keep
        // every scheme that names a real machine. Checked as its own case
        // because the two directions fail independently: widening the scheme
        // exemption is how a `postgres://` host stops being read.
        const scheme = join(dir, 'scheme');
        mkdirSync(scheme, { recursive: true });
        writeFileSync(
            join(scheme, 'conn.ts'),
            `const DSN = "${'postgres'}://reporting.a-real-internal-hostname/analytics";\n`,
        );
        const schemeRun = run(['--dir', scheme, '--quiet']);
        check(
            'still reads the host of a non-http scheme',
            schemeRun.status === 1 && schemeRun.output.includes('reporting.a-real-internal-hostname'),
            `exit ${schemeRun.status}: ${schemeRun.output.trim()}`,
        );

        // The local denylist must actually be read when present. Written into
        // the repo root because that is where the gate looks for it; removed
        // again in the finally block.
        const localPath = join(REPO, 'leakgate.local.txt');
        const had = existsSync(localPath);
        const previous = had ? readFileSync(localPath) : null;
        try {
            writeFileSync(localPath, 'zzsentinelterm\nre:SENT-\\d+\n');
            const sentDir = join(dir, 'sentinel');
            mkdirSync(sentDir, { recursive: true });
            writeFileSync(join(sentDir, 'note.md'), 'a mention of ZZsentinelTerm and SENT-4213\n');
            const sentRun = run(['--dir', sentDir, '--quiet']);
            check('reads leakgate.local.txt (literal, case-insensitive)', sentRun.status === 1 && sentRun.output.includes('zzsentinelterm'), sentRun.output.trim());
            check('reads leakgate.local.txt (re: pattern)', sentRun.output.includes('SENT-\\d+'), 'regex term did not fire');
        } finally {
            if (previous !== null) writeFileSync(localPath, previous);
            else rmSync(localPath, { force: true });
        }

        // The public npm registry is allowlisted so that a committed lockfile
        // does not bury every other finding. A PRIVATE registry in the same
        // field must still be caught — that is the whole reason the lockfile is
        // scanned rather than exempted.
        const lock = join(dir, 'lock');
        mkdirSync(lock, { recursive: true });
        writeFileSync(
            join(lock, 'package-lock.json'),
            [
                '{ "packages": { "node_modules/a": {',
                `    "resolved": "${'https'}://npm.a-private-registry-host/a/-/a-1.0.0.tgz",`,
                '    "funding": { "url": "https://opencollective.com/a" }',
                '} } }',
            ].join('\n'),
        );
        const lockRun = run(['--dir', lock, '--quiet']);
        check(
            'catches a private registry in a lockfile, ignores its funding hosts',
            lockRun.status === 1
                && lockRun.output.includes('npm.a-private-registry-host')
                && !lockRun.output.includes('opencollective'),
            `exit ${lockRun.status}: ${lockRun.output.trim()}`,
        );

        // An empty scan must not read as a clean scan.
        const empty = join(dir, 'empty');
        mkdirSync(empty, { recursive: true });
        const emptyRun = run(['--dir', empty]);
        check(
            'reports an empty scan as UNVERIFIED (exit 2), not clean',
            emptyRun.status === 2,
            `exit ${emptyRun.status}: ${emptyRun.output.trim()}`,
        );

        // The gate must scan its own source: no self-exclusion blind spot.
        const selfRun = run(['--dir', join(REPO, 'scripts'), '--quiet']);
        check('scans its own source without matching itself', selfRun.status === 0, selfRun.output.trim());
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(failures === 0 ? '\nleak-gate selftest: all cases behaved as required' : `\nleak-gate selftest: ${failures} case(s) WRONG`);
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
