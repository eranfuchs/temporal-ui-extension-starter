// @vitest-environment jsdom
//
// These specs exist because the two worst bugs this feature ever had were both
// invisible to a reading of the code and obvious to a DOM assertion:
//   • a non-idempotent write, which turned the MutationObserver into an infinite
//     render loop and 100% of a CPU core;
//   • trusting a cached attribute for row identity, which after the UI recycled a
//     <tr> reported the previous row's workflow id and made the tree render flat.
// Both are asserted below.

import { beforeEach, describe, expect, it } from 'vitest';

import {
    applyToTable,
    findWorkflowTbody,
    idsFromRow,
    namespaceFromLocation,
    PREFIX_CLASS,
    SEGMENT_WIDTH_PX,
    type Placement,
    type PlacementLookup,
} from '../../src/render';
import { buildTree } from '../../src/family/tree';
import { normalizeExecutions, runKey } from '../../src/family/rows';
import { apiWorkflow, buildWorkflowTable, fakeRunId, rowOrder, workflowLink } from '../helpers';
import type { TemporalApiWorkflow } from '../../src/types';

function lookupFor(executions: TemporalApiWorkflow[]): PlacementLookup {
    const ordered = buildTree(normalizeExecutions(executions));
    const byRun = new Map<string, Placement>();
    const byWorkflowId = new Map<string, Placement>();
    ordered.forEach((row, index) => {
        const placement: Placement = { sequence: index, depth: row.depth, segments: row.segments, row };
        byRun.set(runKey(row.workflowId, row.runId), placement);
        byWorkflowId.set(row.workflowId, placement);
    });
    return (workflowId, runId) =>
        (runId ? byRun.get(runKey(workflowId, runId)) : undefined) ?? byWorkflowId.get(workflowId);
}

// A family: parent + two children, with the children deliberately adjacent in
// the table but NOT next to their parent, the way a time-sorted list shows them.
const PARENT_RUN = fakeRunId(101);
const CHILD_A_RUN = fakeRunId(102);
const CHILD_B_RUN = fakeRunId(103);
const FAMILY: TemporalApiWorkflow[] = [
    apiWorkflow({ workflowId: 'parent', runId: PARENT_RUN, startTime: '2026-01-01T00:00:00Z' }),
    apiWorkflow({
        workflowId: 'child-a',
        runId: CHILD_A_RUN,
        startTime: '2026-01-01T00:01:00Z',
        parent: { workflowId: 'parent', runId: PARENT_RUN },
    }),
    apiWorkflow({
        workflowId: 'child-b',
        runId: CHILD_B_RUN,
        startTime: '2026-01-01T00:02:00Z',
        parent: { workflowId: 'parent', runId: PARENT_RUN },
    }),
    apiWorkflow({ workflowId: 'unrelated', startTime: '2026-01-01T00:03:00Z' }),
];

beforeEach(() => {
    document.body.textContent = '';
});

// jsdom delivers MutationObserver records in a microtask; a macrotask hop is the
// simplest way to be sure we have all of them.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mutationsDuring(action: () => void): Promise<MutationRecord[]> {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
    });
    action();
    await flush();
    observer.disconnect();
    return seen;
}

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

        const stats = applyToTable(tbody, lookupFor(FAMILY));

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
        ]);
        const lookup = lookupFor(FAMILY);

        applyToTable(tbody, lookup);
        const mutations = await mutationsDuring(() => {
            applyToTable(tbody, lookup);
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
        applyToTable(tbody, lookup);

        const recycled = Array.from(tbody.querySelectorAll('tr'))[1]!;
        expect(recycled.getAttribute('data-tuis-workflow-id')).toBe('child-a');

        // The page now shows a root in that same element.
        recycled.querySelector('a')!.replaceWith(workflowLink(document, { workflowId: 'unrelated' }));
        applyToTable(tbody, lookup);

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

        const stats = applyToTable(tbody, lookupFor(FAMILY));

        // Unknown rows are neither hidden nor dropped: a row we cannot explain is
        // still a row the user asked to see.
        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'mystery-1', 'mystery-2']);
        expect(stats.rowsSeen).toBe(4);
        expect(stats.rowsMatched).toBe(2);
    });
});

describe('namespaceFromLocation', () => {
    it('reads the namespace out of both UIs’ paths', () => {
        expect(namespaceFromLocation('/namespaces/sample-namespace/workflows')).toBe('sample-namespace');
        expect(namespaceFromLocation('/namespaces/with%20space/workflows/x/y/history')).toBe('with space');
        expect(namespaceFromLocation('/settings')).toBeNull();
    });
});
