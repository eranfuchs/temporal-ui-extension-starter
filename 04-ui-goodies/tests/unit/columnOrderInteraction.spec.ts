// @vitest-environment jsdom
//
// The seam between two independent writers of column POSITION on the same
// header row: rowInfo/rowInfoRender.ts's "Last event" column, which places
// itself immediately after whichever cell currently holds the workflow link
// on every render pass, and list/columnReorder.ts's syncColumnOrder — the
// declared "single layout owner" for column order (see that file's own
// header comment). Each is correct and fully covered in isolation —
// renderRowInfo.spec.ts drives applyToTable alone, columnReorder.spec.ts
// drives syncColumnOrder against a static fixture that already has "Last
// event" sitting where it will stay — and that isolation is exactly what let
// a real bug through: content.ts used to call syncColumnOrder BEFORE
// applyToTable, so on every pass syncLastEventColumn ran a moment later and
// silently dragged "Last event" back beside the id column, undoing whatever
// position a drag or an arrow key had just given it. Fixed by moving
// syncColumnOrder's call to AFTER applyToTable, so it has the final word on
// every pass, the same as reorderIntoFamilies() does for row order. This file
// pins that contract directly, so a future edit that puts the two calls back
// in the wrong order fails here instead of only in a real browser.

import { describe, expect, it } from 'vitest';

import { syncColumnOrder } from '../../src/list/columnReorder';
import { HEADER_TESTID_PREFIX } from '../../src/list/columns';
import { applyToTable } from '../../src/render';
import { buildWorkflowTable } from '../helpers';
import { DONE_RUN, LIVE_RUN, MIXED, OPTIONS, lookupFor, resetRenderHarness } from '../renderHarness';

// Real `data-testid` attributes, not withHeader()'s plain-text ones — a
// column readColumns() cannot recognize as native is treated as structural
// and never moves, which would make this fixture unable to exercise the bug
// at all.
function withNativeHeader(tbody: HTMLTableSectionElement, labels: string[]): HTMLTableRowElement {
    const table = tbody.closest('table')!;
    const thead = table.ownerDocument.createElement('thead');
    const tr = thead.appendChild(table.ownerDocument.createElement('tr'));
    for (const label of labels) {
        const th = tr.appendChild(table.ownerDocument.createElement('th'));
        th.setAttribute('data-testid', `${HEADER_TESTID_PREFIX}${label}`);
        th.textContent = label;
    }
    table.insertBefore(thead, tbody);
    return tr;
}

function headerKeys(headRow: HTMLTableRowElement): string[] {
    return Array.from(headRow.children).map(
        (th) =>
            th.getAttribute('data-testid')?.replace(HEADER_TESTID_PREFIX, '') ??
            th.getAttribute('data-tuis-column') ??
            'structural',
    );
}

describe('syncColumnOrder vs. the “Last event” column’s own placement', () => {
    it('holds a custom order across a second render pass, even though applyToTable repositions "Last event" beside the id column every time', () => {
        resetRenderHarness();
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'done', runId: DONE_RUN },
        ]);
        const headRow = withNativeHeader(tbody, ['Workflow ID', 'Status']);

        // Pass 1, in the pipeline's real order: render first, then impose order.
        applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true });
        expect(headerKeys(headRow)).toEqual(['Workflow ID', 'last-event', 'Status']); // native placement: right after the id

        // A custom order that puts "Last event" at the far end — away from the id
        // column, which is exactly the placement syncLastEventColumn always wants
        // to undo.
        const order = ['Workflow ID', 'Status', 'last-event'];
        syncColumnOrder(tbody, order, true);
        expect(headerKeys(headRow)).toEqual(order);

        // Pass 2: applyToTable runs again, exactly as it does on every later
        // mutation the real page makes. syncLastEventColumn re-reads the id
        // column's CURRENT index and moves "Last event" back beside it — the same
        // move it always makes, and on its own would silently win here too.
        applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true });
        syncColumnOrder(tbody, order, true);

        expect(headerKeys(headRow)).toEqual(order);
    });
});
