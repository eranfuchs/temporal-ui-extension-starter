// Everything that writes to the page, and nothing else.
//
// Kept apart from content.ts on purpose: content.ts is wiring (messages, an
// observer) and cannot be unit-tested without a browser, while every function
// here runs against a jsdom table in milliseconds — including the idempotency
// check, which is the one property most likely to regress and the hardest to
// notice by eye (see tests/unit/render.spec.ts).
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

import type { SegmentKind, WorkflowRow } from './types';

export const PREFIX_CLASS = 'tuis-prefix';
export const SEGMENT_CLASS = 'tuis-seg';

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

export interface RenderStats {
    rowsSeen: number;
    rowsMatched: number;
    rowsIndented: number;
    reordered: boolean;
}

export type PlacementLookup = (workflowId: string, runId: string | null) => Placement | undefined;

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

export function applyToTable(tbody: HTMLTableSectionElement, lookup: PlacementLookup): RenderStats {
    const trs = rowsOf(tbody);
    const reordered = reorderIntoFamilies(tbody, trs, lookup);

    // Re-read after a possible reorder so the decoration follows the rows.
    let rowsMatched = 0;
    let rowsIndented = 0;
    for (const tr of rowsOf(tbody)) {
        const ids = idsFromRow(tr);
        if (!ids) continue;
        const placement = lookup(ids.workflowId, ids.runId);
        if (placement) rowsMatched++;
        if (decorateRow(tr, placement)) rowsIndented++;
    }

    return { rowsSeen: trs.length, rowsMatched, rowsIndented, reordered };
}

function rowsOf(tbody: HTMLTableSectionElement): HTMLTableRowElement[] {
    return Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
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

// Returns true when this row ended up indented (i.e. it is somebody's child).
function decorateRow(tr: HTMLTableRowElement, placement: Placement | undefined): boolean {
    const link = tr.querySelector<HTMLAnchorElement>('a[href*="/workflows/"]');
    const cell = link?.closest('td');
    if (!link || !cell) return false;

    const segments = placement?.segments ?? [];
    syncTreePrefix(cell, link, segments);
    return segments.length > 0;
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
