// The boundary schemas in src/types.ts.
//
// WHAT IS AND IS NOT TESTED HERE
//
// Not tested: that v.string() rejects a number, that v.minLength(1) rejects ''.
// Those are the library's own semantics, they are its job to test, and asserting
// them here would only pin this repository to one library's internals.
//
// Tested: the CONSEQUENCE of how those pieces were composed at each boundary —
// every case where a message that got through used to do something wrong, and
// every case where one that must get through still does. Each test names the
// failure it prevents, because a schema is only worth as much as the decision it
// changes, and the decisions are what a reader is here to understand.

import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    MESSAGE_SOURCE,
    temporalApiWorkflowSchema,
    workflowListEnvelopeSchema,
    workflowsMessageSchema,
} from '../../src/types';
import { apiWorkflow, fakeRunId } from '../helpers';

const listUrl = '/api/v1/namespaces/sample-namespace/workflows?query=';

const message = (overrides: Record<string, unknown> = {}) => ({
    source: MESSAGE_SOURCE,
    type: 'workflows',
    url: listUrl,
    generation: 1,
    executions: [],
    ...overrides,
});

describe('workflowsMessageSchema', () => {
    it('accepts the message inject.ts actually sends', () => {
        const parsed = safeParse(
            workflowsMessageSchema,
            message({ executions: [apiWorkflow({ workflowId: 'a' })] }),
        );
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.output.executions).toHaveLength(1);
    });

    it('refuses a generation that is not a finite number', () => {
        // The case that matters most, and the reason finite() is written out
        // rather than assumed. Every comparison against NaN is false, so a NaN
        // generation is neither newer nor older than the one already applied: a
        // forged one freezes the table for the rest of the page's life with no
        // error anywhere. Infinity is the same bug from the other end — it pins
        // appliedGeneration at Infinity and every later answer reads as stale.
        for (const generation of [NaN, Infinity, -Infinity, 1e309, '3', undefined, null]) {
            expect(safeParse(workflowsMessageSchema, message({ generation })).success).toBe(false);
        }
        expect(safeParse(workflowsMessageSchema, message({ generation: 0 })).success).toBe(true);
    });

    it('refuses a message wearing another script’s name, or no name', () => {
        expect(safeParse(workflowsMessageSchema, message({ source: 'some-other-extension' })).success).toBe(false);
        expect(safeParse(workflowsMessageSchema, message({ source: undefined })).success).toBe(false);
        expect(safeParse(workflowsMessageSchema, message({ type: 'settings' })).success).toBe(false);
    });

    it('refuses a url that is not a string, and an executions that is not an array', () => {
        // Both used to reach code that assumed otherwise: the url went into a
        // regex, and the executions into a for..of.
        expect(safeParse(workflowsMessageSchema, message({ url: 42 })).success).toBe(false);
        expect(safeParse(workflowsMessageSchema, message({ executions: 'not an array' })).success).toBe(false);
        expect(safeParse(workflowsMessageSchema, message({ executions: undefined })).success).toBe(false);
    });

    it('drops keys it does not declare, so a stale one cannot become reachable', () => {
        // The unknown-key policy, in both directions at once. `pageToken` is a
        // real field of Temporal's list response that we do not read: it must not
        // break the parse. `authorization` is the shape of something we must never
        // pick up from a message — parsing strips it, so no later code can find
        // one there even by accident.
        const parsed = safeParse(
            workflowsMessageSchema,
            message({ pageToken: 'abc', authorization: 'Bearer forged-by-the-page' }),
        );
        expect(parsed.success).toBe(true);
        expect(parsed.success && Object.keys(parsed.output).sort()).toEqual([
            'executions',
            'generation',
            'source',
            'type',
            'url',
        ]);
    });

    it('hands the entries through untouched, so nothing is validated twice', () => {
        // normalizeExecutions() parses every entry against temporalApiWorkflowSchema
        // immediately after this, one at a time, and that is the ONE deep pass over
        // the list. Declaring the entries here as well would make it two — and on a
        // busy namespace the list is measured in megabytes.
        //
        // Identity is the cheapest way to prove it: a real entry schema here would
        // also REBUILD each entry, so the objects would no longer be the same ones.
        const entry = apiWorkflow({ workflowId: 'a' });
        const parsed = safeParse(workflowsMessageSchema, message({ executions: [entry] }));
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.output.executions[0]).toBe(entry);
    });
});

describe('temporalApiWorkflowSchema', () => {
    it('requires both ids, and rejects an empty one as firmly as a missing one', () => {
        // An empty workflow id is not a row we can place or match; it used to
        // produce a row keyed on '' that no table row could ever resolve to.
        for (const entry of [
            { execution: { workflowId: '', runId: fakeRunId(1) } },
            { execution: { workflowId: 'x', runId: '' } },
            { execution: { workflowId: 'x' } },
            { execution: { workflowId: 'x', runId: 42 } },
            {},
            null,
            'a string where an object should be',
        ]) {
            expect(safeParse(temporalApiWorkflowSchema, entry).success).toBe(false);
        }
    });

    it('accepts the fields Temporal omits, whether null or absent', () => {
        // A root workflow has no parentExecution and a running one has no
        // closeTime. Temporal sends some of those as null and some not at all,
        // and both have to pass — normalizeExecutions() reads them with ?? and
        // does not care which, but a schema demanding one form would silently
        // drop every root workflow on the page.
        expect(
            safeParse(temporalApiWorkflowSchema, {
                execution: { workflowId: 'x', runId: fakeRunId(2) },
                closeTime: null,
                parentExecution: null,
            }).success,
        ).toBe(true);
        expect(
            safeParse(temporalApiWorkflowSchema, { execution: { workflowId: 'x', runId: fakeRunId(3) } }).success,
        ).toBe(true);
    });

    it('keeps unread Temporal fields out of the parsed row', () => {
        // Temporal's real entry is far larger than this. What comes back is what
        // we declared, so nothing downstream can start depending on a field this
        // repository never described.
        const parsed = safeParse(temporalApiWorkflowSchema, {
            execution: { workflowId: 'x', runId: fakeRunId(4) },
            memo: { fields: {} },
            searchAttributes: { indexedFields: {} },
            executionTime: '2026-01-01T00:00:00Z',
        });
        expect(parsed.success).toBe(true);
        expect(parsed.success && Object.keys(parsed.output)).toEqual(['execution']);
    });
});

describe('workflowListEnvelopeSchema', () => {
    it('accepts a list and rejects anything that is not one', () => {
        expect(safeParse(workflowListEnvelopeSchema, { executions: [] }).success).toBe(true);
        expect(safeParse(workflowListEnvelopeSchema, { executions: [{ anything: true }] }).success).toBe(true);
        expect(safeParse(workflowListEnvelopeSchema, {}).success).toBe(false);
        expect(safeParse(workflowListEnvelopeSchema, { executions: {} }).success).toBe(false);
        expect(safeParse(workflowListEnvelopeSchema, null).success).toBe(false);
        expect(safeParse(workflowListEnvelopeSchema, 'a string body').success).toBe(false);
    });

    it('does not look inside the entries', () => {
        // Deliberate: inject.ts runs in the page's own world on a body measured in
        // megabytes, and the entries are parsed one at a time on the other side.
        // Validating them here as well would be paid for on the page's own turn.
        expect(safeParse(workflowListEnvelopeSchema, { executions: [null, 'nonsense', 7] }).success).toBe(true);
    });

    it('does not copy the entries either', () => {
        // The other half of the same decision, and the more expensive half. This
        // parse runs in the PAGE's world, on the page's own turn, against a body the
        // page is about to hand us anyway: a schema that rebuilt every entry would
        // leave a second multi-megabyte copy on the page's heap for nothing.
        const first = { execution: { workflowId: 'a', runId: fakeRunId(5) } };
        const parsed = safeParse(workflowListEnvelopeSchema, { executions: [first] });
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.output.executions[0]).toBe(first);
    });
});
