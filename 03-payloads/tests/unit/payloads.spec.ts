// src/payloads/payloads.ts — reading a history and formatting what is in it.
//
// Nothing here touches the codec server or the message protocol; those are
// codec.spec.ts and payloadMessages.spec.ts, mirroring the source split.
//
// Two of these specs exist because of a failure mode that produces CONFIDENT WRONG
// OUTPUT rather than an error, which is the only kind worth writing a long test
// about:
//   • pretty-printing a long integer silently changes its value, which is why this
//     rung does not pretty-print at all — a payload is displayed as the bytes that
//     arrived, and the spec asserts the round-trip it declines to do;
//   • matching on eventType instead of the attributes key works on one Temporal
//     version and quietly finds nothing on the next.

import { describe, expect, it } from 'vitest';

import {
    base64Bytes,
    base64ToText,
    clip,
    decodePayload,
    describeFailure,
    encodingOf,
    extractInput,
    extractOutcome,
    formatPayloads,
    MAX_DISPLAY_CHARS,
    needsCodec,
} from '../../src/payloads/payloads';
import { b64, event, FIXTURE_RUN_ID, payload } from '../payloadFixtures';

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

    it('shows no payloads rather than malformed ones when an element is not a payload', () => {
        // A history response is a document from outside. These elements used to be
        // CAST to RawPayload and handed straight on: `null` to encodingOf(), a
        // non-string `data` to atob(). The panel has a shape for "nothing to show",
        // and it is the right one here — nothing is on screen yet, so there is no
        // reader waiting on an answer to raise at. (The codec path, where there IS
        // one, throws instead; see codec.spec.ts.)
        for (const bad of [null, 42, { data: {} }, { metadata: { encoding: 5 } }]) {
            const events = [
                event('workflowExecutionStartedEventAttributes', { input: { payloads: [bad] } }),
            ];
            expect(extractInput({ events })!.payloads, JSON.stringify(bad)).toEqual([]);
        }
    });

    it('does not drop the good elements of a list quietly', () => {
        // Whole or nothing: one bad element out of two costs both, because dropping
        // it would renumber the argument that survives — "── 1 of 2 ──" would label
        // the second argument as the first.
        const events = [
            event('workflowExecutionStartedEventAttributes', {
                input: { payloads: [payload('json/plain', '{"a":1}'), { data: {} }] },
            }),
        ];
        expect(extractInput({ events })!.payloads).toEqual([]);
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
        expect(formatPayloads(outcome.payloads)).toBe('{"ok":true}');
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
            event('workflowExecutionContinuedAsNewEventAttributes', { newExecutionRunId: FIXTURE_RUN_ID }),
        ];
        expect(extractOutcome({ events })).toEqual({
            label: 'Continued as new',
            note: FIXTURE_RUN_ID,
            payloads: [],
        });
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
    it('hands back json/plain exactly as it arrived, unformatted', () => {
        expect(decodePayload(payload('json/plain', '{"a":1}'))).toBe('{"a":1}');
    });

    it('cannot change an id no round-trip could survive, because it never parses', () => {
        // THE REASON THIS RUNG DOES NOT FORMAT. The first assertion is the bug that
        // would exist if it did: the naive round-trip changes the value, and the
        // result looks exactly like real data. The second is that decodePayload —
        // the function a reader follows from the panel, base64 then UTF-8 then
        // display — puts out the same bytes it took in.
        const text = '{"transactionId":12345678901234567890}';
        expect(JSON.stringify(JSON.parse(text))).not.toBe(text);
        expect(decodePayload(payload('json/plain', text))).toBe(text);
    });

    it('treats every readable encoding the same way', () => {
        // No encoding gets special display treatment. text/plain that looks like
        // JSON, and json/plain itself, come out identically — as their own bytes.
        expect(decodePayload(payload('text/plain', '{"a":1}'))).toBe('{"a":1}');
        expect(decodePayload(payload('json/plain', '  {"spaced" :  1}  '))).toBe('  {"spaced" :  1}  ');
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

describe('base64 helpers', () => {
    it('says so, and still shows what arrived, when it is not valid base64', () => {
        // Inside a tooltip, showing what arrived beats throwing — but it used to be
        // returned BARE, which reads as a successful decode of something else. The
        // characters are all still there; they are now labelled.
        const shown = base64ToText('not base64 !!');
        expect(shown).toContain('not valid base64');
        expect(shown).toContain('not base64 !!');
    });

    it('never silently replaces a byte it cannot decode', () => {
        // THE CLAIM THIS RUNG MAKES IS THAT A PAYLOAD IS SHOWN UNALTERED. The default
        // TextDecoder is lossy in silence: 0xff becomes U+FFFD, and the panel has then
        // shown the reader a character the server never sent — an alteration that looks
        // like data. `fatal: true` turns that into a named case.
        const loneHighByte = btoa('ÿþ');
        const shown = base64ToText(loneHighByte);

        expect(shown).not.toContain('�');
        expect(shown).toContain('not UTF-8 text');
        expect(shown).toContain('2 bytes');
        // Lossless: the base64 is right there, and it pastes back into a request.
        expect(shown).toContain(loneHighByte);
    });

    it('still decodes real UTF-8, multi-byte characters included', () => {
        expect(base64ToText(btoa(String.fromCharCode(...new TextEncoder().encode('naïve café — ✓'))))).toBe(
            'naïve café — ✓',
        );
    });

    it('counts bytes from the base64 length, padding included', () => {
        for (const text of ['a', 'ab', 'abc', 'abcd', '']) {
            expect(base64Bytes(b64(text))).toBe(new TextEncoder().encode(text).length);
        }
        expect(base64Bytes(null)).toBe(0);
    });
});
