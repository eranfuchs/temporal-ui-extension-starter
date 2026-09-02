// Everything that writes to the TABLE, and nothing else. (Two things this
// extension puts on the page live outside the table — the payload panel, which
// tooltip.ts owns, and the deep links on a single workflow's own page, which
// detailLinks.ts owns. Their class names are still declared here, with the others,
// so removeAllDecoration() below can take them away too, and the anchor writer the
// table and the workflow page both use lives here — see syncLinkAnchors.)
//
// Kept apart from content.ts on purpose: content.ts is wiring (messages,
// observer, settings) and cannot be unit-tested without a browser, while every
// function here runs against a jsdom table in milliseconds — including the
// idempotency check, which is the one property most likely to regress and the
// hardest to notice by eye (see tests/unit/render.spec.ts).
//
// Three rules govern this file. Each was learned the hard way in the internal
// extension this starter reimplements.
//
//  1. ANCHOR TO MEANING, NOT POSITION.
//     Rows are found by `a[href*="/workflows/"]`, never by column index or CSS
//     class. The UI is free to add a column, reorder them or rename a class,
//     and across versions it does all three.
//
//  2. EVERY WRITE IS IDEMPOTENT.
//     A MutationObserver drives these functions. An unconditional write wakes
//     the observer, which schedules another pass, which writes again — that is
//     not a slow render, it is 100% of a CPU core, forever. The fix is not a
//     longer debounce; it is comparing before writing, so that a pass with
//     nothing to do touches nothing at all.
//
//  3. NEVER FIGHT THE FRAMEWORK.
//     The UI re-renders on its own schedule and will throw our nodes away. We
//     do not try to prevent that. We re-apply, cheaply, after it settles.

import { expandTemplate, templatesInScope, type DeepLinkContext, type DeepLinkTemplate } from './links/deepLink';
import { formatAgePrecise, FRESH_FLOOR_MS, lastEventTitle, retryBadgeLabel, retryBadgeTitle } from './rowInfo/rowInfo';
import type { RowInfo } from './rowInfo/rowInfoClient';
import type { SegmentKind, WorkflowRow } from './types';

export const PREFIX_CLASS = 'tuis-prefix';
export const SEGMENT_CLASS = 'tuis-seg';
export const LINK_CLASS = 'tuis-link';
// A link whose template expanded to something we will not open. It still
// renders: a button that vanishes reads as a broken extension, and the title
// then has nowhere to explain itself.
export const LINK_BLOCKED_CLASS = 'tuis-link-blocked';
// The "Last event" column: one <th> in the header row, one <td> in every body row,
// both placed immediately after the workflow-id column. Both are needed for every
// row, always — a table where some rows have the extra cell and some do not is a
// table with a visibly broken layout, which is why the column is applied to the
// whole <tbody> at once rather than inside decorateRow().
export const LAST_EVENT_CLASS = 'tuis-last-event';
export const COLUMN_HEAD_CLASS = 'tuis-col-head';
// Inside that <th>: the word, and the button that re-asks. The label is a node of
// its own rather than a text child so that reading the header's own name does not
// mean stripping the button's glyph out of th.textContent — which the specs, and
// anyone debugging the column order, do have to do.
export const COLUMN_LABEL_CLASS = 'tuis-col-label';
export const COLUMN_REFRESH_CLASS = 'tuis-col-refresh';
// The retrying-activity badge, in the workflow-id cell beside the id.
export const RETRY_CLASS = 'tuis-retry';
// The per-row affordance that opens the payload panel. This file RENDERS it and
// knows nothing else about it — the hovering, the fetching and the panel itself are
// tooltip.ts, which finds these buttons by this class.
export const PAYLOAD_CLASS = 'tuis-payload';
// The floating payload panel. tooltip.ts builds it and this file only ever removes
// it (see removeAllDecoration), but the name lives here with the other class names,
// because two files needing the same string is exactly how a selector and the node
// it is meant to find drift apart.
export const PANEL_CLASS = 'tuis-panel';
// The two places detailLinks.ts writes on a single workflow's own page: a bar of
// workflow-scoped links beside the page's own tabs, and a group of activity-scoped
// links inside each activity's own panel. Same arrangement as PANEL_CLASS above, and
// for the same reason: a selector and the node it is meant to find must not be able
// to drift apart across two files.
export const LINK_BAR_CLASS = 'tuis-linkbar';
export const ACTIVITY_LINKS_CLASS = 'tuis-act-links';
export const OFF_CLASS = 'tuis-off';

const SEGMENTS_ATTR = 'data-tuis-segments';
const WORKFLOW_ID_ATTR = 'data-tuis-workflow-id';

// Must match `.tuis-seg { width }` in public/content.css. The link's indent is
// derived from it, so the two drifting apart lays the workflow id on top of the
// connector strokes.
export const SEGMENT_WIDTH_PX = 18;

export interface Placement {
    sequence: number;
    depth: number;
    segments: SegmentKind[];
    row: WorkflowRow;
}

export interface RenderOptions {
    treeEnabled: boolean;
    linksEnabled: boolean;
    // The `{ }` button. Costs nothing to draw and nothing to leave alone — the
    // requests happen on hover, in tooltip.ts, and not in a render pass.
    payloadsEnabled: boolean;
    // The two features fed by rowInfoClient.ts. Separate switches because they
    // cost one API request per running row EACH — see rowInfoServe.ts.
    lastEventEnabled: boolean;
    retryEnabled: boolean;
    links: DeepLinkTemplate[];
    namespace: string;
    // Injected rather than read from Date.now() so a test can pin the clock.
    nowMs: number;
    // What came back for a run, if anything has yet. Undefined means "not asked or
    // not answered", which is a third state and must not render as "nothing found".
    info: RowInfoLookup;
    // Pressed the refresh control in the column header. Wired in content.ts, which
    // is the only place that knows the namespace and which rows are on screen.
    //
    // Not optional: a header button whose handler was left off would look exactly
    // like a working one, so the type is what makes the wiring impossible to forget.
    onRefresh: () => void;
}

export type RowInfoLookup = (workflowId: string, runId: string) => RowInfo | undefined;

export interface RenderStats {
    rowsSeen: number;
    rowsMatched: number;
    rowsIndented: number;
    reordered: boolean;
    // How many rows are currently showing a retry badge. Surfaced in the popup:
    // the number is the answer to "is anything stuck right now?", and a feature
    // whose effect cannot be seen from outside the page is hard to review.
    retryBadges: number;
}

export type PlacementLookup = (workflowId: string, runId: string | null) => Placement | undefined;

// The table order before we touched it, so switching the tree off puts the rows
// back instead of leaving them in family order until the next re-render.
//
// Best-effort by design: the UI recycles <tr> elements, so after a page change a
// recorded position describes an arbitrary-but-stable order rather than the true
// original. Still better than not restoring at all.
const originalPosition = new WeakMap<HTMLTableRowElement, number>();

// ── Finding things ───────────────────────────────────────────────────────────

// The first <tbody> that contains a workflow link. Not "the first table", not a
// class name: those differ between Temporal versions and between Cloud and OSS.
export function findWorkflowTbody(root: ParentNode = document): HTMLTableSectionElement | null {
    for (const tbody of Array.from(root.querySelectorAll('tbody'))) {
        if (tbody.querySelector('a[href*="/workflows/"]')) return tbody as HTMLTableSectionElement;
    }
    return null;
}

// Cloud href: /namespaces/{ns}/workflows/{workflowId}/{runId}/timeline
// OSS   href: /namespaces/{ns}/workflows/{workflowId}/{runId}/history
// Reserved characters in a workflow id are percent-encoded there, so the
// components come back needing a decode.
export function idsFromRow(tr: HTMLTableRowElement): { workflowId: string; runId: string | null } | null {
    // READ THE HREF FIRST — never trust a cached attribute for identity.
    //
    // The UI RECYCLES <tr> elements: the same DOM node is reused for a different
    // workflow, with only the link updated. Code that trusted its own marker
    // attribute reported the PREVIOUS row's workflow id after a recycle, pairing
    // a stale id with a live run id — two different workflows. Every lookup then
    // misses, and the only symptom is a tree that silently renders flat.
    const link = tr.querySelector<HTMLAnchorElement>('a[href*="/workflows/"]');
    if (!link) return null;
    const match = /\/workflows\/([^/?#]+)(?:\/([^/?#]+))?/.exec(link.getAttribute('href') ?? '');
    if (!match) return null;

    const workflowId = decodeURIComponent(match[1]!);
    const candidateRun = match[2] ? decodeURIComponent(match[2]) : null;
    // `/workflows/{id}/timeline` has no run segment — "timeline" is not a run id.
    const runId = candidateRun && isRunId(candidateRun) ? candidateRun : null;

    // The marker is written for debugging and for CSS hooks only, AFTER the
    // href has already decided the answer.
    if (tr.getAttribute(WORKFLOW_ID_ATTR) !== workflowId) tr.setAttribute(WORKFLOW_ID_ATTR, workflowId);
    return { workflowId, runId };
}

function isRunId(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function namespaceFromLocation(pathname: string): string | null {
    const match = /\/namespaces\/([^/]+)/.exec(pathname);
    return match ? decodeURIComponent(match[1]!) : null;
}

// ── Applying ─────────────────────────────────────────────────────────────────

export function applyToTable(
    tbody: HTMLTableSectionElement,
    lookup: PlacementLookup,
    options: RenderOptions,
): RenderStats {
    const trs = rowsOf(tbody);
    trs.forEach((tr, index) => {
        if (!originalPosition.has(tr)) originalPosition.set(tr, index);
    });

    const reordered = options.treeEnabled
        ? reorderIntoFamilies(tbody, trs, lookup)
        : restoreOriginalOrder(tbody, trs);

    // Re-read after a possible reorder so the decoration follows the rows.
    let rowsMatched = 0;
    let rowsIndented = 0;
    let retryBadges = 0;
    for (const tr of rowsOf(tbody)) {
        const ids = idsFromRow(tr);
        if (!ids) continue;
        const placement = lookup(ids.workflowId, ids.runId);
        if (placement) rowsMatched++;
        const decoration = decorateRow(tr, placement, options);
        if (decoration.indented) rowsIndented++;
        if (decoration.retrying) retryBadges++;
    }

    syncLastEventColumn(tbody, lookup, options);

    return { rowsSeen: trs.length, rowsMatched, rowsIndented, reordered, retryBadges };
}

function rowsOf(tbody: HTMLTableSectionElement): HTMLTableRowElement[] {
    return Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
}

// The rows this table is actually SHOWING, in table order.
//
// Deliberately not "the rows in the last list response": the page fetches more
// rows than it draws, and rowInfoClient.ts turns each of these into a request. The
// difference is the difference between paying for a screen and paying for a
// namespace.
export function visibleRows(tbody: HTMLTableSectionElement, lookup: PlacementLookup): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    for (const tr of rowsOf(tbody)) {
        const ids = idsFromRow(tr);
        const placement = ids ? lookup(ids.workflowId, ids.runId) : undefined;
        if (placement) rows.push(placement.row);
    }
    return rows;
}

function reorderIntoFamilies(
    tbody: HTMLTableSectionElement,
    trs: HTMLTableRowElement[],
    lookup: PlacementLookup,
): boolean {
    // Rows we have no data for keep their relative order and sort after the
    // rest, rather than being hidden or dropped. A row we cannot explain is
    // still a row the user asked to see.
    let unknownSequence = Number.MAX_SAFE_INTEGER / 2;
    const ranked = trs.map((tr) => {
        const ids = idsFromRow(tr);
        const placement = ids ? lookup(ids.workflowId, ids.runId) : undefined;
        return { tr, sequence: placement ? placement.sequence : unknownSequence++ };
    });
    ranked.sort((a, b) => a.sequence - b.sequence);

    // Rule 2. Without this check every pass re-appends every row, every
    // re-append wakes the observer, and the observer schedules the next pass.
    if (ranked.every((entry, i) => entry.tr === trs[i])) return false;
    for (const { tr } of ranked) tbody.appendChild(tr);
    return true;
}

function restoreOriginalOrder(tbody: HTMLTableSectionElement, trs: HTMLTableRowElement[]): boolean {
    const ranked = trs
        .map((tr) => ({ tr, position: originalPosition.get(tr) ?? Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.position - b.position);
    if (ranked.every((entry, i) => entry.tr === trs[i])) return false;
    for (const { tr } of ranked) tbody.appendChild(tr);
    return true;
}

function decorateRow(
    tr: HTMLTableRowElement,
    placement: Placement | undefined,
    options: RenderOptions,
): { indented: boolean; retrying: boolean } {
    const link = tr.querySelector<HTMLAnchorElement>('a[href*="/workflows/"]');
    const cell = link?.closest('td');
    if (!link || !cell) return { indented: false, retrying: false };

    const segments = options.treeEnabled ? (placement?.segments ?? []) : [];
    syncTreePrefix(cell, link, segments);
    syncDeepLinks(cell, placement, options);
    syncPayloadButton(cell, placement, options);
    const retrying = syncRetryBadge(cell, placement, options);
    // The call order above is NOT what decides the order on screen. See below.
    syncControlOrder(cell);
    return { indented: segments.length > 0, retrying };
}

// The left-to-right order of the controls that share the workflow-id cell.
//
// Every one of them is created with appendChild, so DOM order is really the order
// the features were switched ON in: turn the deep links on after the payload
// button and they land to its right, for that user, until storage is cleared.
// Two users on the same build then see two different rows, and neither can say
// why. The order is a decision, so it is stated once here and re-asserted on
// every pass rather than left to that history.
const CELL_CONTROL_ORDER = [LINK_CLASS, PAYLOAD_CLASS, RETRY_CLASS];

// Returns whether anything moved, which is also what makes it testable.
export function syncControlOrder(cell: HTMLTableCellElement): boolean {
    const rank = (node: Element): number =>
        CELL_CONTROL_ORDER.findIndex((className) => node.classList.contains(className));
    const controls = Array.from(cell.children).filter((node) => rank(node) >= 0);
    // sort() is stable, so several links keep the order the settings list gave them.
    const wanted = [...controls].sort((a, b) => rank(a) - rank(b));
    // Rule 2. Moving a node is a mutation like any other, and this runs on every
    // row of every pass — so a cell already in order must touch nothing.
    if (wanted.every((node, index) => node === controls[index])) return false;
    for (const node of wanted) cell.appendChild(node);
    return true;
}

// The retrying-activity badge. Returns whether one is now on this row.
//
// It reports a fact the workflow list itself cannot: a workflow whose activity has
// failed 900 times is still "Running", and looks exactly like one that is making
// progress. The number is the whole point of the badge.
//
// The TITLE never contains the failure message — see the note at the top of
// rowInfo.ts. That is a decision about what this project reads, not a formatting
// choice, and the string it does contain says so.
export function syncRetryBadge(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): boolean {
    const existing = cell.querySelector<HTMLSpanElement>(`:scope > .${RETRY_CLASS}`);
    const info = options.retryEnabled && placement
        ? options.info(placement.row.workflowId, placement.row.runId)
        : undefined;
    const retry = info?.retry;

    if (!retry || !info) {
        existing?.remove();
        return false;
    }

    const badge = existing ?? cell.ownerDocument.createElement('span');
    if (!existing) {
        badge.className = RETRY_CLASS;
        cell.appendChild(badge);
    }
    // Compare-then-write (rule 2). The attempt count changes every few seconds on
    // a genuinely stuck activity, so this one really does get re-written — which is
    // exactly why the unchanged case must not.
    const label = retryBadgeLabel(retry);
    if (badge.textContent !== label) badge.textContent = label;
    // From the reading, like the column — its "next attempt in 8s" is a statement
    // about the instant Temporal was asked, and the string it builds says so.
    const title = retryBadgeTitle(retry, info.observedAtMs);
    if (badge.title !== title) badge.title = title;
    return true;
}

// The "Last event" column, applied to the whole table at once.
//
// IT SITS IMMEDIATELY AFTER THE WORKFLOW-ID COLUMN, and that placement is the
// feature working. The question it answers — "is this one actually moving?" — is
// asked while reading the id; at the far right of a table the UI already fills to
// the edge, the answer is off-screen behind a horizontal scroll and nobody looks at
// it. On this rung it also has to share the id cell's neighbourhood with the payload
// button, which is why the button carries no row identity of its own: both are
// found by class, from the row they are in.
//
// It was appended to the end once, and appending really is simpler: the end of a row
// has to agree with nothing. Inserting has to agree with a column order the Temporal
// UI lets the user change, so the position is COMPUTED on every pass rather than
// being a constant — from each row's own id cell, and for the <thead>, which has no
// workflow link of its own to find, from the first body row that had one.
//
// Two properties that must survive the move:
//
//   • RECTANGULAR. Every body row gets exactly one cell and the header exactly one
//     <th> — including a row with no workflow link at all, whose cell is appended
//     instead. A cell in the wrong column is cosmetic; a row missing a cell puts
//     every header one column out from its data.
//   • IDEMPOTENT ABOUT POSITION, not only about text. Moving a node that is already
//     where it belongs is still a DOM write, the write wakes the MutationObserver
//     that called us, and the next pass moves it again — the same self-feeding loop
//     the compare-then-write on the text exists to avoid, one level up. So each half
//     asks where it already is before touching anything.
//
// THE AGES IT WRITES ARE FROZEN AT THE READING, not computed from the current clock,
// and that makes this whole function a pure function of the answers it was given.
// Feed it the same answers twice and it writes nothing the second time, however much
// wall-clock time has passed in between.
//
// It was briefly the other way round — an age against Date.now(), redrawn by a
// once-a-second ticker — and the number that produced was exactly right about the
// event it named and quietly wrong about everything else: it advanced every second
// while the fact under it was refreshed every 35, so a workflow that had moved on
// showed a stall climbing in real time. Second-resolution is worth having; a
// second-resolution measurement of something read half a minute ago is not.
export function syncLastEventColumn(
    tbody: HTMLTableSectionElement,
    lookup: PlacementLookup,
    options: RenderOptions,
): void {
    const table = tbody.closest('table');
    const headRow = table?.querySelector<HTMLTableRowElement>('thead tr') ?? null;

    if (!options.lastEventEnabled) {
        headRow?.querySelector(`:scope > .${COLUMN_HEAD_CLASS}`)?.remove();
        for (const cell of Array.from(tbody.querySelectorAll(`.${LAST_EVENT_CLASS}`))) cell.remove();
        return;
    }

    // Which column the ids are in. Our cell always goes AFTER the id cell, so its
    // own presence never shifts this number on a later pass.
    let idColumn: number | null = null;

    for (const tr of Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'))) {
        const idCell = tr.querySelector<HTMLAnchorElement>('a[href*="/workflows/"]')?.closest('td') ?? null;
        if (idCell && idColumn === null) idColumn = Array.from(tr.children).indexOf(idCell);

        let cell = tr.querySelector<HTMLTableCellElement>(`:scope > .${LAST_EVENT_CLASS}`);
        if (!cell) {
            cell = tr.ownerDocument.createElement('td');
            cell.className = LAST_EVENT_CLASS;
        }
        placeAfter(cell, idCell, tr);

        const ids = idsFromRow(tr);
        const placement = ids ? lookup(ids.workflowId, ids.runId) : undefined;
        const state = lastEventCellText(placement, options);
        if (cell.textContent !== state.text) cell.textContent = state.text;
        if (cell.title !== state.title) cell.title = state.title;
    }

    if (!headRow) return;
    let th = headRow.querySelector<HTMLTableCellElement>(`:scope > .${COLUMN_HEAD_CLASS}`);
    if (!th) th = buildColumnHead(headRow);
    // The UI's own headers with ours excluded, so an index counted here means the
    // same column it means in a body row.
    const theirs = Array.from(headRow.children).filter((node) => node !== th);
    placeAfter(th, idColumn === null ? null : (theirs[idColumn] ?? null), headRow);
    syncColumnRefresh(th, options);
}

// A circular arrow, and deliberately not the retry badge's `↻` (U+21BB): the two
// mean opposite things — one is "ask again", the other is "this workflow is stuck
// asking again" — and a column whose header repeated the badge's glyph would be
// inviting the reader to conflate them.
const REFRESH_GLYPH = '⟳';

// When refresh was last pressed. Module state rather than a property of the button,
// because the button is rebuilt from scratch every time the column is switched off
// and on again, and a floor that reset with the node would not be a floor.
let lastRefreshAtMs = Number.NEGATIVE_INFINITY;

function buildColumnHead(headRow: HTMLTableRowElement): HTMLTableCellElement {
    const doc = headRow.ownerDocument;
    const th = doc.createElement('th');
    th.className = COLUMN_HEAD_CLASS;
    th.title = 'Added by this extension. One history request per running row — see src/rowInfo/rowInfoServe.ts.';

    const label = doc.createElement('span');
    label.className = COLUMN_LABEL_CLASS;
    label.textContent = 'Last event';

    const refresh = doc.createElement('button');
    refresh.className = COLUMN_REFRESH_CLASS;
    // Explicit, because the default is `submit`. There is no form in a Temporal UI
    // table today, and a button that becomes a submit button the day somebody wraps
    // one around it is a bug that arrives without this file being touched.
    refresh.type = 'button';
    refresh.textContent = REFRESH_GLYPH;
    // A glyph is not an accessible name. The title carries the cost, because that is
    // the part a user is entitled to know before pressing it.
    refresh.setAttribute('aria-label', 'Refresh the last-event column');
    refresh.title =
        'Ask Temporal again for the most recent event of every running row on screen.\n' +
        'The column already refreshes as the page polls its own list; this asks now, ' +
        'and briefly disables itself afterwards because asking again immediately would ' +
        'return the same answer.';

    th.append(label, refresh);
    return th;
}

// Everything about the button that changes after it is built: which callback it
// calls, and whether pressing it right now would do anything.
//
// It re-asks for the LAST EVENT and the retry badge, and deliberately not for the
// payloads this stage adds: those are fetched on hover, one run at a time, so the
// thing that refreshes them is hovering again.
function syncColumnRefresh(th: HTMLTableCellElement, options: RenderOptions): void {
    const refresh = th.querySelector<HTMLButtonElement>(`:scope > .${COLUMN_REFRESH_CLASS}`);
    if (!refresh) return;

    // ASSIGNED, not added. A property assignment replaces the previous handler, so no
    // pass can stack a second one — and the button calls the current pass's callback
    // rather than the one that happened to be passed to the pass that built it.
    refresh.onclick = () => {
        // Date.now(), and NOT options.nowMs, which is the time of the render pass that
        // installed this handler. The handler outlives that pass: on a quiet page the
        // table renders once and nothing touches it again, so a press an hour later
        // was being stamped an hour early — and the next pass then measured a floor
        // that had already elapsed and re-enabled the button immediately. It is the
        // same clock either way (content.ts passes Date.now() as nowMs); what was
        // wrong was WHEN it had been read.
        lastRefreshAtMs = Date.now();
        refresh.disabled = true; // in this frame, rather than at the next pass
        options.onRefresh();
    };

    // FRESH_FLOOR_MS made visible: while the receiver would refuse to re-fetch, the
    // button says so instead of accepting a press that does nothing.
    //
    // This is the ONE thing in the column measured against the real clock, and
    // properly so — it describes how long ago the user pressed a button, which is a
    // live fact about this tab and not a fact read from Temporal. It needs a pass to
    // re-enable itself, and content.ts arms a single one-shot timer per press for
    // exactly that; there is no repeating timer anywhere in this feature.
    const blocked = options.nowMs - lastRefreshAtMs < FRESH_FLOOR_MS;
    if (refresh.disabled !== blocked) refresh.disabled = blocked;
}

// Put `node` immediately after `anchor`, or at the end of `parent` when there is no
// anchor to follow. Writes nothing when it is already in place — see the idempotency
// note above; this is the position half of compare-then-write.
function placeAfter(node: Element, anchor: Element | null, parent: Element): void {
    if (anchor) {
        if (node.previousElementSibling !== anchor) anchor.after(node);
        return;
    }
    if (node.parentElement !== parent) parent.appendChild(node);
}

// FOUR STATES, and telling them apart is the whole difficulty.
//
// "not asked yet", "asked and it failed", "answered with nothing" and "answered"
// all look like an empty cell if they are allowed to. The first three are the ones
// that get mistaken for a broken extension.
function lastEventCellText(
    placement: Placement | undefined,
    options: RenderOptions,
): { text: string; title: string } {
    if (!placement) return { text: '', title: '' };
    if (placement.row.status !== 'Running') {
        // Not asked, on purpose: a closed workflow's last event cannot change, so
        // the request could never tell anyone anything.
        return { text: '', title: '' };
    }
    const info = options.info(placement.row.workflowId, placement.row.runId);
    if (!info) return { text: '…', title: 'Asking Temporal for this run’s most recent event.' };
    if (info.error) return { text: '!', title: info.error };
    if (!info.lastEvent) return { text: '—', title: 'Temporal returned no events for this run.' };
    // MEASURED FROM THE READING, NOT FROM NOW — info.observedAtMs, never
    // options.nowMs. This is the difference between "the newest event was 3m 00s old
    // when we asked, at 12:04:31" and a number that climbs on its own while nothing
    // is being fetched. It also makes this cell's text a pure function of the answer,
    // so a pass with no new answer writes nothing at all (rule 2 at the top).
    return {
        text: `${formatAgePrecise(info.lastEvent.timeMs, info.observedAtMs)} · ${info.lastEvent.eventType}`,
        title: lastEventTitle(info.lastEvent, info.observedAtMs),
    };
}

// The button that opens the payload panel.
//
// It carries NO row identity — no workflow id, no run id, not even a title that
// names one. That is what makes it correct under <tr> recycling: there is nothing
// on it that can go stale, so the panel resolves the row from the cell's own href
// at the moment of the hover (see tooltip.ts). It also makes this the cheapest
// possible write under rule 2 — once created, every later pass leaves it alone.
export function syncPayloadButton(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    const existing = cell.querySelector<HTMLButtonElement>(`:scope > .${PAYLOAD_CLASS}`);
    // No placement means we have no run id for this row, and the history request
    // needs one. A button that could only ever fail is worse than no button.
    if (!options.payloadsEnabled || !placement) {
        existing?.remove();
        return;
    }
    if (existing) return;

    const button = cell.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = PAYLOAD_CLASS;
    button.textContent = '{ }';
    button.title = 'Show this workflow’s input and result';
    button.setAttribute('aria-label', 'Show this workflow’s input and result');
    cell.appendChild(button);
}

// The connectors are an absolutely-positioned overlay inside the id cell, and
// the link is pushed right to make room for them.
//
// Drawing them as text characters inside the link was the first attempt. It
// cannot work: the vertical strokes have to meet across the row boundary, and
// the cell's own padding sits in between, so the line breaks at every row.
export function syncTreePrefix(
    cell: HTMLTableCellElement,
    link: HTMLElement,
    segments: SegmentKind[],
): void {
    let prefix = cell.querySelector<HTMLSpanElement>(`:scope > .${PREFIX_CLASS}`);

    if (segments.length === 0) {
        if (prefix) prefix.remove();
        if (link.style.marginLeft) link.style.removeProperty('margin-left');
        return;
    }

    // Rebuild only when the shape changed. Comparing a signature keeps a
    // re-render with identical ancestry free.
    const signature = segments.join(',');
    if (!prefix || prefix.getAttribute(SEGMENTS_ATTR) !== signature) {
        prefix?.remove();
        prefix = cell.ownerDocument.createElement('span');
        prefix.className = PREFIX_CLASS;
        prefix.setAttribute(SEGMENTS_ATTR, signature);
        for (const kind of segments) {
            const segment = cell.ownerDocument.createElement('span');
            segment.className = `${SEGMENT_CLASS} ${SEGMENT_CLASS}-${kind}`;
            prefix.appendChild(segment);
        }
        cell.insertBefore(prefix, cell.firstChild);
    }

    const indent = `${segments.length * SEGMENT_WIDTH_PX}px`;
    if (link.style.marginLeft !== indent) link.style.marginLeft = indent;
}

export function syncDeepLinks(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    // WORKFLOW-SCOPED TEMPLATES ONLY. A template that mentions an activity token
    // has nothing to fill from a table row — there is no activity in a list row —
    // so its button belongs on a single workflow's own page and is drawn there by
    // detailLinks.ts. Rendering it here would produce a link with an unresolved
    // token in it on every row. See "TWO SCOPES, ONE VOCABULARY" in deepLink.ts.
    const wanted: DeepLinkTemplate[] =
        options.linksEnabled && placement ? templatesInScope(options.links, 'workflow') : [];
    syncLinkAnchors(
        cell,
        wanted.map((template) => ({
            template,
            context: { namespace: options.namespace, row: placement!.row, nowMs: options.nowMs },
        })),
    );
}

// One template, expanded against one context, plus anything the caller wants said
// in the anchor's title beyond what the expansion itself reports.
export interface LinkPlacement {
    template: DeepLinkTemplate;
    context: DeepLinkContext;
    // Appended to the title after the built-in notes. detailLinks.ts uses it to
    // disclose HOW an activity was matched, which is a fact about the link's
    // accuracy and belongs on the link rather than in a doc.
    notes?: string[];
}

// Writes a list of link anchors as the direct `.tuis-link` children of one
// container, reusing the ones already there.
//
// THE SAME WRITER FOR BOTH PAGES, and that is the point of it being here rather
// than duplicated in detailLinks.ts: the table's links and a workflow page's links
// must be styled the same, carry the same three hardening attributes, report an
// unopenable URL the same way, and — hardest to keep in step by eye — be idempotent
// in the same way. Two copies of this agreed for exactly as long as it took to add
// one field to one of them.
export function syncLinkAnchors(container: HTMLElement, wanted: LinkPlacement[]): void {
    const existing = Array.from(container.querySelectorAll<HTMLAnchorElement>(`:scope > .${LINK_CLASS}`));

    if (wanted.length === 0) {
        for (const node of existing) node.remove();
        return;
    }

    wanted.forEach((placement, index) => {
        const { template } = placement;
        const { url, href, unknownTokens } = expandTemplate(template.urlTemplate, placement.context);

        let anchor = existing[index];
        if (!anchor) {
            anchor = container.ownerDocument.createElement('a');
            anchor.className = LINK_CLASS;
            anchor.target = '_blank';
            // noopener/noreferrer: the destination is a third-party tool, and
            // window.opener would hand it a live handle on the Temporal tab.
            anchor.rel = 'noopener noreferrer';
            // Without this the Referer carries the namespace and the workflow id
            // to that third party on every click. The URL is what the user chose
            // to send; the referrer is not.
            anchor.referrerPolicy = 'no-referrer';
            container.appendChild(anchor);
        }
        // Compare-then-write throughout (rule 2).
        if (anchor.textContent !== template.label) anchor.textContent = template.label;

        // The href is the only value here that can DO anything, so it is the one
        // place that does not take the expanded URL on trust — see safeHref().
        // No href at all, rather than a disabled-looking one: an anchor without
        // it is unclickable, unfocusable and cannot be middle-clicked either.
        if (href === null) {
            if (anchor.hasAttribute('href')) anchor.removeAttribute('href');
        } else if (anchor.getAttribute('href') !== href) {
            anchor.setAttribute('href', href);
        }
        // toggle() with an explicit force is idempotent per spec: it returns
        // early when the token is already in the wanted state, so this does not
        // write the attribute on every pass.
        anchor.classList.toggle(LINK_BLOCKED_CLASS, href === null);

        const notes: string[] = [];
        if (href === null) {
            notes.push('Not opened: a link must be an absolute http:// or https:// URL.');
        }
        // On a workflow's own page the likeliest cause is a field Temporal has not
        // filled — a pending activity has no attempt count and no close time in the
        // history — so the title names the token rather than saying "something".
        if (unknownTokens.length > 0) notes.push(`Unknown tokens: ${unknownTokens.join(' ')}`);
        notes.push(...(placement.notes ?? []));
        const title = notes.length > 0 ? `${url}\n\n${notes.join('\n')}` : url;
        if (anchor.title !== title) anchor.title = title;
    });

    for (const extra of existing.slice(wanted.length)) extra.remove();
}

// Removes every trace of this extension from the page. Used by the master
// switch, so turning it off proves it is off rather than merely stopping
// further writes.
export function removeAllDecoration(root: ParentNode = document): void {
    const ours = [
        `.${PREFIX_CLASS}`,
        `.${LINK_CLASS}`,
        `.${PAYLOAD_CLASS}`,
        `.${RETRY_CLASS}`,
        // The panel is in this list even though it lives on <body> and not in a row,
        // and on this rung it is the one that matters most: it is the only node this
        // extension draws that has DECODED PAYLOAD TEXT in it. A panel left open
        // after the master switch would be personal data still on screen from an
        // extension the user has just turned off. tooltip.ts rebuilds it on demand.
        `.${PANEL_CLASS}`,
        // The workflow page's two link sites, for the same reason and one weaker:
        // "off" has to mean off, and they are the most visible thing this extension
        // draws, so leaving one behind is the clearest possible way to look like the
        // master switch does nothing — which is exactly what makes a security
        // reviewer stop believing the rest of the claims. detailLinks.ts rebuilds
        // them on demand.
        `.${LINK_BAR_CLASS}`,
        `.${ACTIVITY_LINKS_CLASS}`,
        // Both halves of the added column. Leaving the <th> behind would shift
        // every header label one cell to the left of its data.
        `.${LAST_EVENT_CLASS}`,
        `.${COLUMN_HEAD_CLASS}`,
    ].join(', ');
    for (const node of Array.from(root.querySelectorAll(ours))) {
        node.remove();
    }
    for (const link of Array.from(root.querySelectorAll<HTMLElement>('a[href*="/workflows/"]'))) {
        if (link.style.marginLeft) link.style.removeProperty('margin-left');
    }
}
