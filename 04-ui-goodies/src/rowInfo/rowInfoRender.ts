// The two things a row shows that the workflow list itself does not carry: the
// "Last event" column, and the retrying-activity badge.
//
// RESPONSIBILITY: write those two, idempotently, from answers somebody else
// fetched. It asks Temporal nothing — rowInfoClient.ts asks, rowInfoServe.ts
// decides whether a request happens at all, and this file only ever reads the
// answers out of RenderOptions.info.
//
// The column is the one render job that writes OUTSIDE the workflow-id cell — the
// <thead> and every body row — which is why it is applied to the whole <tbody> at
// once rather than per row. Rule 2 from render.ts governs both functions here,
// twice over: compare before writing TEXT, and ask where a node already is before
// MOVING it. A MutationObserver drives them, so an unconditional write schedules
// the pass that writes again. See docs/design-notes.md#why-each-of-the-four-files-exists.

import {
    COLUMN_HEAD_CLASS,
    COLUMN_LABEL_CLASS,
    COLUMN_REFRESH_CLASS,
    LAST_EVENT_CLASS,
    RETRY_CLASS,
    type Placement,
    type PlacementLookup,
    type RenderOptions,
} from '../decoration';
import { formatAgePrecise, FRESH_FLOOR_MS, lastEventTitle, retryBadgeLabel, retryBadgeTitle } from './rowInfo';

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
// IT SITS IMMEDIATELY AFTER THE WORKFLOW-ID COLUMN, and that placement is the feature
// working: the question it answers — "is this one actually moving?" — is asked while
// reading the id, and at the far right of a table the UI already fills to the edge the
// answer is behind a horizontal scroll where nobody looks. So the position is COMPUTED
// on every pass rather than being a constant, because the Temporal UI lets the user
// reorder the columns — from each row's own id cell, and for the <thead>, which has no
// workflow link of its own to find, from the first body row that had one.
//
// INVARIANT: RECTANGULAR. Every body row gets exactly one cell and the header exactly
// one <th>, including a row with no workflow link at all, whose cell is appended.
// Breaking it: a cell in the wrong column is cosmetic, but a row missing one puts
// every header a column out from its data.
//
// INVARIANT: IDEMPOTENT ABOUT POSITION, not only about text — each half asks where a
// node already is before moving it.
// Breaking it: the move wakes the MutationObserver that called us and the next pass
// moves it again. Rule 2 in render.ts, one level up.
//
// INVARIANT: the ages are FROZEN AT THE READING, never computed from the current
// clock, which makes this a pure function of the answers it was given — the same
// answers twice write nothing the second time.
// Breaking it: a stall that climbs second by second under a fact re-read every 35.
// See docs/design-notes.md#the-age-that-climbed-while-the-fact-stood-still.
export function syncLastEventColumn(
    tbody: HTMLTableSectionElement,
    lookup: PlacementLookup,
    options: RenderOptions,
    idsFromRow: (tr: HTMLTableRowElement) => { workflowId: string; runId: string | null } | null,
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
// It re-asks for exactly the two things this file draws, and nothing a stage fetches
// on hover instead of per row: the thing that refreshes a hover is hovering again.
function syncColumnRefresh(th: HTMLTableCellElement, options: RenderOptions): void {
    const refresh = th.querySelector<HTMLButtonElement>(`:scope > .${COLUMN_REFRESH_CLASS}`);
    if (!refresh) return;

    // ASSIGNED, not added. A property assignment replaces the previous handler, so no
    // pass can stack a second one — and the button calls the current pass's callback
    // rather than the one that happened to be passed to the pass that built it.
    refresh.onclick = () => {
        // INVARIANT: Date.now(), never options.nowMs — the handler outlives the pass
        // that installed it, so the pass's own timestamp is arbitrarily stale by the
        // time anyone presses this.
        // Breaking it: the floor below elapses instantly and the button never disables.
        // See docs/design-notes.md#the-press-that-was-stamped-an-hour-early.
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
//
// It lives here rather than beside the table code because the column is the only
// thing in this extension that INSERTS into a row it did not create. Everything else
// appends into the workflow-id cell.
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
    // info.observedAtMs, never options.nowMs — the frozen-at-the-reading invariant
    // stated above syncLastEventColumn(). "3m 00s old when we asked, at 12:04:31",
    // not a number that climbs on its own while nothing is being fetched.
    return {
        text: `${formatAgePrecise(info.lastEvent.timeMs, info.observedAtMs)} · ${info.lastEvent.eventType}`,
        title: lastEventTitle(info.lastEvent, info.observedAtMs),
    };
}
