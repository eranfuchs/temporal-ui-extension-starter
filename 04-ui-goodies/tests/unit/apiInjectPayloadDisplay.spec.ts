// @vitest-environment jsdom
//
// The one thing the maxNodes-vs-MAX_DISPLAY_CHARS review caught that no other spec
// file asserts: that a real payload past the OLD 20,000-character clip actually
// reaches the JSON viewer as valid, unclipped text through the SAME path a hover
// uses — not through renderJsonPayload() called directly on a hand-built string,
// which proves nothing about payloads.ts's own clip() ever running.
//
// Before the fix this file guards, a payload this size would have come back
// truncated mid-token with a "…clipped: N more characters." marker appended,
// which is not valid JSON — so renderJsonPayload() would have fallen back to
// plain text, not the tree this test asserts on. See MAX_DISPLAY_CHARS in
// src/payloads/payloads.ts and "The payload panel" in docs/design-notes.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JSON_FALLBACK_CLASS, JSON_VIEW_CLASS, renderJsonPayload } from '../../src/payloads/jsonViewer';
import { MAX_DISPLAY_CHARS } from '../../src/payloads/payloads';
import { BEARER, LIST_URL, askPayload, b64, fake, installApiInjectHarness, teardownApiInjectHarness } from '../apiInjectHarness';

beforeEach(installApiInjectHarness);
afterEach(teardownApiInjectHarness);

// A realistic nested-record shape, repeated until the stringified array passes
// the OLD 20,000-character clip. Not a single huge string: a payload this shape
// is what the maxNodes budget was raised for, and a single scalar this long
// would exercise a completely different (and uninteresting) code path.
function syntheticCatalog(minChars: number): unknown[] {
    const items: unknown[] = [];
    let text = '[]';
    let i = 0;
    while (text.length < minChars) {
        items.push({
            proposalId: `PROP-${String(i).padStart(6, '0')}`,
            amount: { value: 1000 + i, currency: 'USD' },
            period: { months: 12, startDate: '2000-01-01T00:00:00Z', endDate: '2001-01-01T00:00:00Z' },
        });
        text = JSON.stringify(items);
        i++;
    }
    return items;
}

describe('a payload past the historical 20,000-character clip', () => {
    beforeEach(async () => {
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
    });

    it('arrives unclipped through the real message-passing path a hover uses', async () => {
        const text = JSON.stringify(syntheticCatalog(30_000));
        expect(text.length).toBeGreaterThan(20_000);
        expect(text.length).toBeLessThan(MAX_DISPLAY_CHARS);

        fake.forwardHistoryBody = {
            history: {
                events: [
                    {
                        eventId: '1',
                        workflowExecutionStartedEventAttributes: {
                            input: { payloads: [{ metadata: { encoding: b64('json/plain') }, data: b64(text) }] },
                        },
                    },
                ],
            },
        };

        const result = await askPayload();

        expect(result.error).toBeNull();
        // Lossless AND unclipped — clip() appends "…clipped: N more characters."
        // and cuts mid-token, so an exact match rules out both.
        expect(result.text).toBe(text);
        expect(result.text).not.toContain('clipped:');

        // The point of the whole fix: this exact, real-pipeline text renders as a
        // tree, not the plain-text fallback a truncated JSON prefix would produce.
        const node = renderJsonPayload(document, result.text);
        expect(node.className).toBe(JSON_VIEW_CLASS);
        expect(node.className).not.toBe(JSON_FALLBACK_CLASS);
    });
});
