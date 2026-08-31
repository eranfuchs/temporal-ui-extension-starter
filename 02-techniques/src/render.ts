// Everything that writes to the TABLE, and nothing else. (The one thing this
// extension puts on the page outside the table is the deep-link card on a single
// workflow's own page, which detailCard.ts owns; its class name is still declared
// here, with the others, so removeAllDecoration() below can take it away too.)
//
// Kept apart from content.ts on purpose: content.ts is wiring (messages,
// observer, settings) and cannot be unit-tested without a browser, while every
// function here runs against a jsdom table in milliseconds — including the
// idempotency check, which is the one property most likely to regress and the
// hardest to notice by eye (see tests/unit/render.spec.ts).
//
// Three rules govern this file. Each was learned the hard way in the internal
// extension this starter was extracted from.
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

import { expandTemplate, templatesInScope, type DeepLinkTemplate } from './deepLink';
import { formatAge, lastEventTitle, retryBadgeLabel, retryBadgeTitle } from './rowInfo';
import type { RowInfo } from './rowInfoClient';
import type { SegmentKind, WorkflowRow } from './types';

export const PREFIX_CLASS = 'tuis-prefix';
export const SEGMENT_CLASS = 'tuis-seg';
export const LINK_CLASS = 'tuis-link';
// A link whose template expanded to something we will not open. It still
// renders: a button that vanishes reads as a broken extension, and the title
// then has nowhere to explain itself.
export const LINK_BLOCKED_CLASS = 'tuis-link-blocked';
// The "Last event" column: one <th> appended to the header row, one <td> appended
// to every body row. Both are needed for every row, always — a table where some
// rows have the extra cell and some do not is a table with a visibly broken
// layout, which is why the column is applied to the whole <tbody> at once rather
// than inside decorateRow().
export const LAST_EVENT_CLASS = 'tuis-last-event';
export const COLUMN_HEAD_CLASS = 'tuis-col-head';
// The retrying-activity badge, in the workflow-id cell beside the id.
export const RETRY_CLASS = 'tuis-retry';
// The deep-link card on a single workflow's own page. detailCard.ts builds it and
// this file only ever removes it — same arrangement as PANEL_CLASS above, and for
// the same reason: a selector and the node it is meant to find must not be able to
// drift apart across two files.
export const CARD_CLASS = 'tuis-card';
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
    const retrying = syncRetryBadge(cell, placement, options);
    return { indented: segments.length > 0, retrying };
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
    const retry = options.retryEnabled && placement
        ? options.info(placement.row.workflowId, placement.row.runId)?.retry
        : undefined;

    if (!retry) {
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
    const title = retryBadgeTitle(retry, options.nowMs);
    if (badge.title !== title) badge.title = title;
    return true;
}

// The "Last event" column, applied to the whole table at once.
//
// Appended, never inserted: a column pushed into the middle would have to agree
// with the header's own column order, and the Temporal UI reorders and hides
// columns at the user's request. Appending needs to agree with nothing.
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

    if (headRow && !headRow.querySelector(`:scope > .${COLUMN_HEAD_CLASS}`)) {
        const th = headRow.ownerDocument.createElement('th');
        th.className = COLUMN_HEAD_CLASS;
        th.textContent = 'Last event';
        th.title = 'Added by this extension. One history request per running row — see src/rowInfoServe.ts.';
        headRow.appendChild(th);
    }

    for (const tr of Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'))) {
        let cell = tr.querySelector<HTMLTableCellElement>(`:scope > .${LAST_EVENT_CLASS}`);
        if (!cell) {
            cell = tr.ownerDocument.createElement('td');
            cell.className = LAST_EVENT_CLASS;
            tr.appendChild(cell);
        }
        const ids = idsFromRow(tr);
        const placement = ids ? lookup(ids.workflowId, ids.runId) : undefined;
        const state = lastEventCellText(placement, options);
        if (cell.textContent !== state.text) cell.textContent = state.text;
        if (cell.title !== state.title) cell.title = state.title;
    }
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
    return {
        text: `${formatAge(info.lastEvent.timeMs, options.nowMs)} · ${info.lastEvent.eventType}`,
        title: lastEventTitle(info.lastEvent, options.nowMs),
    };
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
    // detailCard.ts. Rendering it here would produce a link with an unresolved
    // token in it on every row. See "TWO SCOPES, ONE VOCABULARY" in deepLink.ts.
    const wanted: DeepLinkTemplate[] =
        options.linksEnabled && placement ? templatesInScope(options.links, 'workflow') : [];
    const existing = Array.from(cell.querySelectorAll<HTMLAnchorElement>(`:scope > .${LINK_CLASS}`));

    if (wanted.length === 0) {
        for (const node of existing) node.remove();
        return;
    }

    wanted.forEach((template, index) => {
        const { url, href, unknownTokens } = expandTemplate(template.urlTemplate, {
            namespace: options.namespace,
            row: placement!.row,
            nowMs: options.nowMs,
        });

        let anchor = existing[index];
        if (!anchor) {
            anchor = cell.ownerDocument.createElement('a');
            anchor.className = LINK_CLASS;
            anchor.target = '_blank';
            // noopener/noreferrer: the destination is a third-party tool, and
            // window.opener would hand it a live handle on the Temporal tab.
            anchor.rel = 'noopener noreferrer';
            // Without this the Referer carries the namespace and the workflow id
            // to that third party on every click. The URL is what the user chose
            // to send; the referrer is not.
            anchor.referrerPolicy = 'no-referrer';
            cell.appendChild(anchor);
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
        if (unknownTokens.length > 0) notes.push(`Unknown tokens: ${unknownTokens.join(' ')}`);
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
        `.${RETRY_CLASS}`,
        // The card is in this list even though it lives on <body> and not in a row:
        // "off" has to mean off, and it is the most visible thing this extension
        // draws, so leaving one behind is the clearest possible way to look like the
        // master switch does nothing — which is exactly what makes a security
        // reviewer stop believing the rest of the claims. detailCard.ts rebuilds it
        // on demand.
        `.${CARD_CLASS}`,
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
