// src/payloads/payloadMessages.ts — the two messages the payload feature sends across the
// world boundary, and the guards that validate them.
//
// THE SPEC THESE ASSERTIONS ARE WRITTEN AGAINST is "a malformed message is rejected
// in one place", not "a forged message is refused" — the last test in this file pins
// that distinction on purpose, because a reader who mistakes a shape check for the
// authorisation would delete the real one in pageApi.ts as redundant.
//
// The result half is stricter than 02's equivalent, and the direction of travel is
// why: a result message goes INTO the isolated world and its body is rendered. A
// field trusted rather than checked showed `{}` as the literal string
// "[object Object]" and an `error` of `0` as a panel with neither error nor body —
// the panel looked like it had answered.

import { describe, expect, it } from 'vitest';

import { isPayloadRequest, isPayloadResult } from '../../src/payloads/payloadMessages';
import { MESSAGE_SOURCE } from '../../src/types';
import { FIXTURE_RUN_ID } from '../payloadFixtures';

const request = {
    source: MESSAGE_SOURCE,
    type: 'payload-request',
    id: 1,
    namespace: 'ns',
    workflowId: 'order-1',
    runId: FIXTURE_RUN_ID,
    kind: 'input',
    codec: { endpoint: '' },
};

// The answer names the question. Every field but label/text/error/decodedBy is
// echoed straight back from the request, and that is what the asker matches on.
const result = {
    source: MESSAGE_SOURCE,
    type: 'payload-result',
    id: 1,
    namespace: 'ns',
    workflowId: 'order-1',
    runId: FIXTURE_RUN_ID,
    kind: 'input',
    label: 'Input',
    text: '{"orderId":7}',
    error: null,
    decodedBy: null,
};

describe('the shape of our own messages', () => {
    it('accepts them', () => {
        expect(isPayloadRequest(request)).toBe(true);
        expect(isPayloadResult(result)).toBe(true);
    });

    it('rejects anything else on the page’s postMessage channel', () => {
        // A single-page app posts to itself, and so does every other extension.
        for (const bad of [
            null,
            'a string',
            {},
            { ...request, source: 'someone-else' },
            { ...request, type: 'workflows' },
            { ...request, id: '1' },
        ]) {
            expect(isPayloadRequest(bad)).toBe(false);
        }
        // Neither guard accepts the other's message, which is what keeps a request
        // echoed back at us from being rendered as an answer.
        expect(isPayloadResult(request)).toBe(false);
        expect(isPayloadRequest(result)).toBe(false);
    });
});

describe('isPayloadRequest', () => {
    it('rejects a message that is missing or malforming any field it will act on', () => {
        // Every one of these used to pass, because the guard checked source, type
        // and typeof id and nothing else. None of them is an attack on its own —
        // the ledger in pageApi.ts is what refuses a forged ASK — but each one
        // reached a fetch or a URL builder with a value of the wrong type, and
        // "TypeError inside a tooltip" is not a failure mode worth having.
        for (const bad of [
            { ...request, id: Number.NaN },
            { ...request, namespace: '' },
            { ...request, namespace: 42 },
            { ...request, workflowId: null },
            { ...request, runId: undefined },
            { ...request, kind: 'signal' },
            { ...request, codec: undefined },
            { ...request, codec: 'https://codec.example.com' },
            { ...request, codec: {} },
            { ...request, codec: { endpoint: null } },
            { ...request, codec: { endpoint: 42 } },
        ]) {
            expect(isPayloadRequest(bad)).toBe(false);
        }
    });

    it('accepts a codec config carrying a credential flag, because nothing can read it', () => {
        // The interesting case, and the reason it is a separate test rather than one
        // more line in the list above. `includeCredentials` was a real field of this
        // message until it was deleted, so a forged message — or an older build's
        // stored settings — will still send it. It is ACCEPTED here, and that is
        // correct: rejecting the message would be defence in the wrong place. What
        // makes the flag harmless is that codecDecodeCall has no parameter for it, and
        // fetchFromPageWorld hard-wires `credentials: 'omit'` — both pinned from the
        // outside in codec.spec.ts and apiInject.spec.ts.
        //
        // A guard that rejected unknown keys would look stricter and protect nothing:
        // the sender chooses the keys.
        expect(isPayloadRequest({ ...request, codec: { endpoint: '', includeCredentials: true } })).toBe(true);
        expect(isPayloadRequest({ ...request, codec: { endpoint: '', token: 'Bearer nope' } })).toBe(true);
    });
});

describe('isPayloadResult', () => {
    it('rejects a result whose rendered fields are not the types they claim', () => {
        for (const bad of [
            // Rendered as the literal string "[object Object]" in the panel body.
            { ...result, text: {} },
            { ...result, text: undefined },
            { ...result, label: 42 },
            // Falsy but not null: the panel showed neither an error nor a body,
            // which reads as "this workflow has no input".
            { ...result, error: 0 },
            // null XOR a string, never undefined: "asked, and there is nothing"
            // is a different message from "the field is missing".
            { ...result, error: undefined },
            { ...result, decodedBy: undefined },
            { ...result, decodedBy: 7 },
        ]) {
            expect(isPayloadResult(bad)).toBe(false);
        }
    });

    it('rejects a result that cannot say which question it answers', () => {
        // The four correlation fields are required so the matcher in payloadClient.ts
        // is never handed an answer it cannot compare. Dropping any of them would make
        // `undefined === undefined` the comparison on some future refactor, and the
        // thing that comparison would let through is one workflow's decrypted input
        // under another workflow's name.
        for (const field of ['namespace', 'workflowId', 'runId', 'kind'] as const) {
            expect(isPayloadResult({ ...result, [field]: undefined })).toBe(false);
            expect(isPayloadResult({ ...result, [field]: '' })).toBe(false);
        }
        expect(isPayloadResult({ ...result, kind: 'outcome' })).toBe(true);
        expect(isPayloadResult({ ...result, kind: 'both' })).toBe(false);
    });
});

describe('both guards are parsers and not gates', () => {
    it('accepts a well-formed message naming somebody else’s workflow', () => {
        // The one property worth pinning about intent: a forged message that gets
        // the shape right IS accepted here, by design. Authorisation is the ledger
        // in pageApi.ts, and a reader who mistakes this for the check would remove
        // that one as redundant.
        expect(isPayloadRequest({ ...request, workflowId: 'someone-elses-workflow' })).toBe(true);
        // Same on the answering side, and here the shape check is even further from
        // being the protection: a well-formed result naming a run this side never
        // asked about is accepted by the guard and dropped by the correlation check
        // in payloadClient.ts.
        expect(isPayloadResult({ ...result, workflowId: 'someone-elses-workflow' })).toBe(true);
    });
});
