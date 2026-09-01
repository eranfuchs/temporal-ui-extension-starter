// The pure half of the payload feature.
//
// Four of these specs exist because of a failure mode that produces
// CONFIDENT WRONG OUTPUT rather than an error, which is the only kind worth
// writing a test this long about:
//   • pretty-printing a long integer silently changes its value;
//   • a codec server returning the wrong number of payloads would relabel
//     decrypted data instead of failing;
//   • matching on eventType instead of the attributes key works on one Temporal
//     version and quietly finds nothing on the next;
//   • a result message that is trusted field-by-field renders `{}` as
//     "[object Object]" and an `error` of `0` as a panel with neither error nor
//     body — the panel looked like it had answered.

import { describe, expect, it } from 'vitest';

import {
    base64Bytes,
    base64ToText,
    clip,
    codecDecodeCall,
    decodePayload,
    describeFailure,
    encodingOf,
    extractInput,
    extractOutcome,
    formatPayloads,
    isPayloadRequest,
    isPayloadResult,
    MAX_DISPLAY_CHARS,
    mergeDecoded,
    needsCodec,
    planCodecCall,
    prettyJson,
    readCodecResponse,
    safeCodecEndpoint,
    type RawPayload,
} from '../../src/payloads';
import { MESSAGE_SOURCE } from '../../src/types';
import { fakeRunId } from '../helpers';

// Temporal sends both payload fields as base64 in JSON, so the fixtures have to
// as well — a test that skips the encoding would not exercise the decode path at
// all. Via TextEncoder so a non-ASCII fixture is real UTF-8.
function b64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return btoa(String.fromCharCode(...bytes));
}

function payload(encoding: string, data: string): RawPayload {
    return { metadata: { encoding: b64(encoding) }, data: b64(data) };
}

// A history event, in the shape the API returns: the attributes hang off a key
// named after the event type. `eventType` is included because the real response
// has it — and deliberately never read.
function event(attributesKey: string, attributes: Record<string, unknown>, eventType = 'Whatever'): unknown {
    return { eventId: '1', eventType, [attributesKey]: attributes };
}

const RUN_ID = fakeRunId(1);

describe('extractInput', () => {
    const started = { input: { payloads: [payload('json/plain', '{"orderId":7}')] } };

    it('finds the started event by its attributes key, whatever eventType says', () => {
        // The two spellings a real server uses. Both must work, and they do
        // because neither is consulted.
        for (const spelling of ['WorkflowExecutionStarted', 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED']) {
            const history = {
                history: { events: [event('workflowExecutionStartedEventAttributes', started, spelling)] },
            };
            expect(extractInput(history)).toMatchObject({ label: 'Input', note: null });
            expect(extractInput(history)!.payloads).toHaveLength(1);
        }
    });

    it('accepts a bare events array as well as history.events', () => {
        const events = [event('workflowExecutionStartedEventAttributes', started)];
        expect(extractInput({ events })).not.toBeNull();
    });

    it('returns null when the response holds no started event', () => {
        expect(extractInput({ history: { events: [] } })).toBeNull();
        expect(extractInput({})).toBeNull();
        expect(extractInput(null)).toBeNull();
    });

    it('returns an empty payload list for a workflow started with no arguments', () => {
        // Not the same as "no answer": the panel says "no input" rather than
        // reporting that it could not read the history.
        const events = [event('workflowExecutionStartedEventAttributes', {})];
        expect(extractInput({ events })).toEqual({ label: 'Input', note: null, payloads: [] });
    });
});

describe('extractOutcome', () => {
    it('reads a completed result', () => {
        const events = [
            event('workflowExecutionCompletedEventAttributes', {
                result: { payloads: [payload('json/plain', '{"ok":true}')] },
            }),
        ];
        const outcome = extractOutcome({ events })!;
        expect(outcome.label).toBe('Completed');
        expect(formatPayloads(outcome.payloads)).toContain('"ok": true');
    });

    it('reads a failure as text, innermost cause included', () => {
        const events = [
            event('workflowExecutionFailedEventAttributes', {
                failure: { message: 'activity task failed', cause: { message: 'account 1 not found' } },
            }),
        ];
        const outcome = extractOutcome({ events })!;
        expect(outcome.label).toBe('Failed');
        expect(outcome.note).toBe('activity task failed\ncaused by: account 1 not found');
        expect(outcome.payloads).toHaveLength(0);
    });

    it('reads a termination reason and its details', () => {
        const events = [
            event('workflowExecutionTerminatedEventAttributes', {
                reason: 'cancelled by operator',
                details: { payloads: [payload('text/plain', 'ticket 42')] },
            }),
        ];
        const outcome = extractOutcome({ events })!;
        expect(outcome).toMatchObject({ label: 'Terminated', note: 'cancelled by operator' });
        expect(formatPayloads(outcome.payloads)).toBe('ticket 42');
    });

    it('reads continue-as-new as the next run id', () => {
        const events = [
            event('workflowExecutionContinuedAsNewEventAttributes', { newExecutionRunId: RUN_ID }),
        ];
        expect(extractOutcome({ events })).toEqual({ label: 'Continued as new', note: RUN_ID, payloads: [] });
    });

    it('returns null for a running workflow', () => {
        // The last event of a running workflow is something like a task
        // scheduled. Nothing to report, and not an error.
        const events = [event('workflowTaskScheduledEventAttributes', { attempt: 1 })];
        expect(extractOutcome({ events })).toBeNull();
    });
});

describe('describeFailure', () => {
    it('walks the cause chain and appends the stack trace', () => {
        const text = describeFailure({
            message: 'outer',
            stackTrace: 'at worker.ts:1',
            cause: { message: 'inner' },
        });
        expect(text).toBe('outer\ncaused by: inner\n\nat worker.ts:1');
    });

    it('stops on a cycle instead of hanging the panel', () => {
        // `cause` is server data. A cycle in it is not a hypothetical bug in our
        // code, it is a bad response we have to survive.
        const failure: Record<string, unknown> = { message: 'loop' };
        failure['cause'] = failure;
        const lines = describeFailure(failure)!.split('\n');
        expect(lines).toHaveLength(8); // MAX_CAUSE_DEPTH
    });

    it('returns null when there is nothing to say', () => {
        expect(describeFailure(undefined)).toBeNull();
        expect(describeFailure({})).toBeNull();
    });
});

describe('decoding a payload', () => {
    it('pretty-prints json/plain', () => {
        expect(decodePayload(payload('json/plain', '{"a":1}'))).toBe('{\n  "a": 1\n}');
    });

    it('decodes UTF-8, not one character per byte', () => {
        // atob alone returns a char per byte and mangles every multi-byte
        // character; the TextDecoder is what makes this pass.
        expect(decodePayload(payload('text/plain', 'naïve café — ✓'))).toBe('naïve café — ✓');
    });

    it('renders binary/null as null', () => {
        expect(decodePayload({ metadata: { encoding: b64('binary/null') } })).toBe('null');
        expect(needsCodec({ metadata: { encoding: b64('binary/null') } })).toBe(false);
    });

    it('does not pretend to read an encrypted payload', () => {
        const encrypted = payload('binary/encrypted', 'not really ciphertext, but opaque either way');
        expect(needsCodec(encrypted)).toBe(true);
        const text = decodePayload(encrypted);
        expect(text).toContain('binary/encrypted');
        expect(text).toContain('bytes');
        expect(text).toContain('codec server');
    });

    it('treats json/protobuf as needing a codec even though it is not encrypted', () => {
        // Decoding it needs the message descriptor, which we do not have and a
        // codec server usually does. The two bytes are written as escapes rather
        // than typed literally: protobuf wire format is mostly control characters,
        // and a fixture that is invisible in a diff is a fixture nobody reviews —
        // the leak gate rejects one, which is how these two were found.
        expect(needsCodec(payload('json/protobuf', '\u0008\u0001'))).toBe(true);
    });

    it('treats a payload with no metadata as needing a codec', () => {
        // Unknown is not the same as readable, and guessing is how binary data
        // ends up rendered as mojibake in a tooltip.
        expect(encodingOf({})).toBe('');
        expect(needsCodec({})).toBe(true);
    });
});

describe('prettyJson', () => {
    it('leaves the server’s own formatting alone when a long integer is present', () => {
        // The assertion below is the reason this function exists: the naive
        // round-trip CHANGES THE VALUE, and the result looks like real data.
        const text = '{"transactionId":12345678901234567890}';
        expect(JSON.stringify(JSON.parse(text))).not.toBe(text);
        expect(prettyJson(text)).toBe(text);
    });

    it('still formats ordinary numbers', () => {
        expect(prettyJson('{"n":42}')).toBe('{\n  "n": 42\n}');
    });

    it('returns the text unchanged when it is not JSON after all', () => {
        expect(prettyJson('<html>not json</html>')).toBe('<html>not json</html>');
    });
});

describe('formatPayloads', () => {
    it('numbers the arguments when there is more than one', () => {
        const text = formatPayloads([payload('text/plain', 'first'), payload('text/plain', 'second')]);
        expect(text).toContain('── 1 of 2 ──');
        expect(text).toContain('── 2 of 2 ──');
    });

    it('adds no header for a single payload', () => {
        expect(formatPayloads([payload('text/plain', 'only')])).toBe('only');
    });

    it('is empty for no payloads', () => {
        expect(formatPayloads([])).toBe('');
    });
});

describe('clip', () => {
    it('cuts oversized text and says how much it cut', () => {
        const clipped = clip('x'.repeat(MAX_DISPLAY_CHARS + 5));
        expect(clipped).toContain('clipped: 5 more characters');
        expect(clipped.startsWith('x'.repeat(MAX_DISPLAY_CHARS))).toBe(true);
    });

    it('leaves text at the limit untouched', () => {
        const exact = 'x'.repeat(MAX_DISPLAY_CHARS);
        expect(clip(exact)).toBe(exact);
    });
});

describe('safeCodecEndpoint', () => {
    it('accepts https anywhere', () => {
        expect(safeCodecEndpoint('https://codec.example.com')).toBe('https://codec.example.com');
        expect(safeCodecEndpoint('  https://codec.example.com/base/  ')).toBe('https://codec.example.com/base');
    });

    it('accepts plain http only on this machine', () => {
        expect(safeCodecEndpoint('http://localhost:8081')).toBe('http://localhost:8081');
        expect(safeCodecEndpoint('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081');
    });

    it('rejects plain http to anywhere else', () => {
        // A codec server hands back DECRYPTED data. This is the rule that keeps
        // it off the wire in the clear.
        expect(safeCodecEndpoint('http://codec.example.com')).toBeNull();
        // Near-misses, which is where a hostname check written with `includes`
        // or `startsWith` would let a remote host through.
        expect(safeCodecEndpoint('http://localhost.example.com')).toBeNull();
        expect(safeCodecEndpoint('http://127.0.0.1.example.com')).toBeNull();
    });

    it('rejects everything that is not an absolute http(s) URL', () => {
        for (const bad of ['', '   ', 'codec.example.com', '/decode', 'javascript:alert(1)', 'ftp://codec.example.com/y']) {
            expect(safeCodecEndpoint(bad)).toBeNull();
        }
    });
});

describe('codecDecodeCall', () => {
    const payloads = [payload('binary/encrypted', 'opaque')];

    it('makes exactly the call Temporal’s own UI makes', () => {
        const call = codecDecodeCall({ endpoint: 'https://codec.example.com', namespace: 'ns', payloads });
        expect(call.url).toBe('https://codec.example.com/decode');
        expect(call.init.method).toBe('POST');
        expect(call.init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Namespace': 'ns' });
        expect(JSON.parse(String(call.init.body))).toEqual({ payloads });
        // The namespace goes out in a header. Named here because it is the one field
        // of the request that is not a payload and is easy to forget when listing
        // what this call discloses to a third party.
        expect(call.init.headers).toHaveProperty('X-Namespace');
    });

    it('carries no credential, and has no parameter that could add one', () => {
        // BOTH of these used to be settings — "pass my access token" and "send
        // cookies". They were deleted rather than defaulted off, because the endpoint
        // arrives over postMessage: see the CodecConfig note in payloads.ts.
        //
        // Asserting the ABSENT PARAMETERS as well as the absent header is the whole
        // point of this test. A default-off flag passes an assertion about the
        // header; only the absence of the parameter makes a forged `true` unreachable.
        const call = codecDecodeCall({ endpoint: 'https://codec.example.com', namespace: 'ns', payloads });
        expect(call.init.headers).not.toHaveProperty('Authorization');
        expect(Object.keys(call.init.headers as Record<string, string>)).toEqual(['Content-Type', 'X-Namespace']);
        // NOT `credentials: 'omit'` — this call used to carry that literal, and the
        // review that removed it was right: on a RequestInit, 'omit' is one caller
        // being careful. `credentials` is now not a field of the type this returns at
        // all, and fetchFromPageWorld sets it. What reached the wire is asserted from
        // outside the extension in apiInject.spec.ts, which is where a claim about
        // egress belongs; what this line pins is that the builder cannot name one.
        expect(call.init).not.toHaveProperty('credentials');

        // A build that still tried to pass either would not compile. This is the
        // other half: a message or a stored setting from such a build, arriving at
        // runtime where the compiler cannot see it, must not reach the wire either.
        const withExtras = codecDecodeCall({
            endpoint: 'https://codec.example.com',
            namespace: 'ns',
            payloads,
            ...({
                token: 'Bearer not-a-real-token',
                passToken: true,
                includeCredentials: true,
                credentials: 'include',
            } as object),
        });
        expect(withExtras.init.headers).not.toHaveProperty('Authorization');
        expect(withExtras.init).not.toHaveProperty('credentials');
    });

    it('describes the whole request in three fields, none of which is a credential', () => {
        // The request is a POST, a header map and a string. That is the entire type
        // fetchFromPageWorld accepts, and this is the assertion that notices if it
        // grows a fourth field — which is how a `credentials` or an `auth` would come
        // back, quietly, in a diff about something else.
        //
        // The positive control is the assertion above that the same call DOES carry
        // X-Namespace and the payload body: the request is fully formed, so the short
        // list is a decision rather than an artefact of an empty init.
        for (const namespace of ['ns', 'another-ns']) {
            const call = codecDecodeCall({ endpoint: 'http://localhost:8081', namespace, payloads });
            expect(Object.keys(call.init).sort()).toEqual(['body', 'headers', 'method']);
            expect(call.init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Namespace': namespace });
        }
    });
});

// ── What is allowed to leave the browser ─────────────────────────────────────
//
// planCodecCall is the difference between "a payload needed decoding" and "every
// payload on that row was posted to a third party". It exists because the first
// version sent the whole array whenever any member of it needed a codec.
describe('planCodecCall and mergeDecoded', () => {
    const readable = payload('json/plain', '{"customer":"plaintext"}');
    const encrypted = payload('binary/encrypted', 'opaque');

    it('sends only the payloads that cannot be read here', () => {
        const plan = planCodecCall([readable, encrypted, readable]);

        expect(plan.send).toEqual([encrypted]);
        expect(plan.positions).toEqual([1]);
    });

    it('sends nothing at all when every payload is readable', () => {
        // The caller reads plan.send.length to decide whether to make a request,
        // so an empty plan is what "no egress" is made of.
        expect(planCodecCall([readable, readable]).send).toEqual([]);
        expect(planCodecCall([]).send).toEqual([]);
    });

    it('treats binary/null as readable rather than shipping it', () => {
        expect(planCodecCall([payload('binary/null', '')]).send).toEqual([]);
    });

    it('puts the answers back in their original positions', () => {
        const decoded = payload('json/plain', '"decrypted"');
        const plan = planCodecCall([readable, encrypted, readable]);

        const merged = mergeDecoded([readable, encrypted, readable], plan, [decoded]);

        expect(merged).toEqual([readable, decoded, readable]);
    });

    it('refuses a count that does not match the plan', () => {
        // Same reason readCodecResponse counts: pairing answer N with a different
        // argument N would relabel decrypted data instead of failing.
        const plan = planCodecCall([encrypted, encrypted]);

        expect(() => mergeDecoded([encrypted, encrypted], plan, [payload('json/plain', '"one"')])).toThrow(
            /1 payloads for 2/,
        );
    });
});

describe('readCodecResponse', () => {
    it('returns the decoded payloads when the count matches', () => {
        const decoded = [payload('json/plain', '{"a":1}')];
        expect(readCodecResponse({ payloads: decoded }, 1)).toEqual(decoded);
    });

    it('refuses a response with the wrong number of payloads', () => {
        // The panel pairs answer N with argument N. A silent mismatch would
        // relabel decrypted data, which is worse than showing an error.
        expect(() => readCodecResponse({ payloads: [] }, 2)).toThrow(/0 payloads for 2/);
    });

    it('refuses a response that is not a payloads array', () => {
        for (const bad of [{}, { payloads: 'nope' }, null, 'error']) {
            expect(() => readCodecResponse(bad, 1)).toThrow(/payloads array/);
        }
    });
});

describe('message guards', () => {
    const request = {
        source: MESSAGE_SOURCE,
        type: 'payload-request',
        id: 1,
        namespace: 'ns',
        workflowId: 'order-1',
        runId: RUN_ID,
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
        runId: RUN_ID,
        kind: 'input',
        label: 'Input',
        text: '{"orderId":7}',
        error: null,
        decodedBy: null,
    };

    it('accepts our own messages', () => {
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
        // makes the flag harmless is that codecDecodeCall has no parameter for it and
        // hard-wires `credentials: 'omit'`, which the tests above pin from the outside.
        //
        // A guard that rejected unknown keys would look stricter and protect nothing:
        // the sender chooses the keys.
        expect(isPayloadRequest({ ...request, codec: { endpoint: '', includeCredentials: true } })).toBe(true);
        expect(isPayloadRequest({ ...request, codec: { endpoint: '', token: 'Bearer nope' } })).toBe(true);
    });

    // ── The answer's own fields, to the leaves ──────────────────────────────
    //
    // This half is stricter than 02's equivalent, and the reason is the direction
    // of travel: a result message goes INTO the isolated world and its body is
    // rendered. The first two cases below are not hypotheses — they are what the
    // panel did while `text` and `error` were declared and never checked.
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
        // The four correlation fields are required so the matcher in tooltip.ts is
        // never handed an answer it cannot compare. Dropping any of them would make
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

    it('is a parser and not a gate, and says so where it is defined', () => {
        // The one property worth pinning about intent: a forged message that gets
        // the shape right IS accepted here, by design. Authorisation is the ledger
        // in pageApi.ts, and a reader who mistakes this for the check would remove
        // that one as redundant.
        expect(isPayloadRequest({ ...request, workflowId: 'someone-elses-workflow' })).toBe(true);
        // Same on the answering side, and here the shape check is even further from
        // being the protection: a well-formed result naming a run this side never
        // asked about is accepted by the guard and dropped by the correlation check.
        expect(isPayloadResult({ ...result, workflowId: 'someone-elses-workflow' })).toBe(true);
    });
});

describe('base64 helpers', () => {
    it('returns the raw string when it is not valid base64', () => {
        // Inside a tooltip, showing what arrived beats throwing.
        expect(base64ToText('not base64 !!')).toBe('not base64 !!');
    });

    it('counts bytes from the base64 length, padding included', () => {
        for (const text of ['a', 'ab', 'abc', 'abcd', '']) {
            expect(base64Bytes(b64(text))).toBe(new TextEncoder().encode(text).length);
        }
        expect(base64Bytes(null)).toBe(0);
    });
});
