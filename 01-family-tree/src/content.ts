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
import { normalizeExecutions, runKey } from './rows';
import { applyToTable, findWorkflowTbody, type Placement } from './render';
import { MESSAGE_SOURCE, type WorkflowsMessage } from './types';

const TAG = '[temporal-family-tree]';

// What we know about the workflows the page has fetched: one entry per RUN, plus
// a workflow-id index for hrefs that carry no run id.
const placementByRun = new Map<string, Placement>();
const placementByWorkflowId = new Map<string, Placement>();

// ── Receiving rows ───────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
    // Both checks matter. `event.source !== window` rejects messages from
    // iframes; the source tag rejects the rest of the page's own postMessage
    // traffic, and a single-page app does have some.
    if (event.source !== window) return;
    const data = event.data as WorkflowsMessage | undefined;
    if (data?.source !== MESSAGE_SOURCE || data.type !== 'workflows') return;

    const ordered = buildTree(normalizeExecutions(data.executions));

    placementByRun.clear();
    placementByWorkflowId.clear();
    ordered.forEach((row, index) => {
        const placement: Placement = {
            sequence: index,
            depth: row.depth,
            segments: row.segments,
            row,
        };
        placementByRun.set(runKey(row.workflowId, row.runId), placement);
        placementByWorkflowId.set(row.workflowId, placement);
    });

    console.log(TAG, `${ordered.length} rows, ${countFamilies(ordered)} with children`);
    scheduleApply();
});

function lookup(workflowId: string, runId: string | null): Placement | undefined {
    if (runId) {
        const exact = placementByRun.get(runKey(workflowId, runId));
        if (exact) return exact;
    }
    return placementByWorkflowId.get(workflowId);
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
