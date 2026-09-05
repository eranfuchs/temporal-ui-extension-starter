// src/payloads/payloadMessages.ts — the two messages the payload feature sends across the
// world boundary, and the schemas that validate them.
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
//
// Not tested: that v.string() rejects a number, that v.literal() compares, that
// v.picklist() refuses a word not in its list. Those are valibot's own semantics and
// belong to valibot's own suite. What is tested is every constraint this protocol
// adds on top of them, and every consequence of getting one wrong.

import { safeParse } from 'valibot';
import { describe, expect, it } from 'vitest';

import { payloadRequestSchema, payloadResultSchema } from '../../src/payloads/payloadMessages';
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

// Named for what accepting one MEANS, because that is what these specs are about:
// a request that parses is a request the page world will act on, and a result that
// parses is one the isolated world will render.
const wouldServe = (value: unknown): boolean => safeParse(payloadRequestSchema, value).success;
const wouldRender = (value: unknown): boolean => safeParse(payloadResultSchema, value).success;

describe('the shape of our own messages', () => {
    it('accepts them', () => {
        expect(wouldServe(request)).toBe(true);
        expect(wouldRender(result)).toBe(true);
    });

    it('rejects anything else on the page’s postMessage channel', () => {
        // A single-page app posts to itself, and so does every other extension.
        for (const bad of [{ ...request, source: 'someone-else' }, { ...request, type: 'workflows' }]) {
            expect(wouldServe(bad)).toBe(false);
        }
        // Neither schema accepts the other's message, which is what keeps a request
        // echoed back at us from being rendered as an answer.
        expect(wouldRender(request)).toBe(false);
        expect(wouldServe(result)).toBe(false);
    });
});

describe('payloadRequestSchema', () => {
    it('rejects a message that is missing or malforming any field it will act on', () => {
        // Every one of these used to pass, because the first version of this check read
        // source, type and typeof id and nothing else. None of them is an attack on its
        // own — the ledger in pageApi.ts is what refuses a forged ASK — but each one
        // reached a fetch or a URL builder with a value of the wrong type, and
        // "TypeError inside a tooltip" is not a failure mode worth having.
        for (const bad of [
            // NaN compares false with itself, so an answer carrying this id could
            // never be matched to the question that asked it.
            { ...request, id: Number.NaN },
            // Blank is not a namespace, and '' would build a URL with two slashes
            // where the namespace should be.
            { ...request, namespace: '' },
            { ...request, runId: '' },
            // A message that names no codec config at all is from a different build:
            // there is no default here, because a default would pick an endpoint on
            // behalf of a sender who did not name one.
            { ...request, codec: undefined },
            { ...request, codec: 'https://codec.example.com' },
            { ...request, codec: {} },
        ]) {
            expect(wouldServe(bad), JSON.stringify(bad)?.slice(0, 60)).toBe(false);
        }
    });

    it('strips a credential flag out of a codec config instead of rejecting the message', () => {
        // The interesting case, and the reason it is a separate test rather than one
        // more line in the list above. `includeCredentials` was a real field of this
        // message until it was deleted, so a forged message — or an older build's
        // stored settings — will still send it.
        //
        // The message is ACCEPTED, and that is correct: rejecting it would be defence
        // in the wrong place, since the sender chooses its own keys and a schema that
        // refused unknown ones would look stricter while protecting nothing. What the
        // schema does instead is remove them, so the config handed to the codec path
        // has one key. Two independent things now have to stay true for the flag to be
        // harmless — codecDecodeCall has no parameter for it and fetchFromPageWorld
        // hard-wires `credentials: 'omit'`, both pinned from the outside in
        // codec.spec.ts and apiInject.spec.ts — and this one, which is that the field
        // does not survive the boundary at all.
        for (const hostile of [{ includeCredentials: true }, { token: 'Bearer nope' }]) {
            const parsed = safeParse(payloadRequestSchema, { ...request, codec: { endpoint: '', ...hostile } });
            expect(parsed.success).toBe(true);
            expect(parsed.success && parsed.output.codec).toEqual({ endpoint: '' });
        }
    });
});

describe('payloadResultSchema', () => {
    it('rejects a result whose rendered fields are not the types they claim', () => {
        for (const bad of [
            // Rendered as the literal string "[object Object]" in the panel body.
            { ...result, text: {} },
            { ...result, text: undefined },
            // Falsy but not null: the panel showed neither an error nor a body,
            // which reads as "this workflow has no input".
            { ...result, error: 0 },
            // null XOR a string, never undefined: "asked, and there is nothing"
            // is a different message from "the field is missing".
            { ...result, error: undefined },
            { ...result, decodedBy: undefined },
        ]) {
            expect(wouldRender(bad), JSON.stringify(bad)?.slice(0, 60)).toBe(false);
        }
    });

    it('rejects a result that cannot say which question it answers', () => {
        // The four correlation fields are required so the matcher in payloadClient.ts
        // is never handed an answer it cannot compare. Dropping any of them would make
        // `undefined === undefined` the comparison on some future refactor, and the
        // thing that comparison would let through is one workflow's decrypted input
        // under another workflow's name. Blank is refused for the same reason: '' is
        // a value two unrelated answers can agree on.
        for (const field of ['namespace', 'workflowId', 'runId', 'kind'] as const) {
            expect(wouldRender({ ...result, [field]: undefined }), field).toBe(false);
            expect(wouldRender({ ...result, [field]: '' }), field).toBe(false);
        }
        expect(wouldRender({ ...result, kind: 'outcome' })).toBe(true);
        expect(wouldRender({ ...result, kind: 'both' })).toBe(false);
    });

    it('hands the panel only the fields it declared', () => {
        // The unknown-key policy on the boundary that RENDERS. Extra keys do not make
        // the answer invalid, but they are stripped, so a sender cannot smuggle a
        // second body — or an href — past the panel by attaching one to a well-formed
        // answer.
        const parsed = safeParse(payloadResultSchema, { ...result, html: '<img src=x onerror=alert(1)>' });
        expect(parsed.success).toBe(true);
        expect(parsed.success && Object.keys(parsed.output).sort()).toEqual([
            'decodedBy',
            'error',
            'id',
            'kind',
            'label',
            'namespace',
            'runId',
            'source',
            'text',
            'type',
            'workflowId',
        ]);
    });
});

describe('both schemas are parsers and not gates', () => {
    it('accepts a well-formed message naming somebody else’s workflow', () => {
        // The one property worth pinning about intent: a forged message that gets
        // the shape right IS accepted here, by design. Authorisation is the ledger
        // in pageApi.ts, and a reader who mistakes this for the check would remove
        // that one as redundant.
        expect(wouldServe({ ...request, workflowId: 'someone-elses-workflow' })).toBe(true);
        // Same on the answering side, and here the shape check is even further from
        // being the protection: a well-formed result naming a run this side never
        // asked about parses cleanly and is dropped by the correlation check in
        // payloadClient.ts.
        expect(wouldRender({ ...result, workflowId: 'someone-elses-workflow' })).toBe(true);
    });
});
