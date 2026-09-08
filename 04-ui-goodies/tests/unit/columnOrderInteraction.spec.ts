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
import { buildWorkflowTable, workflowTr } from '../helpers';
import { DONE_RUN, LIVE_RUN, MIXED, OPTIONS, lookupFor, mutationsDuring, resetRenderHarness } from '../renderHarness';

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

    it('settles: a second full pass writes nothing once "Last event" holds a custom position', async () => {
        // Before the fix, syncLastEventColumn repositioned "Last event" back
        // beside the id column on EVERY pass, syncColumnOrder moved it right
        // back to the custom position, and both did that again on the pass
        // after — a settled table that never stopped writing.
        resetRenderHarness();
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'done', runId: DONE_RUN },
        ]);
        const headRow = withNativeHeader(tbody, ['Workflow ID', 'Status']);
        const order = ['Workflow ID', 'Status', 'last-event'];
        const pass = (): void => {
            applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true });
            syncColumnOrder(tbody, order, true);
        };

        pass();
        expect(headerKeys(headRow)).toEqual(order);

        const mutations = await mutationsDuring(pass);

        expect(headerKeys(headRow)).toEqual(order);
        expect(mutations).toEqual([]);
    });

    it('keeps every body cell aligned with its own header column when "Last event" sits BEFORE the id', () => {
        // The row-relative id-column index syncLastEventColumn computes and the
        // header-relative index syncColumnOrder places by are the same number
        // only when "Last event" comes AFTER the id. Putting it before flips
        // that, and a mismatch there misaligns every value under an otherwise
        // correctly-labelled header — the header alone was not enough to catch
        // this, which is why this checks content, not just header order.
        resetRenderHarness();
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'done', runId: DONE_RUN },
        ]);
        const headRow = withNativeHeader(tbody, ['Workflow ID', 'Status']);
        const order = ['last-event', 'Workflow ID', 'Status'];
        const pass = (): void => {
            applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true });
            syncColumnOrder(tbody, order, true);
        };

        pass();
        pass(); // a second full pass — the one the index mismatch showed up on

        expect(headerKeys(headRow)).toEqual(order);
        const idIndex = headerKeys(headRow).indexOf('Workflow ID');
        const statusIndex = headerKeys(headRow).indexOf('Status');
        for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
            expect(tr.children[idIndex]!.querySelector('a[href*="/workflows/"]')).not.toBeNull();
            expect(tr.children[statusIndex]!.textContent).toBe('Completed');
        }
    });

    // The three that follow are about the "Last event" column's own presence
    // changing, not just its position — a case the tests above never exercise,
    // since they only ever turn it on once and leave it there. Toggling it off
    // and back on used to corrupt list/columnReorder.ts's native-position
    // fallback in two different ways: a stale, wrongly-positioned template
    // (Finding 1), and a freshly recreated cell being unmarked while its
    // row-mates were not, which made reconcileRow() decline the whole row
    // forever (Finding 2). See docs/design-notes.md#a-recreated-cell-is-not-a-fresh-cell.
    // Checking only the header, or only Status, would miss both — the header
    // reorders correctly on its own; it is specifically the BODY cells that
    // land under the wrong header.
    describe('when "Last event" is toggled off and back on, not just added once', () => {
        it('keeps every body cell aligned when "Last event" is first enabled with nothing saved yet', () => {
            resetRenderHarness();
            const tbody = buildWorkflowTable(document, [
                { workflowId: 'live', runId: LIVE_RUN },
                { workflowId: 'done', runId: DONE_RUN },
            ]);
            const headRow = withNativeHeader(tbody, ['Workflow ID', 'Status']);
            const pass = (lastEventEnabled: boolean): void => {
                applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled });
                syncColumnOrder(tbody, [], true);
            };

            pass(false); // settles to native order with nothing to prefer
            pass(true); // the toggle's first flip — no saved order exists yet

            expect(headerKeys(headRow)).toEqual(['Workflow ID', 'last-event', 'Status']);
            const idIndex = headerKeys(headRow).indexOf('Workflow ID');
            const statusIndex = headerKeys(headRow).indexOf('Status');
            for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
                expect(tr.children[idIndex]!.querySelector('a[href*="/workflows/"]')).not.toBeNull();
                expect(tr.children[statusIndex]!.textContent).toBe('Completed');
            }
        });

        it('keeps every body cell aligned after "Last event" is disabled and re-enabled with the same saved order, and settles', async () => {
            resetRenderHarness();
            const tbody = buildWorkflowTable(document, [
                { workflowId: 'live', runId: LIVE_RUN },
                { workflowId: 'done', runId: DONE_RUN },
            ]);
            const headRow = withNativeHeader(tbody, ['Workflow ID', 'Status']);
            const order = ['last-event', 'Workflow ID', 'Status'];
            const pass = (lastEventEnabled: boolean): void => {
                applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled });
                syncColumnOrder(tbody, order, true);
            };

            pass(true);
            pass(false); // removes the extension header AND every extension cell
            pass(true); // recreates both, from scratch, unmarked

            expect(headerKeys(headRow)).toEqual(order);
            const idIndex = headerKeys(headRow).indexOf('Workflow ID');
            const statusIndex = headerKeys(headRow).indexOf('Status');
            for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
                expect(tr.children[idIndex]!.querySelector('a[href*="/workflows/"]')).not.toBeNull();
                expect(tr.children[statusIndex]!.textContent).toBe('Completed');
            }

            // And it settles: a further pass with nothing new to reconcile writes
            // nothing — Rule 2, the same property columnOrderInteraction's other
            // "settles" test checks for the simpler add-once case.
            const mutations = await mutationsDuring(() => pass(true));
            expect(mutations).toEqual([]);
        });

        it('reconciles a freshly inserted native row after "Last event" has been removed', () => {
            resetRenderHarness();
            const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
            const headRow = withNativeHeader(tbody, ['Workflow ID', 'Status']);
            const order = ['Status', 'Workflow ID', 'last-event'];
            const pass = (lastEventEnabled: boolean): void => {
                applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled });
                syncColumnOrder(tbody, order, true);
            };

            pass(true);
            pass(false); // removed again before the new row ever arrives
            tbody.append(workflowTr(document, { workflowId: 'fresh' }));
            pass(false);

            const idIndex = headerKeys(headRow).indexOf('Workflow ID');
            const statusIndex = headerKeys(headRow).indexOf('Status');
            for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
                expect(tr.children[idIndex]!.querySelector('a[href*="/workflows/"]')).not.toBeNull();
                expect(tr.children[statusIndex]!.textContent).toBe('Completed');
            }
        });
    });
});
