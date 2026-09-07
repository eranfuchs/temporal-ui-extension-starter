// @vitest-environment jsdom
//
// The table itself: finding it, reading a row out of it, and drawing the tree into
// it without disturbing anything the UI put there.
//
// These specs exist because the two worst bugs this feature ever had were both
// invisible to a reading of the code and obvious to a DOM assertion:
//   • a non-idempotent write, which turned the MutationObserver into an infinite
//     render loop and 100% of a CPU core;
//   • trusting a cached attribute for row identity, which after the UI recycled a
//     <tr> reported the previous row’s workflow id and made the tree render flat.
// Both are asserted below.
//
// The per-feature specs are beside this file — renderLinks, renderPayloadButton and renderRowInfo — and share its
// fixtures through tests/renderHarness.ts.

import { beforeEach, describe, expect, it } from 'vitest';

import {
    ACTIVITY_LINKS_CLASS,
    COLUMN_HEAD_CLASS,
    LAST_EVENT_CLASS,
    LINK_BAR_CLASS,
    LINK_CLASS,
    PANEL_CLASS,
    PAYLOAD_INPUT_CLASS,
    PAYLOAD_OUTPUT_CLASS,
    PREFIX_CLASS,
    RETRY_CLASS,
    SEGMENT_WIDTH_PX,
} from '../../src/decoration';
import { NOT_FILTER_HOST_CLASS, NOT_FILTER_HOST_NATIVE_CLASS } from '../../src/decoration';
import {
    applyToTable,
    findWorkflowTbody,
    idsFromRow,
    namespaceFromLocation,
    removeAllDecoration,
    visibleRows,
} from '../../src/render';
import { buildWorkflowTable, fakeRunId, rowOrder, workflowLink } from '../helpers';
import {
    A_RETRY,
    answers,
    CHILD_A_RUN,
    CHILD_B_RUN,
    DONE_RUN,
    FAMILY,
    hostResorts,
    LIVE_RUN,
    lookupFor,
    MIXED,
    mutationsDuring,
    OPTIONS,
    PARENT_RUN,
    resetRenderHarness,
    withHeader,
} from '../renderHarness';

beforeEach(resetRenderHarness);

describe('finding the table', () => {
    it('picks the tbody that holds workflow links, not the first tbody on the page', () => {
        const decoy = document.createElement('table');
        decoy.appendChild(document.createElement('tbody')).appendChild(document.createElement('tr'));
        document.body.appendChild(decoy);
        const real = buildWorkflowTable(document, [{ workflowId: 'a', runId: fakeRunId(1) }]);
        expect(findWorkflowTbody(document)).toBe(real);
    });

    it('returns null on a page with no workflow table', () => {
        expect(findWorkflowTbody(document)).toBeNull();
    });
});

describe('reading a row', () => {
    it('reads ids out of the href, both UI shapes', () => {
        const runId = fakeRunId(2);
        const withRun = document.createElement('tr');
        withRun.appendChild(document.createElement('td')).appendChild(
            workflowLink(document, { workflowId: 'order|42', runId }),
        );
        expect(idsFromRow(withRun)).toEqual({ workflowId: 'order|42', runId });

        // Cloud's own link is /workflows/{id}/timeline — "timeline" is not a run.
        const withoutRun = document.createElement('tr');
        withoutRun.appendChild(document.createElement('td')).appendChild(
            workflowLink(document, { workflowId: 'order|42', runId: null }),
        );
        expect(idsFromRow(withoutRun)).toEqual({ workflowId: 'order|42', runId: null });
    });

    it('returns null for a row with no workflow link', () => {
        const tr = document.createElement('tr');
        tr.appendChild(document.createElement('td')).textContent = 'Loading…';
        expect(idsFromRow(tr)).toBeNull();
    });
});

describe('applyToTable', () => {
    it('groups children under their parent and indents them', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'unrelated' },
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);

        const stats = applyToTable(tbody, lookupFor(FAMILY), OPTIONS);

        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'child-b', 'unrelated']);
        expect(stats).toMatchObject({ rowsSeen: 4, rowsMatched: 4, rowsIndented: 2, reordered: true });

        const childRow = Array.from(tbody.querySelectorAll('tr'))[1]!;
        const prefix = childRow.querySelector(`.${PREFIX_CLASS}`)!;
        expect(prefix.getAttribute('data-tuis-segments')).toBe('branch');
        expect(prefix.children).toHaveLength(1);
        expect(childRow.querySelector('a')!.style.marginLeft).toBe(`${SEGMENT_WIDTH_PX}px`);

        // A root keeps its natural indent — no overlay, no margin.
        const parentRow = Array.from(tbody.querySelectorAll('tr'))[0]!;
        expect(parentRow.querySelector(`.${PREFIX_CLASS}`)).toBeNull();
        expect(parentRow.querySelector('a')!.style.marginLeft).toBe('');
    });

    it('writes nothing at all on a second pass', async () => {
        // THE most important assertion in this repository. A single unconditional
        // write here becomes an infinite loop in the browser, because the
        // MutationObserver that drives this function sees its own output.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
            // A RUNNING row as well. The two request-backed features draw nothing
            // on a closed workflow, so a family of closed ones would leave their
            // write paths — the newest ones — out of the one assertion that has to
            // cover all of them. (MIXED, withHeader, answers and A_RETRY are
            // declared with the specs for those features, further down this file.)
            { workflowId: 'live', runId: LIVE_RUN },
        ]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor([...FAMILY, ...MIXED]);
        // Everything on at once, so the assertion covers every write path in the
        // file rather than the tree alone.
        const options = {
            ...OPTIONS,
            linksEnabled: true,
            payloadsEnabled: true,
            lastEventEnabled: true,
            retryEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }],
            info: answers({
                live: {
                    lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: OPTIONS.nowMs - 180_000 },
                    retry: A_RETRY,
                },
            }),
        };

        applyToTable(tbody, lookup, options);
        // Every write path really did write on the first pass. Without this the test
        // would still pass if a feature drew nothing at all — an assertion about
        // idempotency is trivially satisfied by doing nothing twice.
        expect(tbody.querySelectorAll(`.${PREFIX_CLASS}`).length).toBeGreaterThan(0);
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`).length).toBeGreaterThan(0);
        // This stage's own control. Without it, deleting the syncPayloadButtons() call
        // would leave the assertion below green: nothing drawn is trivially idempotent.
        expect(tbody.querySelectorAll(`.${PAYLOAD_INPUT_CLASS}`).length).toBeGreaterThan(0);
        expect(tbody.querySelectorAll(`.${PAYLOAD_OUTPUT_CLASS}`).length).toBeGreaterThan(0);
        expect(tbody.querySelectorAll(`.${LAST_EVENT_CLASS}`).length).toBeGreaterThan(0);
        expect(document.querySelectorAll(`.${COLUMN_HEAD_CLASS}`)).toHaveLength(1);
        expect(tbody.querySelectorAll(`.${RETRY_CLASS}`)).toHaveLength(1);

        const mutations = await mutationsDuring(() => {
            applyToTable(tbody, lookup, options);
        });

        expect(mutations.map((m) => `${m.type} ${m.attributeName ?? ''}`.trim())).toEqual([]);
    });

    it('follows a recycled <tr> to its new workflow', async () => {
        // The UI reuses the same <tr> element for a different workflow and only
        // updates the link. Anything that caches identity on the element is wrong
        // from this moment on.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, OPTIONS);

        const recycled = Array.from(tbody.querySelectorAll('tr'))[1]!;
        expect(recycled.getAttribute('data-tuis-workflow-id')).toBe('child-a');

        // The page now shows a root in that same element.
        recycled.querySelector('a')!.replaceWith(workflowLink(document, { workflowId: 'unrelated' }));
        applyToTable(tbody, lookup, OPTIONS);

        expect(recycled.getAttribute('data-tuis-workflow-id')).toBe('unrelated');
        expect(recycled.querySelector(`.${PREFIX_CLASS}`)).toBeNull();
        expect(recycled.querySelector('a')!.style.marginLeft).toBe('');
    });

    it('leaves rows it has no data for in place, after the ones it knows', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'mystery-1' },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
            { workflowId: 'mystery-2' },
            { workflowId: 'parent', runId: PARENT_RUN },
        ]);

        const stats = applyToTable(tbody, lookupFor(FAMILY), OPTIONS);

        // Unknown rows are neither hidden nor dropped: a row we cannot explain is
        // still a row the user asked to see.
        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'mystery-1', 'mystery-2']);
        expect(stats.rowsSeen).toBe(4);
        expect(stats.rowsMatched).toBe(2);
    });

    it('restores the original order when the tree is switched off', () => {
        const original = [
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ];
        const tbody = buildWorkflowTable(document, original);
        const lookup = lookupFor(FAMILY);

        applyToTable(tbody, lookup, OPTIONS);
        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'child-b']);

        applyToTable(tbody, lookup, { ...OPTIONS, treeEnabled: false });
        expect(rowOrder(tbody)).toEqual(['child-b', 'parent', 'child-a']);
        expect(tbody.querySelectorAll(`.${PREFIX_CLASS}`)).toHaveLength(0);
        expect(Array.from(tbody.querySelectorAll('a')).every((a) => a.style.marginLeft === '')).toBe(true);
    });

    // ── The snapshot is a ONE-SHOT ────────────────────────────────────────────
    // Restoring an order is a claim about the past, and the past expires. Once the
    // rows are back where they started, the page owns the order again — the user is
    // free to sort by any column, and a disabled extension that keeps putting its
    // own remembered order back is no longer restoring anything, it is fighting the
    // UI's own controls. These two cases are the difference between "off" and
    // "off, and still moving the furniture".
    it('takes the page\'s own re-sort as the new baseline once the tree is off', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        const lookup = lookupFor(FAMILY);
        const off = { ...OPTIONS, treeEnabled: false };

        applyToTable(tbody, lookup, OPTIONS);
        applyToTable(tbody, lookup, off);
        expect(rowOrder(tbody)).toEqual(['child-b', 'parent', 'child-a']);

        const hostOrder = hostResorts(tbody);
        // The fixture's own control, and it has to compare against the RESTORED order
        // rather than against hostResorts' own return value: if the helper moved
        // nothing, the two would agree, and the assertion at the end of this test
        // would pass on the stale order it exists to reject.
        expect(hostOrder).not.toEqual(['child-b', 'parent', 'child-a']);

        // The observer schedules another disabled pass, as it does for any mutation.
        applyToTable(tbody, lookup, off);

        expect(rowOrder(tbody)).toEqual(hostOrder);
    });

    it('takes the page\'s own re-sort as the new baseline once the switch is off', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        const lookup = lookupFor(FAMILY);

        applyToTable(tbody, lookup, OPTIONS);
        removeAllDecoration(document);
        expect(rowOrder(tbody)).toEqual(['child-b', 'parent', 'child-a']);

        const hostOrder = hostResorts(tbody);
        expect(hostOrder).not.toEqual(['child-b', 'parent', 'child-a']);

        // content.ts calls this on every observed mutation while the switch is off,
        // and the host's re-sort IS an observed mutation.
        removeAllDecoration(document);

        expect(rowOrder(tbody)).toEqual(hostOrder);
    });
});


describe('visibleRows', () => {
    it('reports the rows the table is showing, in table order', () => {
        // This list is what becomes requests, one per running row, so it must be
        // the rows on SCREEN and not the rows in the last list response — the page
        // fetches more than it draws.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'done', runId: DONE_RUN },
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'not-in-the-api-response' },
        ]);
        const lookup = lookupFor(MIXED);

        expect(visibleRows(tbody, lookup).map((row) => row.workflowId)).toEqual(['done', 'live']);

        // …and in the order the tree put them, once the rows have been reordered.
        applyToTable(tbody, lookup, OPTIONS);
        expect(visibleRows(tbody, lookup).map((row) => row.workflowId)).toEqual(['live', 'done']);
    });
});

describe('removeAllDecoration', () => {
    it('removes every root it draws and leaves the table as it found it', () => {
        // Deliberately NOT in family order: the child comes first, as the UI's own
        // sort would have it. A fixture that starts in family order cannot tell
        // "put the rows back" apart from "never moved them", and this spec claims the
        // stronger of the two.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'child-a', runId: CHILD_A_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
        ]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        applyToTable(tbody, lookupFor(FAMILY), {
            ...OPTIONS,
            linksEnabled: true,
            payloadsEnabled: true,
            lastEventEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }],
            // Every feature that draws a root has to be ON here. An absence assertion
            // over something that was never drawn passes whatever the function does:
            // this spec used to assert the badge was gone without ever drawing one, so
            // deleting the badge from the list below would not have failed it.
            retryEnabled: true,
            info: answers({ 'child-a': { retry: A_RETRY } }),
        });
        // None of the three is in the table: the panel floats over one, the link bar
        // sits in a workflow page's own layout and an activity group sits inside a
        // panel of the UI's. The master switch has to take all three away, or "off"
        // does not mean off — and this function is the only place that knows the full
        // list. The payload panel is the one that matters most: it is the only node
        // this extension draws that has decoded payload text in it.
        const panel = document.createElement('div');
        panel.className = PANEL_CLASS;
        const bar = document.createElement('div');
        bar.className = LINK_BAR_CLASS;
        const activityLinks = document.createElement('span');
        activityLinks.className = ACTIVITY_LINKS_CLASS;
        document.body.append(panel, bar, activityLinks);

        // Same list as removeAllDecoration's, checked in both directions: which of
        // these is on the page before, and which after.
        const roots = [
            PREFIX_CLASS,
            LINK_CLASS,
            PAYLOAD_INPUT_CLASS,
            PAYLOAD_OUTPUT_CLASS,
            PANEL_CLASS,
            RETRY_CLASS,
            LINK_BAR_CLASS,
            ACTIVITY_LINKS_CLASS,
            LAST_EVENT_CLASS,
            COLUMN_HEAD_CLASS,
        ];
        const onThePage = (): string[] => roots.filter((className) => document.querySelector(`.${className}`) !== null);
        expect(onThePage()).toEqual(roots);
        // Not a root either: the classes list/filters.ts writes onto the page's OWN
        // cells to reserve the "≠" button's room. Stripped, never removed with the cell.
        const markedCell = tbody.querySelector('td')!;
        markedCell.classList.add(NOT_FILTER_HOST_CLASS, NOT_FILTER_HOST_NATIVE_CLASS);
        // The tree really did move the rows, so the assertion after cleanup is about
        // undoing something rather than about nothing having happened.
        expect(rowOrder(tbody)).toEqual(['parent', 'child-a']);

        removeAllDecoration(document);

        expect(onThePage()).toEqual([]);
        expect(Array.from(tbody.querySelectorAll('a')).every((a) => a.style.marginLeft === '')).toBe(true);
        // Not a node and not a style: the marker attribute, and the row ORDER — the
        // only edit this extension makes that leaves no trace of itself to find. A
        // table still in family order after the master switch is off looks like the
        // switch half-worked, which is worse than it not existing.
        expect(tbody.querySelectorAll('[data-tuis-workflow-id]')).toHaveLength(0);
        expect(markedCell.isConnected).toBe(true);
        expect(markedCell.classList.contains(NOT_FILTER_HOST_CLASS)).toBe(false);
        expect(markedCell.classList.contains(NOT_FILTER_HOST_NATIVE_CLASS)).toBe(false);
        expect(rowOrder(tbody)).toEqual(['child-a', 'parent']);
    });
});

describe('namespaceFromLocation', () => {
    it('reads the namespace out of both UIs’ paths', () => {
        expect(namespaceFromLocation('/namespaces/sample-namespace/workflows')).toBe('sample-namespace');
        expect(namespaceFromLocation('/namespaces/with%20space/workflows/x/y/history')).toBe('with space');
        expect(namespaceFromLocation('/settings')).toBeNull();
    });
});
