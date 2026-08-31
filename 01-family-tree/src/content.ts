// ISOLATED-world script: wiring only.
//
// It listens for the rows that inject.ts saw the page fetch, folds them into a
// tree, and hands the result to render.ts. Every DOM write lives there, so this
// file stays small enough to read in one sitting.
//
// Note what is absent: there is no `chrome.*` call anywhere in this project. No
// storage, no messaging, no popup to answer. That is why its manifest asks for
// no permissions at all — see 01-family-tree/README.md.

import { buildTree, countFamilies } from './tree';
import {
    emptyPlacementIndex,
    findPlacement,
    indexPlacements,
    judgeListResponse,
    normalizeExecutions,
    type PlacementIndex,
} from './rows';
import { applyToTable, findWorkflowTbody, namespaceFromLocation, type Placement } from './render';
import { MESSAGE_SOURCE, type WorkflowsMessage } from './types';

const TAG = '[temporal-family-tree]';

// What we know about the workflows the page has fetched, indexed by run and by
// workflow id. Both the indexing and the lookup rules live in rows.ts, where
// they are pure and unit-tested; this file only decides WHEN to rebuild them.
let placements: PlacementIndex<Placement> = emptyPlacementIndex();

// The generation of the newest list response applied — see judgeListResponse().
let appliedGeneration = -1;

// ── Receiving rows ───────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
    // Both checks matter. `event.source !== window` rejects messages from
    // iframes; the source tag rejects the rest of the page's own postMessage
    // traffic, and a single-page app does have some.
    if (event.source !== window) return;
    const data = event.data as WorkflowsMessage | undefined;
    if (data?.source !== MESSAGE_SOURCE || data.type !== 'workflows') return;

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
