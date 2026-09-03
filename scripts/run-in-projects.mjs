#!/usr/bin/env node
// Runs one npm script in every project: `node scripts/run-in-projects.mjs build`.
//
// The root package.json has no source of its own — the projects do — so its
// `build` / `test` / `typecheck` scripts are this, once per project.
//
// The projects ARE npm workspaces (see the root `workspaces` field), but that
// only decides where `npm install` puts packages. It does not run anything: npm
// workspace scripts would run in a fixed order and stop at the first failure,
// and "02 is broken" is more useful than "something is broken". So the running
// stays here and the installing stays with npm.
//
// This used to say workspaces were deliberately avoided, on the grounds that a
// workspace root makes a project's package.json meaningless outside the repo.
// That was wrong on the facts — a workspace member's package.json is an ordinary
// one, and `npm install` inside a lone copy of a project directory still works —
// and it had a cost: without a workspace root, `npm install` here installed only
// the root's declarations, so every project's dependency list was decorative.
// Each project now declares what it actually needs, and the root install honours
// it. `npm run surface` checks that the two agree.
//
// It keeps going after a failure and reports every project's status at the end,
// because "02 is broken" is more useful than "something is broken" and stopping
// at the first failure hides the rest.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { discoverProjects } from './projects.mjs';

const script = process.argv[2];
if (!script) {
    console.error('usage: node scripts/run-in-projects.mjs <npm-script> [args…]');
    process.exit(1);
}
const extraArgs = process.argv.slice(3);

const projects = discoverProjects();
if (projects.length === 0) {
    console.error('No projects found (expected directories like 01-family-tree holding a package.json).');
    process.exit(1);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const outcomes = [];

for (const project of projects) {
    if (project.incomplete) {
        console.log(`\n── ${project.id}: skipped, ${project.incomplete}`);
        outcomes.push({ id: project.id, status: 'incomplete' });
        continue;
    }
    if (!project.pkg.scripts?.[script]) {
        console.log(`\n── ${project.id}: no "${script}" script`);
        outcomes.push({ id: project.id, status: 'no-script' });
        continue;
    }

    console.log(`\n── ${project.id}: npm run ${script}`);
    const proc = spawnSync(npm, ['run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])], {
        cwd: project.dir,
        stdio: 'inherit',
    });
    outcomes.push({ id: project.id, status: proc.status === 0 ? 'ok' : `exit ${proc.status}` });
}

console.log('');
for (const outcome of outcomes) console.log(`${outcome.status === 'ok' ? '  ok  ' : ' ---- '} ${outcome.id}: ${outcome.status}`);

// A run in which nothing actually ran is a failure, not a pass — the same rule
// preflight applies. Silence is not success.
const ran = outcomes.filter((o) => o.status === 'ok' || o.status.startsWith('exit'));
if (ran.length === 0) {
    console.error(`\nNothing ran: no project has a "${script}" script.`);
    process.exit(1);
}
const broken = outcomes.filter((o) => o.status.startsWith('exit'));
if (broken.length > 0) {
    console.error(`\nFailed in: ${broken.map((o) => o.id).join(', ')}`);
    process.exit(1);
}

// `install`/`incomplete` projects were not run; say so rather than printing a
// flat "done".
const notRun = outcomes.filter((o) => !ran.includes(o));
console.log(
    `\nRan "${script}" in ${ran.map((o) => o.id).join(', ')}` +
        (notRun.length > 0 ? ` — not run in ${notRun.map((o) => `${o.id} (${o.status})`).join(', ')}` : ''),
);
