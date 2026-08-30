// ISOLATED-world script: wiring only.
//
// It listens for the rows that inject.ts saw the page fetch, folds them into a
// tree, and hands the result to render.ts. Every DOM write lives there, so this
// file stays small enough to read in one sitting.

import { buildTree, countFamilies } from './tree';
import { normalizeExecutions, runKey } from './rows';
import { loadSettings, onSettingsChanged, type Settings } from './settings';
import {
    applyToTable,
    findWorkflowTbody,
    namespaceFromLocation,
    OFF_CLASS,
    removeAllDecoration,
    type Placement,
    type RenderStats,
} from './render';
import { MESSAGE_SOURCE, type WorkflowsMessage } from './types';

const TAG = '[temporal-ui-starter]';

// What we know about the workflows the page has fetched: one entry per RUN, plus
// a workflow-id index for hrefs that carry no run id.
const placementByRun = new Map<string, Placement>();
const placementByWorkflowId = new Map<string, Placement>();

let settings: Settings = { enabled: true, treeEnabled: true, linksEnabled: true, links: [] };
let lastStats: RenderStats = { rowsSeen: 0, rowsMatched: 0, rowsIndented: 0, reordered: false };
let familyCount = 0;

// ── Receiving rows ───────────────────────────────────────────────────────────

window.addEventListener('message', (event: MessageEvent) => {
    // Both checks matter. `event.source !== window` rejects messages from
    // iframes; the source tag rejects the rest of the page's own postMessage
    // traffic, and a single-page app does have some.
    if (event.source !== window) return;
    const data = event.data as WorkflowsMessage | undefined;
    if (data?.source !== MESSAGE_SOURCE || data.type !== 'workflows') return;

    const ordered = buildTree(normalizeExecutions(data.executions));
    familyCount = countFamilies(ordered);

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

    console.log(TAG, `${ordered.length} rows, ${familyCount} with children`);
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
    const off = !settings.enabled;
    document.documentElement.classList.toggle(OFF_CLASS, off);
    if (off) {
        // Prove it is off rather than merely stopping: stale connectors left
        // behind after a toggle read as a broken extension, not a disabled one.
        removeAllDecoration();
        return;
    }

    const tbody = findWorkflowTbody();
    if (!tbody) return; // every page that is not the workflow list

    lastStats = applyToTable(tbody, lookup, {
        treeEnabled: settings.treeEnabled,
        linksEnabled: settings.linksEnabled,
        links: settings.links,
        namespace: namespaceFromLocation(location.pathname) ?? '',
        nowMs: Date.now(),
    });
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
    settings = await loadSettings();
    onSettingsChanged((next) => {
        settings = next;
        scheduleApply();
    });

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

// The popup cannot read the page — this extension holds no host permission — so
// it asks us instead. Deliberately read-only: a message handler that mutates is
// an entry point the page cannot reach but every other extension can.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if ((message as { type?: string } | null)?.type !== 'tuis-stats') return false;
    respond({
        onListPage: findWorkflowTbody() !== null,
        namespace: namespaceFromLocation(location.pathname),
        rowsKnown: placementByRun.size,
        families: familyCount,
        ...lastStats,
    });
    return false; // responded synchronously; nothing to keep the port open for
});

void start();
