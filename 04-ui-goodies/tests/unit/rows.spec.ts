import { describe, expect, it } from 'vitest';

import {
    findPlacement,
    indexPlacements,
    judgeListResponse,
    namespaceFromApiUrl,
    normalizeExecutions,
    runKey,
    simplifyStatus,
} from '../../src/family/rows';
import { apiWorkflow, fakeRunId } from '../helpers';

describe('runKey', () => {
    it('cannot be confused by punctuation in a workflow id', () => {
        // Both of these join to the same string with any single separator:
        //   'a:b' + ':' + 'c'   vs   'a' + ':' + 'b:c'
        // The length prefix is what keeps them apart.
        expect(runKey('a:b', 'c')).not.toBe(runKey('a', 'b:c'));
        expect(runKey('order|1/x', 'run')).toBe('9:order|1/x:run');
    });
});

describe('normalizeExecutions', () => {
    it('skips a row with no execution id rather than inventing one', () => {
        expect(
            normalizeExecutions([
                { execution: { workflowId: '', runId: fakeRunId(1) } },
                { execution: { workflowId: 'ok', runId: '' } },
                { execution: { workflowId: 'ok', runId: 42 } },
                {},
                null,
                'a string where an object should be',
            ]),
        ).toEqual([]);
    });

    it('costs one row per malformed entry, not the whole list', () => {
        // The reason entries are parsed one at a time. Parsing the array as a
        // whole would make one odd entry blank a page of two hundred workflows.
        const rows = normalizeExecutions([
            apiWorkflow({ workflowId: 'first' }),
            { execution: { workflowId: 'no run id' } },
            apiWorkflow({ workflowId: 'third' }),
        ]);
        expect(rows.map((row) => row.workflowId)).toEqual(['first', 'third']);
    });

    it('turns an unparseable time into a usable number instead of NaN', () => {
        // NaN would propagate into every sort comparison and quietly randomise
        // the order of the whole table.
        const rows = normalizeExecutions([
            { execution: { workflowId: 'x', runId: fakeRunId(2) }, startTime: 'not a date' },
        ]);
        expect(rows[0]!.startTimeMs).toBe(0);
        expect(rows[0]!.endTimeMs).toBeNull();
    });

    it('carries the parent execution through, and null when there is none', () => {
        const parentRun = fakeRunId(3);
        const [child, root] = normalizeExecutions([
            apiWorkflow({ workflowId: 'kid', parent: { workflowId: 'mum', runId: parentRun } }),
            apiWorkflow({ workflowId: 'root' }),
        ]);
        expect(child!.parentWorkflowId).toBe('mum');
        expect(child!.parentRunId).toBe(parentRun);
        expect(root!.parentWorkflowId).toBeNull();
        expect(root!.parentRunId).toBeNull();
    });
});

describe('indexPlacements + findPlacement', () => {
    // What the renderer stores per row is irrelevant here, so store the least
    // that still proves which row was found.
    const label = (rows: ReturnType<typeof normalizeExecutions>) =>
        indexPlacements(rows, (row, index) => `${row.workflowId}#${index}`);

    it('resolves a run-less href when the id appears exactly once', () => {
        const rows = normalizeExecutions([
            apiWorkflow({ workflowId: 'alpha', runId: fakeRunId(10) }),
            apiWorkflow({ workflowId: 'beta', runId: fakeRunId(11) }),
        ]);
        const index = label(rows);
        expect(findPlacement(index, 'beta', null)).toBe('beta#1');
        expect(findPlacement(index, 'beta', fakeRunId(11))).toBe('beta#1');
    });

    it('declines a run-less href when the same id has two runs', () => {
        // A retried or continued-as-new workflow keeps its id and gets a new
        // run, and both runs appear in the same list. Picking either one draws
        // the row with the other run's indentation.
        const first = fakeRunId(12);
        const second = fakeRunId(13);
        const rows = normalizeExecutions([
            apiWorkflow({ workflowId: 'retried', runId: first }),
            apiWorkflow({ workflowId: 'retried', runId: second }),
        ]);
        const index = label(rows);
        expect(findPlacement(index, 'retried', null)).toBeUndefined();
        // Each run is still individually addressable — only the guess is refused.
        expect(findPlacement(index, 'retried', first)).toBe('retried#0');
        expect(findPlacement(index, 'retried', second)).toBe('retried#1');
    });

    it('does not fall back to the workflow id when the run id is unknown', () => {
        // An unseen run is not "this workflow's only run" — it is a run we have
        // no rows for, and the honest answer is nothing.
        const rows = normalizeExecutions([apiWorkflow({ workflowId: 'solo', runId: fakeRunId(14) })]);
        expect(findPlacement(label(rows), 'solo', fakeRunId(99))).toBeUndefined();
    });
});

describe('namespaceFromApiUrl', () => {
    it('reads the namespace off the list route, absolute or relative', () => {
        expect(namespaceFromApiUrl('/api/v1/namespaces/sample-namespace/workflows?query=x')).toBe(
            'sample-namespace',
        );
        expect(
            namespaceFromApiUrl('https://cloud.temporal.io/api/v1/namespaces/other-ns/workflows'),
        ).toBe('other-ns');
    });

    it('decodes a percent-encoded namespace', () => {
        expect(namespaceFromApiUrl('/api/v1/namespaces/ns%2Etest/workflows')).toBe('ns.test');
    });

    it('is null for every other API route', () => {
        // These are all URLs the page really does fetch. Treating any of them as
        // a workflow list is how unrelated data reached the table.
        expect(namespaceFromApiUrl('/api/v1/namespaces/sample-namespace/workflow-count')).toBeNull();
        expect(
            namespaceFromApiUrl('/api/v1/namespaces/sample-namespace/workflows/id/history'),
        ).toBeNull();
        expect(namespaceFromApiUrl('/api/v1/namespaces')).toBeNull();
        expect(namespaceFromApiUrl('/some/other/thing')).toBeNull();
    });
});

describe('judgeListResponse', () => {
    const listUrl = (namespace: string) => `/api/v1/namespaces/${namespace}/workflows?query=`;

    it('accepts an answer newer than the one already applied', () => {
        expect(
            judgeListResponse({
                generation: 4,
                url: listUrl('sample-namespace'),
                appliedGeneration: 3,
                pageNamespace: 'sample-namespace',
            }),
        ).toBe('accept');
    });

    it('rejects an older answer that arrives late', () => {
        // Two requests in flight, the first one answers second. Before the
        // generation stamp this overwrote the newer rows and looked like a
        // rendering glitch.
        expect(
            judgeListResponse({
                generation: 1,
                url: listUrl('sample-namespace'),
                appliedGeneration: 2,
                pageNamespace: 'sample-namespace',
            }),
        ).toBe('stale');
    });

    it('rejects a list belonging to a different namespace', () => {
        expect(
            judgeListResponse({
                generation: 9,
                url: listUrl('somebody-elses-ns'),
                appliedGeneration: 1,
                pageNamespace: 'sample-namespace',
            }),
        ).toBe('other-namespace');
    });

    it('skips the namespace check when the page URL names no namespace', () => {
        // Nothing to compare against is not a licence to guess, but it is also
        // not a reason to drop rows the page just fetched.
        expect(
            judgeListResponse({
                generation: 1,
                url: listUrl('sample-namespace'),
                appliedGeneration: 0,
                pageNamespace: null,
            }),
        ).toBe('accept');
    });

    it('rejects a url that is a string and still not a list url', () => {
        // The one malformed case a schema cannot catch. The others — a missing
        // generation, a NaN one, a url that is not a string at all — are refused
        // before they get here, by workflowsMessageSchema; see schemas.spec.ts.
        const base = { appliedGeneration: 1, pageNamespace: 'sample-namespace' };
        expect(judgeListResponse({ ...base, generation: 2, url: '/api/v1/namespaces' })).toBe('malformed');
        expect(judgeListResponse({ ...base, generation: 2, url: '' })).toBe('malformed');
    });
});

describe('simplifyStatus', () => {
    it('shortens the enum the API returns', () => {
        expect(simplifyStatus('WORKFLOW_EXECUTION_STATUS_RUNNING')).toBe('Running');
        expect(simplifyStatus('WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW')).toBe('ContinuedAsNew');
        expect(simplifyStatus('WORKFLOW_EXECUTION_STATUS_TIMED_OUT')).toBe('TimedOut');
    });

    it('passes through a status that is already short', () => {
        // Some responses carry the short form. Both shapes have to land on the
        // same value, or the "is this family running?" test starts missing.
        expect(simplifyStatus('Running')).toBe('Running');
    });

    it('says Unknown rather than empty', () => {
        expect(simplifyStatus('')).toBe('Unknown');
    });
});
