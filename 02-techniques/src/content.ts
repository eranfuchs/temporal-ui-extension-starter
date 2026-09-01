// ISOLATED-world script: wiring only.
//
// It listens for the rows that inject.ts saw the page fetch, folds them into a
// tree, and hands the result to render.ts. Every DOM write lives there, so this
// file stays small enough to read in one sitting.

import { detailLinkStats, installDetailLinks, syncDetailLinks } from './detailLinks';
import { buildTree, countFamilies } from './tree';
import {
    emptyPlacementIndex,
    findPlacement,
    indexPlacements,
    judgeListResponse,
    normalizeExecutions,
    type PlacementIndex,
} from './rows';
import { loadSettings, onSettingsChanged, type Settings } from './settings';
import {
    applyToTable,
    findWorkflowTbody,
    namespaceFromLocation,
    OFF_CLASS,
    removeAllDecoration,
    visibleRows,
    type Placement,
    type RenderStats,
} from './render';
import { FRESH_FLOOR_MS, type RowInfoField } from './rowInfo';
import { clearRowInfo, installRowInfo, requestRowInfo, rowInfoFor } from './rowInfoClient';
import { MESSAGE_SOURCE, type WorkflowsMessage } from './types';

const TAG = '[temporal-ui-starter]';

// What we know about the workflows the page has fetched, indexed by run and by
// workflow id. Both the indexing and the lookup rules live in rows.ts, where
// they are pure and unit-tested; this file only decides WHEN to rebuild them.
let placements: PlacementIndex<Placement> = emptyPlacementIndex();

// The generation of the newest list response applied — see judgeListResponse().
let appliedGeneration = -1;

let settings: Settings = {
    enabled: true,
    treeEnabled: true,
    linksEnabled: true,
    links: [],
    lastEventEnabled: true,
    retryEnabled: true,
    // No links yet, so nothing to backfill a scope into; loadSettings() replaces this
    // whole object a moment later with the real answer.
    linkScopesSeeded: false,
};
let lastStats: RenderStats = {
    rowsSeen: 0,
    rowsMatched: 0,
    rowsIndented: 0,
    reordered: false,
    retryBadges: 0,
};
let familyCount = 0;
// Runs this tab has asked Temporal about, cumulatively. Reported in the popup —
// see the note there on why a cost gets a line of its own.
let runsAsked = 0;

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
    familyCount = countFamilies(ordered);

    placements = indexPlacements(ordered, (row, index) => ({
        sequence: index,
        depth: row.depth,
        segments: row.segments,
        row,
    }));

    console.log(TAG, `${ordered.length} rows, ${familyCount} with children`);
    scheduleApply();
});

function lookup(workflowId: string, runId: string | null): Placement | undefined {
    return findPlacement(placements, workflowId, runId);
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

    // BEFORE the table, because there is no table on the page this draws on. The
    // early return below is every page that is not the workflow list, and a single
    // workflow's own page is exactly that — hanging these links off the same pass but
    // after the return is how they would silently never appear.
    syncDetailLinks({
        // No switch of its own: these are link templates, so the links switch is the
        // switch. Their cost is one clone and parse of a response the page fetched
        // anyway (see detailWatch.ts), which is not worth a toggle.
        enabled: settings.linksEnabled,
        links: settings.links,
        pathname: location.pathname,
        nowMs: Date.now(),
    });

    const tbody = findWorkflowTbody();
    if (!tbody) return; // every page that is not the workflow list

    const namespace = namespaceFromLocation(location.pathname) ?? '';
    const nowMs = Date.now();
    lastStats = applyToTable(tbody, lookup, {
        treeEnabled: settings.treeEnabled,
        linksEnabled: settings.linksEnabled,
        lastEventEnabled: settings.lastEventEnabled,
        retryEnabled: settings.retryEnabled,
        links: settings.links,
        namespace,
        nowMs,
        // Bound to the namespace of the page being rendered. render.ts asks about a
        // row, which is a (workflowId, runId); the store is keyed per namespace too,
        // and this is where the third part comes from — the renderer never has to
        // learn about it, and cannot look a row up in the wrong namespace.
        info: (workflowId, runId) => rowInfoFor(namespace, workflowId, runId),
        onRefresh: refreshRowInfoNow,
    });

    // AFTER rendering, never before: what is on the table decides what to ask
    // about, and asking is the only thing this extension does that costs the
    // Temporal API anything. requestRowInfo() re-asks nothing it asked recently, so
    // running this on every pass is cheap by construction rather than by luck.
    const want: RowInfoField[] = [];
    if (settings.lastEventEnabled) want.push('lastEvent');
    if (settings.retryEnabled) want.push('retry');
    if (want.length > 0) runsAsked += requestRowInfo(namespace, want, visibleRows(tbody, lookup), nowMs);
}

// The refresh control in the column header. It has to re-read the table rather than
// use anything the render pass captured: what is on screen when the button is pressed
// is not necessarily what was on screen when the <th> was drawn.
//
// 'fresh' is the only caller of that mode anywhere in the extension — it skips the
// ask interval here and tells the MAIN world to skip its cached answer, subject to
// the floor that side enforces. See requestRowInfo() and FRESH_FLOOR_MS.
function refreshRowInfoNow(): void {
    const tbody = findWorkflowTbody();
    if (!tbody) return;
    const namespace = namespaceFromLocation(location.pathname) ?? '';
    const want: RowInfoField[] = [];
    if (settings.lastEventEnabled) want.push('lastEvent');
    if (settings.retryEnabled) want.push('retry');
    runsAsked += requestRowInfo(namespace, want, visibleRows(tbody, lookup), Date.now(), 'fresh');
    // So the button's own disabled state is painted now rather than at whatever the
    // next mutation turns out to be.
    scheduleApply();
    // And ONE more pass when the floor lifts, to re-enable it.
    //
    // This is the only timer in the feature, it is a one-shot rather than a heartbeat,
    // and it exists for the button and not for the column: the disabled state is the
    // one thing here measured against the real clock, so it is the one thing that
    // needs a pass at a particular time. A press during the countdown cannot happen
    // (the button is disabled), but a forged 'fresh' message could arrive from the
    // page and re-enter this function, so the handle is replaced rather than stacked.
    clearTimeout(refreshFloorTimer);
    refreshFloorTimer = setTimeout(scheduleApply, FRESH_FLOOR_MS);
}

let refreshFloorTimer: ReturnType<typeof setTimeout> | undefined;

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

// ── THERE IS NO TICKER, AND THAT IS THE DESIGN ───────────────────────────────
//
// The "Last event" column shows an age to the second, so the obvious thing is a
// setInterval that redraws it once a second. This file had one, briefly. It is worth
// saying why it went, because the argument for it is more persuasive than the code:
//
// The redraw was honest about cost — it fetched nothing, it recomputed ages from
// timestamps already in hand, and requestRowInfo()'s own interval meant a tick on a
// settled table posted no message. What it was not honest about was TIME. Each row's
// timestamp is read at most every 35 seconds; animating the subtraction made a
// 35-second-old fact look like a live measurement, so a workflow that had moved on
// two seconds ago displayed a stall counting upwards, to the second, convincingly.
//
// So the age is frozen at the instant the answer was read (observedAtMs, threaded
// from rowInfoServe.ts through to render.ts) and the cell's tooltip dates it. The
// column now changes when the data changes and at no other time, which is what a
// reader assumes a number on a screen means. Its cost is that a stall reads up to one
// ask interval younger than it is; the alternative — a truthful per-second age —
// costs a request per row per second, which is the load this feature is built to
// avoid.
//
// One consequence to keep in mind when adding anything time-dependent here: with no
// heartbeat, a decoration that depends on elapsed time will sit unchanged on a quiet
// page for as long as the page is quiet. Nothing else this extension draws is
// time-dependent — the tree, the links and the badge all describe state — and
// anything that becomes so needs its own answer to this, not a revived ticker.

async function start(): Promise<void> {
    settings = await loadSettings();
    onSettingsChanged((next) => {
        const rowInfoChanged =
            next.lastEventEnabled !== settings.lastEventEnabled || next.retryEnabled !== settings.retryEnabled;
        settings = next;
        // Turning one of these back on has to ask again straight away. Without
        // this, the ask-interval would keep the column empty for half a minute and
        // the toggle would look like it did nothing.
        if (rowInfoChanged) clearRowInfo();
        scheduleApply();
    });

    // One re-render per answer that arrives. scheduleApply() coalesces them to one
    // pass per animation frame, so a burst of answers is a handful of passes.
    installRowInfo(scheduleApply);

    // The same arrangement for a workflow page's own links, and the same coalescing:
    // a history page can be observed while the UI is still rendering the last one.
    installDetailLinks(scheduleApply);

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
        rowsKnown: placements.byRun.size,
        families: familyCount,
        runsAsked,
        ...detailLinkStats(),
        ...lastStats,
    });
    return false; // responded synchronously; nothing to keep the port open for
});

void start();
