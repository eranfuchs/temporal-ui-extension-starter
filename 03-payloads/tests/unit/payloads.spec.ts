// src/payloads/payloads.ts — reading a history and formatting what is in it.
//
// Nothing here touches the codec server or the message protocol; those are
// codec.spec.ts and payloadMessages.spec.ts, mirroring the source split.
//
// Two of these specs exist because of a failure mode that produces CONFIDENT WRONG
// OUTPUT rather than an error, which is the only kind worth writing a long test
// about:
//   • pretty-printing a long integer silently changes its value, which is why this
//     rung does not pretty-print at all — a readable payload is displayed with no JSON
//     parsing and no reformatting, and the spec asserts the round-trip it declines;
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

    it('raises rather than reporting a malformed payload list as nothing recorded', () => {
        // A history response is a document from outside. These elements used to be
        // CAST to RawPayload and handed straight on: `null` to encodingOf(), a
        // non-string `data` to atob(). Validating them was the first half of the fix.
        //
        // Returning `[]` was the WRONG second half, and this test is the one that says
        // so: `[]` is exactly what a workflow started with no arguments produces, so
        // the panel said "(nothing recorded)" about a history it could not read — the
        // two cases were byte-identical on screen. It throws now, and the reader is
        // told; see the serving-path half of this in apiInjectCodec.spec.ts.
        for (const bad of [null, 42, { data: {} }, { metadata: { encoding: 5 } }]) {
            const events = [
                event('workflowExecutionStartedEventAttributes', { input: { payloads: [bad] } }),
            ];
            expect(() => extractInput({ events }), JSON.stringify(bad)).toThrow(/cannot read/);
        }
    });

    it('does not drop the good elements of a list quietly', () => {
        // Whole or nothing: one bad element out of two costs both, because dropping
        // it would renumber the argument that survives — "── 1 of 2 ──" would label
        // the second argument as the first. And not quietly, which is the other word
        // in this test's name: the argument that survives is not shown alone.
        const events = [
            event('workflowExecutionStartedEventAttributes', {
                input: { payloads: [payload('json/plain', '{"a":1}'), { data: {} }] },
            }),
        ];
        expect(() => extractInput({ events })).toThrow(/cannot read/);
    });

    it('tells a payload list that is absent apart from one that is malformed', () => {
        // The other side of the throw above, and the reason it has to be narrow: every
        // one of these is a workflow that recorded nothing, which is normal. A rule that
        // raised on all of them would turn "no arguments" into an error message.
        for (const input of [undefined, null, {}, { payloads: null }, { payloads: [] }]) {
            const events = [event('workflowExecutionStartedEventAttributes', { input })];
            expect(extractInput({ events })!.payloads, JSON.stringify(input)).toEqual([]);
        }
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
        // THE CLAIM THIS FUNCTION MAKES IS THAT UNREADABLE BYTES ARE LABELLED, NOT
        // GUESSED AT. The default TextDecoder is lossy in silence: 0xff becomes U+FFFD,
        // and the panel has then shown the reader a character the server never sent — an
        // alteration that looks like data. `fatal: true` turns that into a named case.
        const loneHighByte = btoa('ÿþ');
        const shown = base64ToText(loneHighByte);

        expect(shown).not.toContain('�');
        expect(shown).toContain('not UTF-8 text');
        expect(shown).toContain('2 bytes');
        // And the base64 is shown beneath the label rather than dropped, which is what
        // makes the panel usable for a payload nothing here can read. Subject to
        // MAX_DISPLAY_CHARS like everything else, so it is not a promise that what is on
        // screen can be pasted back — see clip().
        expect(shown).toContain(loneHighByte);
    });

    it('keeps a byte-order mark instead of eating it', () => {
        // The same failure as the replacement character, one direction over. The default
        // decoder strips a leading EF BB BF, so `EF BB BF 61` came back as "a": a payload
        // whose first character mattered was one character short, with nothing said about
        // it and no way to tell from the panel. `ignoreBOM: true` makes it a character
        // again. Reproduced against the fatal-only decoder before the option was added.
        //
        // Both sides are written as escapes rather than typed literally, for the reason
        // the protobuf fixture above gives: a byte-order mark is invisible in a diff, and
        // an assertion nobody can see is an assertion nobody reviews.
        expect(base64ToText(btoa(String.fromCharCode(0xef, 0xbb, 0xbf, 0x61)))).toBe('\ufeffa');
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
