#!/usr/bin/env node
// Runs one npm script in every project: `node scripts/run-in-projects.mjs build`.
//
// The root package.json has no source of its own — the projects do — so its
// `build` / `test` / `typecheck` scripts are this, once per project. Deliberately
// NOT npm workspaces: each project must stay clonable and buildable on its own,
// which is the whole reason they are separate directories, and a workspace root
// makes a project's package.json meaningless outside this repository.
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
