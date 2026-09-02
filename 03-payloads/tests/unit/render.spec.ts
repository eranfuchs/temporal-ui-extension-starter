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
    applyToTable,
    COLUMN_HEAD_CLASS,
    findWorkflowTbody,
    idsFromRow,
    LAST_EVENT_CLASS,
    LINK_BAR_CLASS,
    LINK_CLASS,
    namespaceFromLocation,
    PANEL_CLASS,
    PAYLOAD_CLASS,
    PREFIX_CLASS,
    removeAllDecoration,
    RETRY_CLASS,
    SEGMENT_WIDTH_PX,
    visibleRows,
} from '../../src/render';
import { buildWorkflowTable, fakeRunId, rowOrder, workflowLink } from '../helpers';
import {
    A_RETRY,
    CHILD_A_RUN,
    CHILD_B_RUN,
    DONE_RUN,
    FAMILY,
    LIVE_RUN,
    MIXED,
    OPTIONS,
    PARENT_RUN,
    answers,
    lookupFor,
    mutationsDuring,
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
    it('leaves the table as it found it', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        applyToTable(tbody, lookupFor(FAMILY), {
            ...OPTIONS,
            linksEnabled: true,
            payloadsEnabled: true,
            lastEventEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }],
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

        removeAllDecoration(document);

        expect(
            document.querySelectorAll(
                `.${PREFIX_CLASS}, .${LINK_CLASS}, .${PAYLOAD_CLASS}, .${PANEL_CLASS}, .${RETRY_CLASS}, .${LINK_BAR_CLASS}, .${ACTIVITY_LINKS_CLASS}, .${LAST_EVENT_CLASS}, .${COLUMN_HEAD_CLASS}`,
            ),
        ).toHaveLength(0);
        expect(Array.from(tbody.querySelectorAll('a')).every((a) => a.style.marginLeft === '')).toBe(true);
    });
});

describe('namespaceFromLocation', () => {
    it('reads the namespace out of both UIs’ paths', () => {
        expect(namespaceFromLocation('/namespaces/sample-namespace/workflows')).toBe('sample-namespace');
        expect(namespaceFromLocation('/namespaces/with%20space/workflows/x/y/history')).toBe('with space');
        expect(namespaceFromLocation('/settings')).toBeNull();
    });
});
