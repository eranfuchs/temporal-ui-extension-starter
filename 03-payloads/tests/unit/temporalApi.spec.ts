// The routes, and only the routes. Small, and worth having separately: every
// request this extension makes is built here, so a wrong string in this file is a
// feature that fails on a live tenant and cannot fail in any other test.

import { describe, expect, it } from 'vitest';

import { apiPrefixOf, describeWorkflowUrl, historyUrl } from '../../src/temporalApi';
import { fakeRunId } from '../helpers';

const RUN_ID = fakeRunId(1);

describe('apiPrefixOf', () => {
    it('cuts the prefix off a URL the page fetched', () => {
        // Cloud: a per-tenant host, which is exactly why this is derived and not
        // assembled from location.origin or a known convention.
        expect(apiPrefixOf('https://tenant.example.com/api/v1/namespaces/ns/workflows')).toBe(
            'https://tenant.example.com',
        );
    });

    it('returns the empty string for a relative URL', () => {
        // The OSS UI's own calls are relative. '' is a correct prefix — it
        // resolves against the page — and must not be confused with a failure.
        expect(apiPrefixOf('/api/v1/namespaces/ns/workflows?query=x')).toBe('');
    });

    it('returns null for a URL that is not the Temporal API', () => {
        expect(apiPrefixOf('https://example.com/static/main.js')).toBeNull();
    });
});

describe('historyUrl', () => {
    const base = { apiPrefix: 'https://tenant.example.com', namespace: 'ns', runId: RUN_ID };

    it('asks for one event, forward for the first and reverse for the last', () => {
        expect(historyUrl({ ...base, workflowId: 'order-1', direction: 'forward' })).toBe(
            `https://tenant.example.com/api/v1/namespaces/ns/workflows/order-1/history?maximumPageSize=1&execution.runId=${RUN_ID}`,
        );
        expect(historyUrl({ ...base, workflowId: 'order-1', direction: 'reverse' })).toContain('/history-reverse?');
    });

    it('asks for more than one event only when told to', () => {
        // The default is 1 because every per-row caller wants exactly one. The
        // detail page asks for a page of them, and that difference is the only
        // thing separating a cheap column from a request nobody should make per row.
        const url = historyUrl({ ...base, workflowId: 'order-1', direction: 'forward', maximumPageSize: 200 });
        expect(url).toContain('maximumPageSize=200');
    });

    it('encodes ids that contain URL syntax', () => {
        // A workflow id may legally contain '/', '|' and '#'. Unencoded, the first
        // of those alone changes which endpoint is called.
        const url = historyUrl({ ...base, workflowId: 'a/b|c#d', namespace: 'with space', direction: 'forward' });
        expect(url).toContain('/namespaces/with%20space/workflows/a%2Fb%7Cc%23d/history');
    });
});

describe('describeWorkflowUrl', () => {
    it('names the run, because a workflow id can have several', () => {
        // Without execution.runId the server answers about the LATEST run of that
        // workflow id. On a list showing a retried workflow that is a different run
        // than the row, so the badge would describe the wrong execution — and it
        // would look right, because the shape of the answer is identical.
        expect(
            describeWorkflowUrl({
                apiPrefix: 'https://tenant.example.com',
                namespace: 'ns',
                workflowId: 'order-1',
                runId: RUN_ID,
            }),
        ).toBe(`https://tenant.example.com/api/v1/namespaces/ns/workflows/order-1?execution.runId=${RUN_ID}`);
    });
});
