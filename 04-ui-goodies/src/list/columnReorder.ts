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
import { EXTENSION_COLUMN_ATTR, inlineHostOf, readColumns, type ColumnInfo } from './columns';
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
// The NATIVE+structural key sequence only — never an extension key — captured
// alongside capturedOrder. What reconcileRow() below falls back to for an
// UNTAGGED row's NATIVE cells: Temporal draws a row's own native cells from its
// own column model, never from the DOM this file has rewritten, so a native
// cell this function has never touched is always still in this order,
// regardless of anything done to the header, to other rows, or to this
// extension's OWN column since. Extension keys are deliberately excluded: an
// extension cell carries its identity directly (EXTENSION_COLUMN_ATTR, set by
// the code that creates it — see reconcileRow()'s own comment), so including
// one here would only be a second, position-based source of truth for
// something that already has a first, and the two disagree the moment the
// column is toggled off and back on — see
// docs/design-notes.md#a-recreated-cell-is-not-a-fresh-cell.
let capturedNativeTemplate: readonly string[] = [];

function captureOriginal(headRow: HTMLTableRowElement, columns: readonly ColumnInfo[]): void {
    if (capturedHeadRow === headRow) return; // one-shot per <thead> row instance — see file header
    capturedHeadRow = headRow;
    capturedOrder = columns.filter((c) => c.origin !== 'structural').map((c) => c.key);
    capturedNativeTemplate = columns.filter((c) => c.origin !== 'extension').map((c) => c.key);
}

// The marker reconcileRow() writes on every cell it moves, so a LATER pass can
// tell which NATIVE key a cell represents without content-sniffing it — a
// native body cell carries no identity of its own (columns.ts's own header
// comment says so). A native cell with no marker yet has never been touched by
// this function, so it must still be in the native order captured above.
const ROW_ORDER_ATTR = 'data-tuis-order-key';

// One row, reconciled to `desiredKeys`. Declines — leaves the row alone, the same
// "decline, never guess" rule findByKey() states in columns.ts — when the cell
// count does not match the header, when the number of NATIVE cells (everything
// without EXTENSION_COLUMN_ATTR) does not match the captured native template,
// when some but not all of those native cells are already marked (a native
// cell inserted into a row this function had already reconciled once: there is
// no live way to tell which key the new one is), when two cells would claim the
// same key, or when a marked key is not actually one `desiredKeys` names.
// Returns whether it moved anything.
function reconcileRow(tr: HTMLTableRowElement, desiredKeys: readonly string[]): boolean {
    const cells = Array.from(tr.children) as HTMLElement[];
    if (cells.length !== desiredKeys.length) return false;

    // An extension cell (this file's own "Last event", and any future one)
    // carries its key directly — the exact marker its <th> is already found by
    // in columns.ts — so it is exactly as reliable freshly recreated after a
    // disable/re-enable cycle as it is ten reorders later. Only NATIVE and
    // structural cells, which Temporal draws and this file never creates or
    // destroys, need the position-based fallback below.
    const nativeCells = cells.filter((cell) => !cell.getAttribute(EXTENSION_COLUMN_ATTR));
    if (nativeCells.length !== capturedNativeTemplate.length) return false;

    const nativeTags = nativeCells.map((cell) => cell.getAttribute(ROW_ORDER_ATTR));
    const nativeFresh = nativeTags.every((tag) => tag === null);
    if (!nativeFresh && nativeTags.some((tag) => tag === null)) return false;

    let nextNative = 0;
    const currentKeys = cells.map((cell) => {
        const extKey = cell.getAttribute(EXTENSION_COLUMN_ATTR);
        if (extKey) return extKey;
        const index = nextNative++;
        return nativeFresh ? (capturedNativeTemplate[index] ?? '') : (nativeTags[index] ?? '');
    });
    if (new Set(currentKeys).size !== currentKeys.length) return false;
    if (currentKeys.every((key, index) => key === desiredKeys[index])) return false; // Rule 2: already there

    const byKey = new Map(cells.map((cell, index) => [currentKeys[index], cell] as const));
    const ordered: HTMLElement[] = [];
    for (const key of desiredKeys) {
        const cell = byKey.get(key);
        if (!cell) return false;
        ordered.push(cell);
    }
    for (const cell of ordered) tr.appendChild(cell);
    ordered.forEach((cell, index) => cell.setAttribute(ROW_ORDER_ATTR, desiredKeys[index]!));
    return true;
}

// Moves the header's <th> children and every body row's <td> children into the
// order `order` calls for — or, if `enabled` is false, back into the order
// captured above. Structural columns never move. Returns whether anything
// actually did, for the same reason reorderIntoFamilies() does: Rule 2 — a
// settled table must cause no write, or the observer that drives every render
// pass here schedules another one forever.
//
// Every row is reconciled, not only when the header itself just moved: a row
// Temporal drew AFTER the header last settled — a freshly inserted workflow, one
// whose cells this file has never touched — starts in native order and needs the
// same reconciliation the header just had, or its cells stay one column out from
// an ALREADY-correct header forever. See reconcileRow() above.
export function syncColumnOrder(tbody: HTMLTableSectionElement, order: readonly string[], enabled: boolean): boolean {
    const headRow = headRowFor(tbody);
    if (!headRow) return false;
    const columns = readColumns(headRow);
    captureOriginal(headRow, columns);

    const desired = reorderColumns(columns, enabled ? order : capturedOrder);
    const desiredKeys = desired.map((c) => c.key);
    let changed = false;

    if (!desired.every((c, index) => c.index === index)) {
        for (const column of desired) headRow.appendChild(column.th);
        changed = true;
    }

    for (const tr of Array.from(tbody.children)) {
        if (reconcileRow(tr as HTMLTableRowElement, desiredKeys)) changed = true;
    }

    if (!changed) return false;
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
// pass, like syncHeaderCopyButtons. Taking it off again on the MASTER switch is
// removeAllDecoration's job (by class — see COLUMN_DRAG_CLASS in decoration.ts),
// but this feature's OWN toggle has no other call site that runs every pass, so
// it has to check itself here: a handle left behind after the feature-level
// toggle went off would still be focusable and draggable, and dragging it would
// silently do nothing (installColumnDrag's own dragstart listener already
// declines on `!deps.enabled()`) — a control that looks live but is not.
export function syncColumnDragHandles(tbody: HTMLTableSectionElement, deps: ColumnReorderDeps): void {
    const headRow = headRowFor(tbody);
    if (!headRow) return;
    if (!deps.enabled()) {
        for (const handle of Array.from(headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`))) handle.remove();
        return;
    }
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
