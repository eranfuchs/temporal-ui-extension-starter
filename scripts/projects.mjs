// Where "the projects" is defined, once.
//
// This repository holds three independent extensions — 01-family-tree,
// 02-techniques, 03-goodies — each a standalone TypeScript project that can be
// cloned, built and loaded on its own. Every root-level script (preflight,
// packaging, icons, the lineage gate) has to agree on which directories those
// are, so the answer lives here instead of in four hardcoded lists that drift.
//
// Discovery is by SHAPE, not by a list of names: a numbered directory holding a
// package.json is a project. Adding 04-something therefore needs no edit here,
// and — more to the point — a project cannot be silently left out of preflight
// by whoever forgets to add it to a list.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT_DIR_RE = /^\d\d-[a-z0-9-]+$/;

/**
 * Every project in the repository, in directory order (which is also the order
 * they are meant to be read in).
 *
 * A numbered directory WITHOUT a package.json is reported as `incomplete`
 * rather than skipped. 03-goodies spends time in exactly that state, and a
 * gate that quietly ignores it would report a full pass over two thirds of the
 * repository.
 */
export function discoverProjects(root = ROOT) {
    const projects = [];
    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !PROJECT_DIR_RE.test(entry.name)) continue;
        const dir = join(root, entry.name);
        const packageJsonPath = join(dir, 'package.json');
        if (!existsSync(packageJsonPath)) {
            projects.push({ id: entry.name, dir, incomplete: 'has no package.json yet' });
            continue;
        }
        projects.push({
            id: entry.name,
            dir,
            packageJsonPath,
            pkg: JSON.parse(readFileSync(packageJsonPath, 'utf8')),
            manifestPath: join(dir, 'public', 'manifest.json'),
        });
    }
    return projects;
}

/** The one project a script was pointed at, e.g. `node scripts/package.mjs 02-techniques`. */
export function resolveProject(argument) {
    const projects = discoverProjects();
    const wanted = (argument ?? '').replace(/^\.\//, '').replace(/\/$/, '');
    if (!wanted) return null;
    return projects.find((project) => project.id === wanted) ?? null;
}

export function projectIds() {
    return discoverProjects().map((project) => project.id);
}
