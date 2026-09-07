// Column REORDER: the drag handle on every reorderable header, keyboard support
// on that same handle, and the single function that actually moves <th> and <td>
// nodes to match — the "single layout owner" for column order, the same role
// render.ts's reorderIntoFamilies()/restoreOriginalOrder() play for ROW order and
// syncControlOrder() plays for the controls inside one cell: one function decides
// the order, called once a pass, so no two features can each nudge it and fight.
//
// REORDERS THE REAL TABLE DOM DIRECTLY. Temporal's own "Configure Table" modal
// (the chevrons inside its hidden `ol.orderable-list`) is a second way to reach
// the same visual result, and the private extension this starter reimplements
// drives THAT modal instead of the table. Deliberately not copied here: driving
// a hidden modal is coupled to markup this extension has no contract with, for a
// result this file can produce by moving the nodes already on screen itself.
//
// WHAT "ENABLED" MEANS FOR ORDER, NOT JUST FOR THE HANDLES. Turning this feature
// off must put the table back the way Temporal drew it — leaving a previous drag
// in place with the handles gone would not look disabled, it would look broken,
// the same failure render.ts's restoreOriginalOrder() exists to prevent for rows.
// So syncColumnOrder() below captures the table's own order the FIRST time it
// ever sees a given <thead> row, before this file has touched it, and
// `enabled: false` (from the master switch, or from this feature's own toggle)
// replaces whatever `order` was passed with that capture.

import { COLUMN_DRAG_CLASS, COLUMN_DROP_AFTER_CLASS, COLUMN_DROP_BEFORE_CLASS } from '../decoration';
import { inlineHostOf, readColumns, type ColumnInfo } from './columns';
import { effectiveKeyOrder, moveKey, moveKeyBeside, reorderColumns } from './columnOrder';

export interface ColumnReorderDeps {
    // Read live, not captured once — the same contract every other document-level
    // delegate in this extension makes (installNotFilter, installPayloadTooltip):
    // a toggle flip must take effect on the very next drag or keypress, not the
    // next page load. Combines the master switch and this feature's own — see
    // content.ts.
    enabled: () => boolean;
    // The setting's raw, possibly-stale value — a deleted column, a column never
    // seen yet, or simply empty. Never trusted directly; every handler below
    // turns it into a full order with effectiveKeyOrder() first.
    currentOrder: () => readonly string[];
    saveOrder: (order: readonly string[]) => void;
}

// ── The layout owner ──────────────────────────────────────────────────────────

// The table's own column order, captured the first time this file ever sees a
// given <thead> row — before anything here has reordered it. `enabled: false`
// restores to THIS rather than freezing wherever the last drag left it; see the
// file header. A ONE-SHOT per head-row instance, not per pass: Temporal tears
// down and rebuilds the <thead> only on a real navigation or a "Configure
// Table" edit, and either gives us a <tr> we have never seen before, which is
// exactly what re-triggers the capture.
let capturedHeadRow: HTMLTableRowElement | null = null;
let capturedOrder: readonly string[] = [];

function captureOriginal(headRow: HTMLTableRowElement, columns: readonly ColumnInfo[]): void {
    if (capturedHeadRow === headRow) return;
    capturedHeadRow = headRow;
    capturedOrder = columns.filter((c) => c.origin !== 'structural').map((c) => c.key);
}

// Moves the header's <th> children and every body row's <td> children into the
// order `order` calls for — or, if `enabled` is false, back into the order
// captured above. Structural columns never move. Returns whether anything
// actually did, for the same reason reorderIntoFamilies() does: Rule 2 — a
// settled table must cause no write, or the observer that drives every render
// pass here schedules another one forever.
export function syncColumnOrder(tbody: HTMLTableSectionElement, order: readonly string[], enabled: boolean): boolean {
    const headRow = headRowFor(tbody);
    if (!headRow) return false;
    const columns = readColumns(headRow);
    captureOriginal(headRow, columns);

    const desired = reorderColumns(columns, enabled ? order : capturedOrder);
    if (desired.every((c, index) => c.index === index)) return false;

    for (const column of desired) headRow.appendChild(column.th);
    for (const tr of Array.from(tbody.children)) {
        const cells = Array.from(tr.children);
        // A row whose cell count does not match this header's is left alone
        // rather than guessed at — the same "decline, never guess" rule
        // findByKey() states in columns.ts.
        if (cells.length !== desired.length) continue;
        for (const column of desired) tr.appendChild(cells[column.index]!);
    }
    // Scoped to a RECENT drag or keyboard move, not every reorder: syncColumnOrder()
    // also runs on page load and on any other settings sync, reapplying a
    // previously-saved order with no live cursor involved at all. Resyncing then
    // used whatever stale lastPointer happened to be on record — e.g. wherever the
    // mouse rested on an unrelated PART of the page, seconds or minutes earlier —
    // and injected a phantom hover on a completely unrelated row on every fresh
    // page load. Measured: a fresh load with a saved custom column order showed
    // the native cluster on a row nobody had ever hovered, mouse held away from
    // the table entirely, until this gate was added.
    if (Date.now() - lastUserGestureAtMs <= USER_GESTURE_RESYNC_WINDOW_MS) resyncHoverAfterReorder();
    return true;
}

// ── Hover resync after a reorder ──────────────────────────────────────────────
//
// syncColumnOrder() above reorders <td>/<th> nodes that Temporal's own React
// tree renders and owns — a write React never asked for. Rarely (reproduced
// once live, on a real drag, not on a fixed trigger), it leaves Temporal's
// hover-tracked row-actions cluster attached to whatever row was hovered
// BEFORE the reorder rather than the row actually under the cursor after. A
// genuine mouse move fixes it immediately — the next real mouseover
// recomputes it correctly — which is consistent with an HTML5 drag suspending
// normal hover tracking for its duration and nothing replaying one once the
// drop lands. Rather than depend on knowing Temporal's exact mechanism, track
// the real cursor position continuously and replay a synthetic move there
// right after an actual reorder caused by a recent drag or keyboard move (see
// lastUserGestureAtMs above the call site) — the same events a genuine mouse
// move would have produced, at the position the mouse was last known to be.
let lastPointer: { x: number; y: number } | null = null;

// Sentinel for "no gesture yet" — Date.now() - 0 is always far past
// USER_GESTURE_RESYNC_WINDOW_MS, so a page that has never seen a drag or
// keyboard reorder correctly never resyncs.
let lastUserGestureAtMs = 0;
const USER_GESTURE_RESYNC_WINDOW_MS = 2_000;

// Installed ONCE from content.ts's start(), like installColumnDrag() below —
// document-level, so it keeps tracking regardless of which table (or no
// table) is currently on screen.
export function installHoverResync(): void {
    document.addEventListener(
        'mousemove',
        (event) => {
            lastPointer = { x: event.clientX, y: event.clientY };
        },
        { passive: true },
    );
}

function resyncHoverAfterReorder(): void {
    // No real cursor position observed yet (e.g. the very first pass after
    // load) — nothing was hovered, so there is nothing to desync.
    if (!lastPointer) return;
    const { x, y } = lastPointer;
    const target = document.elementFromPoint(x, y);
    if (!target) return;
    const init: MouseEventInit = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    target.dispatchEvent(new MouseEvent('mouseover', init));
    target.dispatchEvent(new MouseEvent('mousemove', init));
}

// The master-off and feature-off restore, named for what it does at its one
// call site in render.ts's removeAllDecoration() — "off" has to put columns
// back, not just take the handles away. Equivalent to
// `syncColumnOrder(tbody, [], false)`: the order argument does not matter once
// `enabled` is false.
export function restoreColumnOrder(tbody: HTMLTableSectionElement): boolean {
    return syncColumnOrder(tbody, [], false);
}

function headRowFor(tbody: HTMLTableSectionElement): HTMLTableRowElement | null {
    return tbody.closest('table')?.querySelector<HTMLTableRowElement>('thead tr') ?? null;
}

// ── The drag handle, and keyboard support on it ──────────────────────────────

const HANDLE_GLYPH = '⠿';

// Draws the handle idempotently on every reorderable header — one call per
// pass, like syncHeaderCopyButtons. Taking it off again is the master switch's
// job (removeAllDecoration, by class — see COLUMN_DRAG_CLASS in decoration.ts),
// not this function's.
export function syncColumnDragHandles(tbody: HTMLTableSectionElement, deps: ColumnReorderDeps): void {
    const headRow = headRowFor(tbody);
    if (!headRow) return;
    for (const column of readColumns(headRow)) {
        if (column.origin === 'structural') continue;
        if (column.th.querySelector(`.${COLUMN_DRAG_CLASS}`)) continue;
        // Beside the label, inside Temporal's own flex wrapper — see inlineHostOf().
        inlineHostOf(column.th).appendChild(buildHandle(column, deps));
    }
}

function buildHandle(column: ColumnInfo, deps: ColumnReorderDeps): HTMLButtonElement {
    const doc = column.th.ownerDocument;
    const button = doc.createElement('button');
    button.type = 'button'; // see rowInfoRender.ts's buildColumnHead() for why this is explicit
    button.className = COLUMN_DRAG_CLASS;
    button.textContent = HANDLE_GLYPH;
    button.draggable = true;
    button.setAttribute(
        'aria-label',
        `Reorder the ${column.label} column: drag it, or focus it and press the Left or Right arrow key.`,
    );
    button.title = 'Drag to move this column, or use the Left/Right arrow keys.';

    // Same reasoning as columnCopy.ts's stopHere: this sits inside a header cell
    // Temporal's own click-to-sort listens on, and pressing or dragging the
    // handle must not also re-sort the table.
    const stopHere = (event: Event): void => event.stopPropagation();
    button.addEventListener('pointerdown', stopHere);
    button.addEventListener('mousedown', stopHere);
    button.addEventListener('click', stopHere);

    button.addEventListener('keydown', (event) => {
        if (!deps.enabled()) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const found = liveColumnOf(button);
        if (!found) return;
        event.preventDefault();
        stopHere(event);
        // RE-READ, not the key this handle was built for — a keypress can land
        // any number of render passes after the header was last touched.
        const order = effectiveKeyOrder(readColumns(found.headRow), deps.currentOrder());
        const next = moveKey(order, found.key, event.key === 'ArrowLeft' ? -1 : 1);
        // Rule 2, extended to a storage write: declining to save when nothing
        // moved (already at an edge) is what keeps a held arrow key from
        // writing to chrome.storage.sync once per repeat-fire for no reason.
        if (next !== order) {
            lastUserGestureAtMs = Date.now();
            deps.saveOrder(next);
        }
    });

    return button;
}

// RE-READ, not the column a handle was built for — same rule as
// columnCopy.ts's copyColumn(): a keypress or a drop can land render passes
// after the header was last reordered or rebuilt.
function liveColumnOf(handle: Element): { headRow: HTMLTableRowElement; key: string } | null {
    const cell = handle.closest('th, td');
    const headRow = (cell?.closest('tr') ?? null) as HTMLTableRowElement | null;
    if (!cell || !headRow) return null;
    const column = readColumns(headRow).find((c) => c.th === cell);
    return column ? { headRow, key: column.key } : null;
}

// ── Dragging a handle onto another header ────────────────────────────────────
//
// Delegated at the document, like installNotFilter's relocate listener and
// installPayloadTooltip's hover — one set of listeners, not one per handle, for
// the same reason: header cells are Temporal's own, so there is nowhere to mark
// "already wired" on them the way syncColumnDragHandles() marks its own button.
//
// `draggingKey` — not dataTransfer.getData() — is what dragover and drop act
// on: it is set from OUR OWN handle at dragstart and never read back from the
// browser's drag payload, so this needs no working DataTransfer to behave
// correctly (jsdom's is largely unimplemented — see
// tests/unit/columnReorder.spec.ts). dataTransfer is still written to, because
// some browsers refuse to start a drag at all without it.
let draggingKey: string | null = null;
let dropTarget: Element | null = null;

// Installed ONCE, from content.ts's start() — same convention as
// installNotFilter. Every dependency is read live through `deps`.
export function installColumnDrag(deps: ColumnReorderDeps): void {
    document.addEventListener('dragstart', (event) => {
        if (!deps.enabled()) return;
        const handle = (event.target as Element | null)?.closest<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`);
        const found = handle ? liveColumnOf(handle) : null;
        if (!found) return;
        draggingKey = found.key;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', found.key);
        }
    });

    document.addEventListener('dragover', (event) => {
        if (!draggingKey) return;
        const th = (event.target as Element | null)?.closest('th');
        if (!th || !th.closest('thead')) {
            clearDropMark();
            return;
        }
        event.preventDefault(); // only preventDefault() makes this a valid drop target
        markDropTarget(th, dropsBefore(th, event));
    });

    document.addEventListener('drop', (event) => {
        if (!draggingKey) return;
        event.preventDefault();
        const th = (event.target as Element | null)?.closest('th');
        const before = th ? dropsBefore(th, event) : true;
        clearDropMark();
        const draggedKey = draggingKey;
        draggingKey = null;
        if (!deps.enabled() || !th || !draggedKey) return;

        const headRow = th.closest('tr') as HTMLTableRowElement | null;
        const columns = headRow ? readColumns(headRow) : [];
        // RE-RESOLVE the target, never the column shown when dragover last
        // marked it — the same rule every click handler in this extension
        // follows for its own column.
        const targetColumn = columns.find((c) => c.th === th);
        if (!targetColumn || targetColumn.origin === 'structural') return;

        const order = effectiveKeyOrder(columns, deps.currentOrder());
        const next = moveKeyBeside(order, draggedKey, targetColumn.key, before);
        if (next !== order) {
            lastUserGestureAtMs = Date.now();
            deps.saveOrder(next);
        }
    });

    document.addEventListener('dragend', () => {
        draggingKey = null;
        clearDropMark();
    });
}

function dropsBefore(th: Element, event: DragEvent): boolean {
    const rect = th.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2;
}

function markDropTarget(th: Element, before: boolean): void {
    if (dropTarget && dropTarget !== th) clearDropMark();
    th.classList.toggle(COLUMN_DROP_BEFORE_CLASS, before);
    th.classList.toggle(COLUMN_DROP_AFTER_CLASS, !before);
    dropTarget = th;
}

function clearDropMark(): void {
    if (!dropTarget) return;
    dropTarget.classList.remove(COLUMN_DROP_BEFORE_CLASS, COLUMN_DROP_AFTER_CLASS);
    dropTarget = null;
}
