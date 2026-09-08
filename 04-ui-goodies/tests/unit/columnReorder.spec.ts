// @vitest-environment jsdom
//
// src/list/columnReorder.ts: the single layout owner for column ORDER (drag +
// keyboard), and the handle that carries both. What matters here is not what
// the handle looks like but three properties a reader cannot see from the code
// alone — a settled table causes no further write (Rule 2), turning the
// feature off restores Temporal's own column order rather than freezing
// wherever a drag left it, and every action re-reads the column's live
// position rather than trusting where it was when the handle was drawn.
//
// Drag events carry a `dataTransfer` jsdom does not implement, so the drag
// tests below dispatch plain Events with a manually defined `clientX` instead
// of real DragEvents — exactly the gap the source's own header comment notes,
// and why the drag logic is driven by a closure variable rather than
// `dataTransfer.getData()`.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { COLUMN_DRAG_CLASS, COLUMN_DROP_AFTER_CLASS, COLUMN_DROP_BEFORE_CLASS } from '../../src/decoration';
import { EXTENSION_COLUMN_ATTR, HEADER_TESTID_PREFIX } from '../../src/list/columns';
import {
    installColumnDrag,
    installHoverResync,
    restoreColumnOrder,
    syncColumnDragHandles,
    syncColumnOrder,
    type ColumnReorderDeps,
} from '../../src/list/columnReorder';

// Checkbox (structural), three native columns and one of this extension's own
// — enough real columns for a reorder to have somewhere to go, and one
// structural column that must never move.
function buildTable(): { tbody: HTMLTableSectionElement; headRow: HTMLTableRowElement } {
    const table = document.createElement('table');
    const thead = table.appendChild(document.createElement('thead'));
    const headRow = thead.appendChild(document.createElement('tr'));
    headRow.appendChild(document.createElement('th')); // checkbox, structural
    for (const label of ['Workflow ID', 'Status', 'Type']) {
        const th = headRow.appendChild(document.createElement('th'));
        th.setAttribute('data-testid', `${HEADER_TESTID_PREFIX}${label}`);
        th.textContent = label;
    }
    const lastEventTh = headRow.appendChild(document.createElement('th'));
    lastEventTh.setAttribute(EXTENSION_COLUMN_ATTR, 'last-event');
    lastEventTh.textContent = 'Last event';

    const tbody = table.appendChild(document.createElement('tbody'));
    for (const values of [
        ['wf-0', 'Completed', 'Sample'],
        ['wf-1', 'Running', 'Sample'],
    ]) {
        const tr = tbody.appendChild(document.createElement('tr'));
        tr.appendChild(document.createElement('td')); // checkbox
        for (const value of values) {
            const td = tr.appendChild(document.createElement('td'));
            td.textContent = value;
        }
        const lastEventTd = tr.appendChild(document.createElement('td')); // last event, blank
        lastEventTd.setAttribute(EXTENSION_COLUMN_ATTR, 'last-event');
    }

    document.body.appendChild(table);
    return { tbody, headRow };
}

function headerKeys(headRow: HTMLTableRowElement): string[] {
    return Array.from(headRow.children).map(
        (th) =>
            th.getAttribute('data-testid')?.replace(HEADER_TESTID_PREFIX, '') ??
            th.getAttribute(EXTENSION_COLUMN_ATTR) ??
            'structural',
    );
}

function rowValues(tbody: HTMLTableSectionElement, rowIndex: number): string[] {
    return Array.from(tbody.children[rowIndex]!.children).map((td) => td.textContent ?? '');
}

beforeEach(() => {
    document.body.textContent = '';
});

describe('syncColumnOrder', () => {
    it('moves both the header and every body row to match, and structural columns never move', () => {
        const { tbody, headRow } = buildTable();
        const moved = syncColumnOrder(tbody, ['Type', 'Workflow ID', 'Status'], true);

        expect(moved).toBe(true);
        expect(headerKeys(headRow)).toEqual(['structural', 'Type', 'Workflow ID', 'Status', 'last-event']);
        expect(rowValues(tbody, 0)).toEqual(['', 'Sample', 'wf-0', 'Completed', '']);
        expect(rowValues(tbody, 1)).toEqual(['', 'Sample', 'wf-1', 'Running', '']);
    });

    it('is idempotent: applying the same order twice reports no move the second time', () => {
        const { tbody } = buildTable();
        syncColumnOrder(tbody, ['Status', 'Type'], true);
        expect(syncColumnOrder(tbody, ['Status', 'Type'], true)).toBe(false);
    });

    it('an empty order is a no-op: nothing to place, so nothing moves', () => {
        const { tbody, headRow } = buildTable();
        const before = headerKeys(headRow);
        expect(syncColumnOrder(tbody, [], true)).toBe(false);
        expect(headerKeys(headRow)).toEqual(before);
    });

    it('an unmentioned column keeps its relative position and sorts after every named one', () => {
        const { tbody, headRow } = buildTable();
        syncColumnOrder(tbody, ['Status'], true);
        // Status moves to just after the checkbox; Workflow ID, Type and Last
        // event — none of them named — keep their own relative order, after it.
        expect(headerKeys(headRow)).toEqual(['structural', 'Status', 'Workflow ID', 'Type', 'last-event']);
    });

    it('leaves a row alone whose cell count does not match the header, rather than guessing', () => {
        const { tbody, headRow } = buildTable();
        const shortRow = tbody.appendChild(document.createElement('tr'));
        shortRow.appendChild(document.createElement('td'));
        shortRow.firstElementChild!.textContent = 'only one cell';

        syncColumnOrder(tbody, ['Status', 'Workflow ID'], true);
        expect(shortRow.children).toHaveLength(1);
        expect(shortRow.firstElementChild!.textContent).toBe('only one cell');
        expect(headerKeys(headRow)).toEqual(['structural', 'Status', 'Workflow ID', 'Type', 'last-event']);
    });

    it('reconciles a row Temporal draws AFTER the header was already reordered, not only rows present at the time', () => {
        // The bug this pins: the early return above skipped the ENTIRE body-row
        // loop whenever the header already matched `order` — which is exactly
        // the state a freshly inserted native-order row arrives into, leaving it
        // one column out from an already-correct header forever.
        const { tbody, headRow } = buildTable();
        const order = ['Status', 'Workflow ID', 'Type'];
        syncColumnOrder(tbody, order, true);
        expect(headerKeys(headRow)).toEqual(['structural', 'Status', 'Workflow ID', 'Type', 'last-event']);

        const fresh = tbody.appendChild(document.createElement('tr'));
        fresh.appendChild(document.createElement('td')).textContent = ''; // checkbox
        for (const value of ['wf-2', 'Running', 'Sample']) {
            fresh.appendChild(document.createElement('td')).textContent = value;
        }
        const freshLastEvent = fresh.appendChild(document.createElement('td')); // last event, blank
        freshLastEvent.setAttribute(EXTENSION_COLUMN_ATTR, 'last-event');

        // The header does not need to move again — only the new row does.
        expect(syncColumnOrder(tbody, order, true)).toBe(true);
        expect(headerKeys(headRow)).toEqual(['structural', 'Status', 'Workflow ID', 'Type', 'last-event']);
        expect(rowValues(tbody, 2)).toEqual(['', 'Running', 'wf-2', 'Sample', '']);
    });

    it('reconciles a mix of already-tracked and freshly inserted rows in the same pass', () => {
        const { tbody } = buildTable();
        const order = ['Type', 'Status', 'Workflow ID'];
        syncColumnOrder(tbody, order, true); // both existing rows get tracked here

        const fresh = tbody.appendChild(document.createElement('tr'));
        fresh.appendChild(document.createElement('td')).textContent = '';
        for (const value of ['wf-2', 'Running', 'Sample']) {
            fresh.appendChild(document.createElement('td')).textContent = value;
        }
        const freshLastEvent = fresh.appendChild(document.createElement('td'));
        freshLastEvent.setAttribute(EXTENSION_COLUMN_ATTR, 'last-event');

        syncColumnOrder(tbody, order, true);

        expect(rowValues(tbody, 0)).toEqual(['', 'Sample', 'Completed', 'wf-0', '']);
        expect(rowValues(tbody, 1)).toEqual(['', 'Sample', 'Running', 'wf-1', '']);
        expect(rowValues(tbody, 2)).toEqual(['', 'Sample', 'Running', 'wf-2', '']);
    });

    it('turning the feature off restores the order Temporal drew, not whichever order was last applied', () => {
        const { tbody, headRow } = buildTable();
        syncColumnOrder(tbody, ['Type', 'Status', 'Workflow ID'], true); // scramble it first
        expect(headerKeys(headRow)).not.toEqual(['structural', 'Workflow ID', 'Status', 'Type', 'last-event']);

        expect(syncColumnOrder(tbody, [], false)).toBe(true);
        expect(headerKeys(headRow)).toEqual(['structural', 'Workflow ID', 'Status', 'Type', 'last-event']);
        expect(rowValues(tbody, 0)).toEqual(['', 'wf-0', 'Completed', 'Sample', '']);
    });

    it('restoreColumnOrder() is exactly that off-path, for removeAllDecoration()', () => {
        const { tbody, headRow } = buildTable();
        syncColumnOrder(tbody, ['Type', 'Status', 'Workflow ID'], true);
        expect(restoreColumnOrder(tbody)).toBe(true);
        expect(headerKeys(headRow)).toEqual(['structural', 'Workflow ID', 'Status', 'Type', 'last-event']);
        // Already restored: nothing left to do.
        expect(restoreColumnOrder(tbody)).toBe(false);
    });
});

describe('syncColumnDragHandles', () => {
    const deps: ColumnReorderDeps = { enabled: () => true, currentOrder: () => [], saveOrder: () => {} };

    it('adds one handle to every native or extension header, and none to the structural one', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, deps);
        const handles = headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`);
        expect(handles).toHaveLength(4); // Workflow ID, Status, Type, Last event — not the checkbox
        expect(headRow.children[0]!.querySelector(`.${COLUMN_DRAG_CLASS}`)).toBeNull();
    });

    it('is idempotent: a second pass adds nothing more', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, deps);
        syncColumnDragHandles(tbody, deps);
        expect(headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`)).toHaveLength(4);
    });

    it('is draggable and keyboard-focusable, and is a plain (non-submit) button', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, deps);
        const handle = headRow.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        expect(handle.tagName).toBe('BUTTON');
        expect(handle.type).toBe('button');
        expect(handle.draggable).toBe(true);
        expect(handle.tabIndex).not.toBe(-1);
    });

    it('does not trigger a click-to-sort handler on the header cell it sits in', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, deps);
        const sortHandler = vi.fn();
        const statusTh = headRow.children[2] as HTMLTableCellElement;
        statusTh.addEventListener('click', sortHandler);
        statusTh.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!.click();
        expect(sortHandler).not.toHaveBeenCalled();
    });

    // A handle left behind after this feature's OWN toggle goes off — as opposed
    // to the master switch, which removeAllDecoration() already sweeps by class —
    // would still be focusable and draggable, and dragging it would silently do
    // nothing: a control that looks live but is not.
    it('draws no handle at all when the feature starts disabled', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, { ...deps, enabled: () => false });
        expect(headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`)).toHaveLength(0);
    });

    it('removes every handle on the enabled → disabled transition', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, deps);
        expect(headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`)).toHaveLength(4);

        syncColumnDragHandles(tbody, { ...deps, enabled: () => false });
        expect(headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`)).toHaveLength(0);
    });

    it('re-enabling draws exactly one handle per column again, not a duplicate', () => {
        const { tbody, headRow } = buildTable();
        syncColumnDragHandles(tbody, deps);
        syncColumnDragHandles(tbody, { ...deps, enabled: () => false });
        syncColumnDragHandles(tbody, deps);
        expect(headRow.querySelectorAll(`.${COLUMN_DRAG_CLASS}`)).toHaveLength(4);
    });
});

describe('keyboard reordering on the handle', () => {
    function depsWithSpy(currentOrder: string[]): { deps: ColumnReorderDeps; saveOrder: ReturnType<typeof vi.fn> } {
        const saveOrder = vi.fn();
        return { deps: { enabled: () => true, currentOrder: () => currentOrder, saveOrder }, saveOrder };
    }

    it('ArrowRight moves the column one step right and saves the new full order', () => {
        const { tbody, headRow } = buildTable();
        const { deps, saveOrder } = depsWithSpy(['Workflow ID', 'Status', 'Type']);
        syncColumnDragHandles(tbody, deps);
        const handle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!; // Workflow ID

        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));

        // 'last-event' is not in currentOrder(), so it is "unmentioned" and
        // sorts to the end of the FULL order this saves — see effectiveKeyOrder().
        expect(saveOrder).toHaveBeenCalledWith(['Status', 'Workflow ID', 'Type', 'last-event']);
    });

    it('declines at the leading edge: nothing is saved', () => {
        const { tbody, headRow } = buildTable();
        const { deps, saveOrder } = depsWithSpy(['Workflow ID', 'Status', 'Type']);
        syncColumnDragHandles(tbody, deps);
        const handle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!; // already leftmost

        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
        expect(saveOrder).not.toHaveBeenCalled();
    });

    it('ignores every key that is not an arrow', () => {
        const { tbody, headRow } = buildTable();
        const { deps, saveOrder } = depsWithSpy(['Workflow ID', 'Status', 'Type']);
        syncColumnDragHandles(tbody, deps);
        const handle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;

        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(saveOrder).not.toHaveBeenCalled();
    });

    // syncColumnDragHandles() itself now removes the handle the moment the
    // feature goes off — see its own "removes every handle" test — so this is
    // no longer reachable through the normal per-pass lifecycle. It stays as a
    // defence-in-depth check on the listener itself: a handle that predates a
    // disable, because whatever called this went one pass without syncing
    // handles first, must still decline the keypress rather than trust that it
    // would not exist if the feature were really off.
    it('a handle built before the feature was disabled still declines the keypress', () => {
        const { tbody, headRow } = buildTable();
        const deps: ColumnReorderDeps = {
            enabled: () => true,
            currentOrder: () => ['Workflow ID', 'Status', 'Type'],
            saveOrder: vi.fn(),
        };
        syncColumnDragHandles(tbody, deps);
        const handle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;

        deps.enabled = () => false; // flips with no further syncColumnDragHandles pass
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        expect(deps.saveOrder).not.toHaveBeenCalled();
    });
});

describe('dragging a handle onto another header', () => {
    // installColumnDrag() wires document-level delegation with no teardown —
    // exactly one installation for this whole block, redirected through a
    // reassignable indirection, so tests do not accumulate listeners on the
    // shared jsdom `document` the way calling it once per `it()` would.
    let activeDeps: ColumnReorderDeps = { enabled: () => false, currentOrder: () => [], saveOrder: () => {} };

    beforeAll(() => {
        installColumnDrag({
            enabled: () => activeDeps.enabled(),
            currentOrder: () => activeDeps.currentOrder(),
            saveOrder: (order) => activeDeps.saveOrder(order),
        });
    });

    afterEach(() => {
        // Belt-and-suspenders reset of the module-level drag state, so a test
        // that asserts "no drag in progress" is not silently depending on the
        // previous test having ended in a drop or a dragend.
        document.dispatchEvent(new Event('dragend', { bubbles: true }));
        vi.restoreAllMocks();
    });

    function fire(target: Element, type: string, clientX: number): void {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clientX', { value: clientX, configurable: true });
        target.dispatchEvent(event);
    }

    function mockRects(rects: Map<Element, { left: number; width: number }>): void {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: Element,
        ): DOMRect {
            const rect = rects.get(this) ?? { left: 0, width: 0 };
            return {
                ...rect,
                top: 0,
                height: 0,
                right: rect.left + rect.width,
                bottom: 0,
                x: rect.left,
                y: 0,
                toJSON: () => ({}),
            } as DOMRect;
        });
    }

    it('moves the dragged column before the target when dropped on its left half', () => {
        const { tbody, headRow } = buildTable();
        const saveOrder = vi.fn();
        activeDeps = { enabled: () => true, currentOrder: () => ['Workflow ID', 'Status', 'Type'], saveOrder };
        syncColumnDragHandles(tbody, activeDeps);

        const workflowHandle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        const typeTh = headRow.children[3]!;
        mockRects(new Map([[typeTh, { left: 100, width: 100 }]])); // midpoint 150

        fire(workflowHandle, 'dragstart', 0);
        fire(typeTh, 'dragover', 120); // left half
        fire(typeTh, 'drop', 120);

        // 'last-event' is not in currentOrder(), so it sorts to the end of the
        // FULL order this saves — see effectiveKeyOrder().
        expect(saveOrder).toHaveBeenCalledWith(['Status', 'Workflow ID', 'Type', 'last-event']);
    });

    it('moves the dragged column after the target when dropped on its right half', () => {
        const { tbody, headRow } = buildTable();
        const saveOrder = vi.fn();
        activeDeps = { enabled: () => true, currentOrder: () => ['Workflow ID', 'Status', 'Type'], saveOrder };
        syncColumnDragHandles(tbody, activeDeps);

        const workflowHandle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        const typeTh = headRow.children[3]!;
        mockRects(new Map([[typeTh, { left: 100, width: 100 }]])); // midpoint 150

        fire(workflowHandle, 'dragstart', 0);
        fire(typeTh, 'dragover', 180); // right half
        fire(typeTh, 'drop', 180);

        expect(saveOrder).toHaveBeenCalledWith(['Status', 'Type', 'Workflow ID', 'last-event']);
    });

    it('marks and clears the drop-side class as the drag moves between headers', () => {
        const { tbody, headRow } = buildTable();
        activeDeps = { enabled: () => true, currentOrder: () => [], saveOrder: () => {} };
        syncColumnDragHandles(tbody, activeDeps);

        const workflowHandle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        const statusTh = headRow.children[2]!;
        const typeTh = headRow.children[3]!;
        mockRects(
            new Map([
                [statusTh, { left: 0, width: 100 }],
                [typeTh, { left: 100, width: 100 }],
            ]),
        );

        fire(workflowHandle, 'dragstart', 0);
        fire(statusTh, 'dragover', 10); // left half of Status
        expect(statusTh.classList.contains(COLUMN_DROP_BEFORE_CLASS)).toBe(true);

        fire(typeTh, 'dragover', 190); // moved on to the right half of Type
        expect(statusTh.classList.contains(COLUMN_DROP_BEFORE_CLASS)).toBe(false);
        expect(typeTh.classList.contains(COLUMN_DROP_AFTER_CLASS)).toBe(true);

        fire(typeTh, 'dragend', 0);
        expect(typeTh.classList.contains(COLUMN_DROP_AFTER_CLASS)).toBe(false);
    });

    it('ignores a dragover with no drag in progress: no mark is added', () => {
        const { tbody, headRow } = buildTable();
        activeDeps = { enabled: () => true, currentOrder: () => [], saveOrder: () => {} };
        syncColumnDragHandles(tbody, activeDeps);

        const statusTh = headRow.children[2]!;
        mockRects(new Map([[statusTh, { left: 0, width: 100 }]]));
        fire(statusTh, 'dragover', 10);
        expect(statusTh.classList.contains(COLUMN_DROP_BEFORE_CLASS)).toBe(false);
        expect(statusTh.classList.contains(COLUMN_DROP_AFTER_CLASS)).toBe(false);
    });

    it('declines a drop onto the structural checkbox column', () => {
        const { tbody, headRow } = buildTable();
        const saveOrder = vi.fn();
        activeDeps = { enabled: () => true, currentOrder: () => ['Workflow ID', 'Status', 'Type'], saveOrder };
        syncColumnDragHandles(tbody, activeDeps);

        const workflowHandle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        const checkboxTh = headRow.children[0]!;
        mockRects(new Map([[checkboxTh, { left: 0, width: 40 }]]));

        fire(workflowHandle, 'dragstart', 0);
        fire(checkboxTh, 'dragover', 10);
        fire(checkboxTh, 'drop', 10);

        expect(saveOrder).not.toHaveBeenCalled();
    });

    // syncColumnDragHandles() removes the handle the moment the feature goes
    // off (see its own "removes every handle" test), so a disabled pass has
    // nothing to dragstart from through the normal per-pass lifecycle. This
    // checks the listener itself, defence in depth: a handle that predates a
    // disable, with no further syncColumnDragHandles pass in between, must
    // still decline the drag rather than trust it would not exist.
    it('a handle built before the feature was disabled still declines the drag', () => {
        const { tbody, headRow } = buildTable();
        const saveOrder = vi.fn();
        activeDeps = { enabled: () => true, currentOrder: () => ['Workflow ID', 'Status', 'Type'], saveOrder };
        syncColumnDragHandles(tbody, activeDeps);

        const workflowHandle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        const typeTh = headRow.children[3]!;
        mockRects(new Map([[typeTh, { left: 100, width: 100 }]]));

        activeDeps = { ...activeDeps, enabled: () => false }; // flips with no further sync pass
        fire(workflowHandle, 'dragstart', 0);
        fire(typeTh, 'dragover', 120);
        fire(typeTh, 'drop', 120);

        expect(saveOrder).not.toHaveBeenCalled();
    });
});

describe('hover resync after a reorder', () => {
    // installHoverResync() wires one document-level mousemove listener with no
    // teardown — exactly one installation for this whole block, same reasoning
    // as installColumnDrag() above.
    beforeAll(() => {
        installHoverResync();
        // jsdom does not implement elementFromPoint at all — not even as a
        // stub — so vi.spyOn has nothing to override without this, the same
        // reason mockRects() above needs getBoundingClientRect to already
        // exist on the prototype. Checked through an untyped view of the
        // prototype: lib.dom.d.ts declares the method as always present, so a
        // direct `in`/typeof check on the typed prototype narrows the "absent"
        // branch to `never` and fails to compile.
        const proto = Document.prototype as unknown as Record<string, unknown>;
        if (typeof proto.elementFromPoint !== 'function') {
            proto.elementFromPoint = () => null;
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    function moveRealMouseTo(x: number, y: number): void {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
    }

    it('replays a synthetic hover at the last real cursor position after a reorder caused by a recent keyboard move', () => {
        const { tbody, headRow } = buildTable();
        // A real gesture through the actual keyboard handler — not a mock of
        // the gate — is what sets lastUserGestureAtMs inside columnReorder.ts.
        const deps: ColumnReorderDeps = {
            enabled: () => true,
            currentOrder: () => ['Workflow ID', 'Status', 'Type'],
            saveOrder: () => {},
        };
        syncColumnDragHandles(tbody, deps);
        const handle = headRow.children[1]!.querySelector<HTMLButtonElement>(`.${COLUMN_DRAG_CLASS}`)!;
        handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));

        moveRealMouseTo(50, 60);
        const target = tbody.children[1]!.children[2]!;
        vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
        const overSpy = vi.fn();
        const moveSpy = vi.fn();
        target.addEventListener('mouseover', overSpy);
        target.addEventListener('mousemove', moveSpy);

        // The next apply() pass, reading the order the keyboard move just saved.
        const moved = syncColumnOrder(tbody, ['Status', 'Workflow ID', 'Type'], true);

        expect(moved).toBe(true);
        expect(document.elementFromPoint).toHaveBeenCalledWith(50, 60);
        expect(overSpy).toHaveBeenCalledTimes(1);
        expect(moveSpy).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the pass caused no reorder (Rule 2 — no write, no resync)', () => {
        const { tbody } = buildTable();
        moveRealMouseTo(50, 60);
        const elementFromPointSpy = vi.spyOn(document, 'elementFromPoint');

        // Already in this order — syncColumnOrder must report no move.
        const moved = syncColumnOrder(tbody, ['Workflow ID', 'Status', 'Type'], true);

        expect(moved).toBe(false);
        expect(elementFromPointSpy).not.toHaveBeenCalled();
    });

    it('does not resync a reorder with no recent gesture, e.g. page load reapplying a saved order', () => {
        const { tbody } = buildTable();
        moveRealMouseTo(50, 60);
        const elementFromPointSpy = vi.spyOn(document, 'elementFromPoint');

        // Fake-advance the clock well past USER_GESTURE_RESYNC_WINDOW_MS from
        // right now — regardless of whatever gesture timestamp earlier tests
        // in this file left behind, it is definitely more than 2s in the past
        // relative to this. This is the exact page-load regression: a real
        // reorder, a real lastPointer on record, but no live cursor involved.
        vi.useFakeTimers();
        try {
            vi.setSystemTime(Date.now() + 10_000);
            const moved = syncColumnOrder(tbody, ['Type', 'Workflow ID', 'Status'], true);
            expect(moved).toBe(true);
            expect(elementFromPointSpy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
