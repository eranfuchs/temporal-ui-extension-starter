// ISOLATED-world script: wiring only.
//
// It listens for the rows that inject.ts saw the page fetch, folds them into a
// tree, and hands the result to render.ts, which draws it through the modules
// beside it. This file writes one thing to the page itself — the off-class on
// <html>, below — and nothing else, so it stays small enough to read in one
// sitting.

import { safeParse } from 'valibot';

import { detailLinkStats, installDetailLinks, syncDetailLinks } from './detail/detailLinks';
import { buildTree, countFamilies } from './family/tree';
import {
    emptyPlacementIndex,
    findPlacement,
    indexPlacements,
    judgeListResponse,
    normalizeExecutions,
    type PlacementIndex,
} from './family/rows';
import { loadSettings, onSettingsChanged, saveSettings, type Settings } from './settings';
import { OFF_CLASS, type Placement, type RenderStats } from './decoration';
import {
    applyToTable,
    findWorkflowTbody,
    idsFromRow,
    namespaceFromLocation,
    removeAllDecoration,
    selectedRows,
    visibleRows,
} from './render';
import { FRESH_FLOOR_MS, type RowInfoField } from './rowInfo/rowInfo';
import { clearRowInfo, installRowInfo, requestRowInfo, rowInfoFor } from './rowInfo/rowInfoClient';
import { installPayloadTooltip, removePayloadTooltip, resetPayloadState } from './payloads/tooltip';
import { syncHeaderCopyButtons } from './list/columnCopy';
import {
    installColumnDrag,
    installHoverResync,
    syncColumnDragHandles,
    syncColumnOrder,
    type ColumnReorderDeps,
} from './list/columnReorder';
import { installFilterAugment, installNotFilter, syncNotFilterHosts } from './list/filters';
import { findPageSizeSelect, syncPageSizeOption } from './list/pageSize';
import { buildComparisonClause } from './list/query';
import { syncExpandButton } from './family/expandButton';
import { workflowsMessageSchema, type WorkflowRow } from './types';

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
    payloadsEnabled: true,
    lastEventEnabled: true,
    retryEnabled: true,
    notFilterEnabled: true,
    familyEnabled: true,
    columnOrder: [],
    columnReorderEnabled: true,
    // Empty, and that is the whole egress story until the user fills it in.
    codecEndpoint: '',
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
        // That includes the ROW ORDER, which removeAllDecoration puts back — a table
        // still grouped into families with the connectors gone is the same failure
        // wearing a subtler face.
        removeAllDecoration();
        // And forget the payloads. removeAllDecoration() takes the panel off the
        // page, which is what a user can see; this drops the decoded text the tab
        // was still holding for it and the module's reference to the detached node,
        // which they cannot. On a rung whose cache contains other people's personal
        // data, "off" has to mean all three.
        removePayloadTooltip();
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

    // Two small conveniences with no settings toggle of their own — see
    // src/list/columnCopy.ts and src/list/pageSize.ts for why: neither changes
    // what data this extension asks Temporal for, so the master switch above is
    // the only gate either one needs.
    syncHeaderCopyButtons(tbody);
    // The room the "≠" button takes at a cell's edge, reserved on every eligible
    // cell now rather than on hover — see syncNotFilterHosts(). Its own toggle, not
    // just the master switch: off means no reserved room either.
    syncNotFilterHosts(tbody, settings.notFilterEnabled);
    const pageSizeSelect = findPageSizeSelect(document);
    if (pageSizeSelect) syncPageSizeOption(pageSizeSelect);

    const namespace = namespaceFromLocation(location.pathname) ?? '';
    const nowMs = Date.now();
    lastStats = applyToTable(tbody, lookup, {
        treeEnabled: settings.treeEnabled,
        linksEnabled: settings.linksEnabled,
        familyEnabled: settings.familyEnabled,
        buildFamilyHref,
        payloadsEnabled: settings.payloadsEnabled,
        lastEventEnabled: settings.lastEventEnabled,
        retryEnabled: settings.retryEnabled,
        links: settings.links,
        namespace,
        nowMs,
        // Bound to the namespace of the page being rendered. rowInfoRender.ts asks
        // about a row, which is a (workflowId, runId); the store is keyed per namespace
        // too, and this is where the third part comes from — the renderer never has to
        // learn about it, and cannot look a row up in the wrong namespace.
        info: (workflowId, runId) => rowInfoFor(namespace, workflowId, runId),
        onRefresh: refreshRowInfoNow,
    });

    // Column order: the layout owner for column position (list/columnReorder.ts),
    // and the handle a drag or the keyboard actually moves. Its own toggle too —
    // off restores Temporal's own column order, the same contract treeEnabled
    // has for row order (see removeAllDecoration in render.ts).
    //
    // INVARIANT: this runs AFTER applyToTable, not before.
    // Breaking it: applyToTable's syncLastEventColumn re-places "Last event" beside
    // the id column on every pass, silently undoing a drag or arrow-key move a
    // moment earlier. See docs/design-notes.md#two-owners-for-one-columns-position.
    syncColumnOrder(tbody, settings.columnOrder, settings.columnReorderEnabled);
    syncColumnDragHandles(tbody, columnReorderDeps);

    // AFTER rendering, never before: what is on the table decides what to ask
    // about, and asking is the only thing this extension does that costs the
    // Temporal API anything. requestRowInfo() re-asks nothing it asked recently, so
    // running this on every pass is cheap by construction rather than by luck.
    const want: RowInfoField[] = [];
    if (settings.lastEventEnabled) want.push('lastEvent');
    if (settings.retryEnabled) want.push('retry');
    if (want.length > 0) runsAsked += requestRowInfo(namespace, want, visibleRows(tbody, lookup), nowMs);

    // The filter-bar button beside the table, not a cell inside it — see
    // family/expandButton.ts. Every dependency is read live for the same reason
    // installNotFilter's are: a toggle flip or a filter edit must take effect on
    // the very next click, not the next page load.
    syncExpandButton(document, expandDeps);
}

// Every workflow this tab currently knows about, family root included — the full
// last-list-response set, not visibleRows()'s on-screen subset. Collecting a root
// id costs nothing extra (family/rows.ts computes it once, when the list response
// arrives), so "Expand to families" gets the broader, more useful set for free.
function knownRows(): WorkflowRow[] {
    return Array.from(placements.byRun.values()).map((placement) => placement.row);
}

// The subset of knownRows() actually checked via Temporal's own native
// per-row checkbox right now — see render.ts's selectedRows() and
// family/expandButton.ts's ExpandDeps for why a click prefers this outright
// over knownRows() whenever it is non-empty. No table on screen (a
// navigation mid-click, a page that never had one) means nothing is
// checked, not a crash — same "decline rather than guess" shape as
// findWorkflowTbody()'s other callers.
function checkedRows(): WorkflowRow[] {
    const tbody = findWorkflowTbody();
    return tbody ? selectedRows(tbody, lookup) : [];
}

// One clause, not the OR-combination expand.ts builds — a single row's Family
// anchor replaces the query outright, the same as clicking a plain (non-Ctrl)
// native filter button. `null` when the id cannot be safely quoted; syncFamilyLink
// (family/familyRender.ts) is what turns that into "no href at all" on the anchor.
function buildFamilyHref(rootWorkflowId: string): string | null {
    const clause = buildComparisonClause('RootWorkflowId', '=', rootWorkflowId);
    if (clause === null) return null;
    const url = new URL(location.href);
    url.searchParams.set('query', clause);
    return url.toString();
}

// The drag handle and the keyboard reorder it carries — installed ONCE, like
// installNotFilter, with every dependency read live so a toggle flip or a
// storage write from another tab takes effect on the very next drag or
// keypress.
const columnReorderDeps: ColumnReorderDeps = {
    enabled: () => settings.enabled && settings.columnReorderEnabled,
    currentOrder: () => settings.columnOrder,
    saveOrder: (order) => {
        void saveSettings({ columnOrder: [...order] });
    },
};

const expandDeps = {
    enabled: () => settings.enabled && settings.familyEnabled,
    currentQuery: () => new URL(location.href).searchParams.get('query') ?? '',
    rows: knownRows,
    selectedRows: checkedRows,
    navigate: (url: string) => {
        location.href = url;
    },
};

// The refresh control in the column header. It has to re-read the table rather than
// use anything the render pass captured: what is on screen when the button is pressed
// is not necessarily what was on screen when the <th> was drawn.
//
// 'fresh' is the only caller of that mode anywhere in the extension — it skips the
// ask interval here and tells the MAIN world to skip its cached answer, subject to
// the floor that side enforces. See requestRowInfo() and FRESH_FLOOR_MS.
//
// It refreshes the two per-row questions and NOT the payloads: those are fetched on
// hover, one run at a time, and a control that re-fetched them for every row on
// screen would send this stage's decoded personal data through a codec server by the
// tableful, for one click. Hovering again is the way to re-read one.
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
// The redraw was honest about cost — it fetched nothing, it decoded nothing, it
// recomputed ages from timestamps already in hand, and requestRowInfo()'s own interval
// meant a tick on a settled table posted no message. What it was not honest about was
// TIME. Each row's timestamp is read at most every 35 seconds; animating the
// subtraction made a 35-second-old fact look like a live measurement, so a workflow
// that had moved on two seconds ago displayed a stall counting upwards, to the second,
// convincingly.
//
// So the age is frozen at the instant the answer was read (observedAtMs, threaded
// from rowInfoServe.ts through to rowInfo/rowInfoRender.ts) and the cell's tooltip
// dates it. The column now changes when the data changes and at no other time, which
// is what a reader assumes a number on a screen means. Its cost is that a stall reads
// up to one ask interval younger than it is; the alternative — a truthful per-second
// age — costs a request per row per second, which is the load this feature is built
// to avoid.
//
// One consequence to keep in mind when adding anything time-dependent here: with no
// heartbeat, a decoration that depends on elapsed time will sit unchanged on a quiet
// page for as long as the page is quiet. Nothing else this extension draws is
// time-dependent — the tree, the links, the badge and the payload panel all describe
// state — and anything that becomes so needs its own answer to this, not a revived
// ticker.

async function start(): Promise<void> {
    settings = await loadSettings();
    onSettingsChanged((next) => {
        const codecChanged = next.codecEndpoint !== settings.codecEndpoint;
        // A TRANSITION, not a state: this has to fire on the pass where the switch
        // moved, and not on every render pass while it is off. `apply()` is driven by
        // a MutationObserver, and doing this there would tear the panel down dozens
        // of times a second for as long as the feature stays disabled.
        const payloadsSwitchedOff = settings.payloadsEnabled && !next.payloadsEnabled;
        const rowInfoChanged =
            next.lastEventEnabled !== settings.lastEventEnabled || next.retryEnabled !== settings.retryEnabled;
        settings = next;
        // A payload that could not be decoded because no codec server was configured
        // must not stay undecodable in the cache after one is — that reads as the
        // setting having done nothing. It cuts the other way too: the cache must not
        // keep serving text that a NARROWER setting would no longer fetch.
        // It also closes an open panel, which is the point of its name: what is on
        // screen was decoded under the setting that just changed.
        if (codecChanged) resetPayloadState();
        // Rule 5 in tooltip.ts. The render pass takes the `{ }` buttons away because
        // they are in the table; the panel is on <body> and would otherwise stay
        // exactly where it was, showing a decoded payload under a switch that now
        // says off.
        if (payloadsSwitchedOff) removePayloadTooltip();
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

    // The NOT filter, and Ctrl/Cmd-additive combination for it and for Temporal's
    // own native filter button. Installed ONCE, like the hover panel below: both
    // are document-level delegates, and `enabled` reads the master switch AND the
    // feature's own toggle live, so a popup change takes effect on the very next
    // hover or click rather than the next page load.
    const notFilterDeps = {
        enabled: () => settings.enabled && settings.notFilterEnabled,
        navigate: (url: string) => {
            location.href = url;
        },
    };
    installNotFilter(notFilterDeps);
    installFilterAugment(notFilterDeps);

    // The column drag handle's drop targeting. Installed ONCE, document-level,
    // for the same reason installNotFilter's relocate listener is: header cells
    // are Temporal's own, so there is nowhere on them to mark "already wired".
    installColumnDrag(columnReorderDeps);
    // See list/columnReorder.ts's "Hover resync after a reorder" — tracks the
    // real cursor position so a reorder can replay a synthetic move there.
    installHoverResync();

    // The hover panel. Installed ONCE, with no reference to any row: it resolves a
    // row's identity from that row's own href at hover time, never from an attribute
    // written by an earlier render pass, because the rows are recycled (idsFromRow).
    //
    // Every dependency is a FUNCTION and not a value. The namespace and the codec
    // settings are both read at the moment of the hover — the tab navigates between
    // namespaces without reloading, and the popup can change the codec endpoint
    // while a list is open. Passing today's values here would pin both to whatever
    // they were when the page loaded.
    installPayloadTooltip({
        findRow: (tr) => {
            const ids = idsFromRow(tr);
            return ids ? (lookup(ids.workflowId, ids.runId)?.row ?? null) : null;
        },
        namespace: () => namespaceFromLocation(location.pathname) ?? '',
        // One field, and it is the only one there is. See CodecConfig in
        // payloadMessages.ts for why there is no credential switch beside it.
        codec: () => ({ endpoint: settings.codecEndpoint }),
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
        rowsKnown: placements.byRun.size,
        families: familyCount,
        runsAsked,
        ...detailLinkStats(),
        ...lastStats,
    });
    return false; // responded synchronously; nothing to keep the port open for
});

void start();
