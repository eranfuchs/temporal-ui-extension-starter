// The table itself: finding it, identifying its rows, ordering them into families,
// and driving one render pass over them.
//
// RESPONSIBILITY: table plumbing. What each control LOOKS like is somebody else's —
// rowInfo/rowInfoRender.ts writes the column and the retry badge, links/linkRender.ts
// writes the anchors, payloads/payloadButton.ts writes the Input/Output buttons, and
// decoration.ts holds the class names all of them share. This file decides which row
// is which, and in what order they appear.
//
// Kept apart from content.ts on purpose: content.ts is wiring (messages, observer,
// settings) and cannot be unit-tested without a browser, while every function here
// runs against a jsdom table in milliseconds — including the idempotency check, which
// is the one property most likely to regress and the hardest to notice by eye (see
// tests/unit/render.spec.ts).
//
// Three rules govern this file AND the three render modules it calls. Each was
// learned the hard way in the internal extension this starter reimplements.
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

import {
    FAMILY_LINK_CLASS,
    LINK_CLASS,
    PAYLOAD_INPUT_CLASS,
    PAYLOAD_OUTPUT_CLASS,
    PREFIX_CLASS,
    HOST_MARK_CLASSES, REMOVABLE_ROOT_CLASSES,
    RETRY_CLASS,
    SEGMENT_CLASS,
    SEGMENT_WIDTH_PX,
    type Placement,
    type PlacementLookup,
    type RenderOptions,
    type RenderStats,
} from './decoration';
import { syncFamilyLink } from './family/familyRender';
import { syncDeepLinks } from './links/linkRender';
import { syncPayloadButtons } from './payloads/payloadButton';
import { syncLastEventColumn, syncRetryBadge } from './rowInfo/rowInfoRender';
import type { SegmentKind, WorkflowRow } from './types';

const SEGMENTS_ATTR = 'data-tuis-segments';
const WORKFLOW_ID_ATTR = 'data-tuis-workflow-id';

// The table order before we touched it, so switching the tree off puts the rows
// back instead of leaving them in family order until the next re-render.
//
// INVARIANT: a recorded position is a ONE-SHOT. restoreOriginalOrder() deletes what
// it used, so the next disabled pass records whatever order the page is in now.
// Breaking it: the extension keeps re-imposing a remembered order on a table the
// user is sorting with the UI's own controls, while switched off.
// See docs/design-notes.md#a-restored-order-that-outlived-its-welcome.
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
    // href has already decided the answer. removeAllDecoration strips it.
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

    // The column is the one thing that is not per-row: it touches the <thead> and
    // every body row at once. idsFromRow is handed to it rather than imported by it,
    // because row identity is this file's job — passing the function keeps the
    // dependency pointing one way, from the table plumbing towards the modules that
    // draw, and never back.
    syncLastEventColumn(tbody, lookup, options, idsFromRow);

    return { rowsSeen: trs.length, rowsMatched, rowsIndented, reordered, retryBadges };
}

function rowsOf(tbody: HTMLTableSectionElement): HTMLTableRowElement[] {
    return Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
}

// The rows this table is actually SHOWING, in table order.
//
// Deliberately not "the rows in the last list response": the page fetches more
// rows than it draws, and rowInfo/rowInfoClient.ts turns each of these into a
// request. The difference is the difference between paying for a screen and paying
// for a namespace.
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

    // SPENT, and this delete is the load-bearing line rather than tidying up — see the
    // one-shot invariant on originalPosition above. Forgotten whether or not anything
    // moved, including on the early return below: "already in the recorded order" is
    // still a restore.
    for (const tr of trs) originalPosition.delete(tr);

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
    syncFamilyLink(cell, placement, options);
    syncDeepLinks(cell, placement, options);
    syncPayloadButtons(cell, placement, options);
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
//
// It is also the reason the three render modules do not need to know about each
// other: each appends its own node wherever it likes, and this settles the result.
//
// Why this order and not another: the badge is the loudest thing drawn here and
// the one worth finding at a glance, so it keeps the position closest to the id.
// Family comes next: it is built in rather than configured, the same reasoning
// that puts it ahead of the user's own links. The links come after because they
// are the reason most people install this, and the two payload buttons go last —
// each opens a panel that covers part of the row, so they are the controls that
// read better away from the id they belong to. Input before Output between the
// two of them: it is the order the workflow's own events happen in.
//
// The cost, stated because it is real and it is the argument for the other order:
// the number of deep links is whatever the settings list holds, so the buttons sit
// to the right of a variable-length list and shift when a user adds or removes a
// link. Accepted deliberately — 02 draws the same row without them, so the two
// projects differ by an append rather than by a rearrangement.
//
// This is the row drawn in both READMEs.
const CELL_CONTROL_ORDER = [RETRY_CLASS, FAMILY_LINK_CLASS, LINK_CLASS, PAYLOAD_INPUT_CLASS, PAYLOAD_OUTPUT_CLASS];

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

// Removes every trace of this extension from the page — in four kinds, because
// "trace" turned out to mean more than "node": the nodes it created, the one style it
// sets on a node the page owns, the one attribute it stamps on another, and the row
// ORDER, which is an edit that leaves nothing behind to find. Used by the master
// switch, so turning it off proves it is off rather than merely stopping further
// writes.
//
// The class list lives in decoration.ts and is built into a selector here, so the
// sweep and the file that documents it cannot disagree. What no list can know is that
// a new root exists at all — see the positive control in tests/unit/render.spec.ts.
export function removeAllDecoration(root: ParentNode = document): void {
    const ours = REMOVABLE_ROOT_CLASSES.map((className) => `.${className}`).join(', ');
    for (const node of Array.from(root.querySelectorAll(ours))) {
        node.remove();
    }
    for (const link of Array.from(root.querySelectorAll<HTMLElement>('a[href*="/workflows/"]'))) {
        if (link.style.marginLeft) link.style.removeProperty('margin-left');
    }
    // Not a node, and still a trace: the row marker stamped onto the page's own <tr>.
    // Nothing reads it back — identity comes from the href, deliberately (rule 1) — so
    // leaving it would change no behaviour. It comes off anyway, because "off" is a
    // claim about the DOM that a reader can check, and this, the indent above and the
    // cell marks below are the only three things written onto nodes this extension
    // did not create.
    for (const row of Array.from(root.querySelectorAll(`[${WORKFLOW_ID_ATTR}]`))) {
        row.removeAttribute(WORKFLOW_ID_ATTR);
    }
    // The room a cell reserves for the "≠" button (list/filters.ts) — stripped, not
    // removed: the cell is the page's own.
    for (const className of HOST_MARK_CLASSES) {
        for (const cell of Array.from(root.querySelectorAll(`.${className}`))) {
            cell.classList.remove(className);
        }
    }

    // And the row order, which is the whole point of this extension and the one edit
    // that leaves NOTHING behind for the sweep above to find. Taking the connectors
    // off a table still sorted into families is the worst of the three outcomes: it
    // does not look disabled, it looks broken. Idempotent like everything else — a
    // table already in its original order is not touched, so the observer this runs
    // under sees nothing. See docs/design-notes.md#off-left-the-table-sorted.
    const tbody = findWorkflowTbody(root);
    if (tbody) restoreOriginalOrder(tbody, rowsOf(tbody));
}
