// ISOLATED-world script: wiring only.
//
// It listens for the rows that inject.ts saw the page fetch, folds them into a
// tree, and hands the result to render.ts. Every DOM write lives there, so this
// file stays small enough to read in one sitting.
//
// Note what is absent: there is no `chrome.*` call anywhere in this project. No
// storage, no messaging, no popup to answer. That is why its manifest asks for
// no permissions at all — see 01-family-tree/README.md.

import { safeParse } from 'valibot';

import { buildTree, countFamilies } from './family/tree';
import {
    emptyPlacementIndex,
    findPlacement,
    indexPlacements,
    judgeListResponse,
    normalizeExecutions,
    type PlacementIndex,
} from './family/rows';
import { applyToTable, findWorkflowTbody, namespaceFromLocation, type Placement } from './render';
import { workflowsMessageSchema } from './types';

const TAG = '[temporal-family-tree]';

// What we know about the workflows the page has fetched, indexed by run and by
// workflow id. Both the indexing and the lookup rules live in rows.ts, where
// they are pure and unit-tested; this file only decides WHEN to rebuild them.
let placements: PlacementIndex<Placement> = emptyPlacementIndex();

// The generation of the newest list response applied — see judgeListResponse().
let appliedGeneration = -1;

// ── Receiving rows ───────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
    // `event.source !== window` rejects messages from iframes, and it is the only
    // check here that says anything about WHERE the message came from.
    if (event.source !== window) return;

    // Everything past this line is about SHAPE, and shape is not provenance: the
    // schema rejects a message that does not look like ours, but any script in
    // this window can send one that does. The source tag also does the mundane
    // job of ignoring the rest of the page's own postMessage traffic, of which a
    // single-page app has plenty.
    //
    // safeParse rather than parse: a stray message must be dropped, not throw
    // inside an event listener. What we go on to read is `data`, not `event.data`
    // — narrowed, unknown keys stripped, and never cast.
    const parsed = safeParse(workflowsMessageSchema, event.data);
    if (!parsed.success) return;
    const data = parsed.output;

    // Is this answer the newest one, and is it even about this table? Neither
    // question is answerable from the DOM, and getting either wrong looks like a
    // rendering glitch rather than a bug.
    const verdict = judgeListResponse({
        generation: data.generation,
        url: data.url,
        appliedGeneration,
        pageNamespace: namespaceFromLocation(location.pathname),
    });
    if (verdict !== 'accept') {
        console.log(TAG, `ignored a workflow list (${verdict})`, data.url);
        return;
    }
    appliedGeneration = data.generation;

    const ordered = buildTree(normalizeExecutions(data.executions));

    placements = indexPlacements(ordered, (row, index) => ({
        sequence: index,
        depth: row.depth,
        segments: row.segments,
        row,
    }));

    console.log(TAG, `${ordered.length} rows, ${countFamilies(ordered)} with children`);
    scheduleApply();
});

function lookup(workflowId: string, runId: string | null): Placement | undefined {
    return findPlacement(placements, workflowId, runId);
}

// ── When to re-apply ─────────────────────────────────────────────────────────

function apply(): void {
    const tbody = findWorkflowTbody();
    if (!tbody) return; // every page that is not the workflow list
    applyToTable(tbody, lookup);
}

let applyScheduled = false;
function scheduleApply(): void {
    if (applyScheduled) return;
    applyScheduled = true;
    // One pass per animation frame at most: the observer can fire hundreds of
    // times during a single re-render.
    requestAnimationFrame(() => {
        applyScheduled = false;
        try {
            apply();
        } catch (err) {
            // A thrown pass must not take the observer down with it, or the
            // extension is dead for the rest of the page's life.
            console.warn(TAG, 'render pass failed', err);
        }
    });
}

// childList + subtree only. Attribute mutations are deliberately NOT observed:
// we write attributes ourselves, and observing them is the shortest path to the
// self-feeding loop described at the top of render.ts.
const observer = new MutationObserver(scheduleApply);

async function start(): Promise<void> {
    // We run at document_start so that no workflow-list response is missed. That
    // is early enough for document.body to still be null.
    if (!document.body) {
        await new Promise<void>((resolve) =>
            document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }),
        );
    }
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleApply();
    console.log(TAG, 'ready');
}

void start();
