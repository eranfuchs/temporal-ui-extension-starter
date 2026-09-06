// Workflow input and result: finding them in a history, and turning them into text
// a person can read.
//
// RESPONSIBILITY: pure reading and pure formatting. Given a history response, which
// event holds the payloads and what they are called; given a payload, whether it can
// be read here at all and what it says if it can. Nothing in this file fetches,
// renders, or knows a codec server exists — src/payloads/codec.ts plans that call,
// src/payloads/payloadMessages.ts carries the messages, src/payloads/payloadServe.ts does the work.
//
// THIS IS THE FILE THAT MAKES 03 A DIFFERENT EXTENSION FROM 02 rather than a bigger
// one. 02 reads history and reads nobody's data: event types, ids, timestamps,
// attempt counts, activity type names. Everything here is the data itself — the
// arguments a workflow was started with, what it returned, why it failed.
//
// Not one capability-bearing key of the manifest changes between the two: the same
// single `storage` permission, no host permissions, no service worker, the same
// content-script matches. A `diff` of the two manifests shows the name, the
// description, the version and a button's tooltip. That is the point worth copying:
// **a permission diff is not a capability diff**, and this is the rung where the
// difference is largest.

import * as v from 'valibot';

import { asObject, asText } from './valueGuards';

// ── Reading the history ──────────────────────────────────────────────────────

// One entry of a `payloads[]` array, as Temporal serialises it: both fields are
// base64 in JSON. Optional AND nullable, separately, because the server sends
// neither for an empty payload and JSON has both spellings for "not here".
//
// A SCHEMA RATHER THAN AN INTERFACE, because both places this shape arrives are
// outside the extension: a history response from Temporal, and a decode response
// from whatever host the reader typed into the popup. An interface is a promise the
// compiler makes about our own code and says nothing about either of them — and a
// cast is how `{data: {}}` reaches `atob()` and how a `null` element reaches
// `encodingOf()`, in a tooltip, one hover away from the reader.
export const rawPayloadSchema = v.object({
    metadata: v.optional(v.nullable(v.record(v.string(), v.string()))),
    data: v.optional(v.nullable(v.string())),
});

export type RawPayload = v.InferOutput<typeof rawPayloadSchema>;

// The array form, used at both boundaries. WHOLE OR NOTHING, deliberately: a bad
// element is not filtered out, because the panel pairs answer N with argument N and
// dropping element 2 of 3 would silently relabel the two that remain — the same
// failure the codec count check exists to prevent, arriving by a different door.
export const rawPayloadsSchema = v.array(rawPayloadSchema);

export interface Extracted {
    label: string;
    // Text that is already text — a failure message, a termination reason. Shown
    // above the payloads, and it is the whole answer when there are none.
    note: string | null;
    payloads: RawPayload[];
}

// MATCH ON THE ATTRIBUTES KEY, NOT ON eventType.
//
// `eventType` comes back as "WorkflowExecutionStarted" from one Temporal
// version and "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED" from another, so any
// switch over it needs both spellings for every case and silently matches
// neither when a third appears. The attributes key is one string in both, and it
// is also the only place the payloads can be, so keying off it removes the
// question instead of answering it twice.
const STARTED_ATTRIBUTES = 'workflowExecutionStartedEventAttributes';

const OUTCOME_SHAPES: Array<{ attributes: string; label: string; payloadsAt?: string; note?: string }> = [
    { attributes: 'workflowExecutionCompletedEventAttributes', label: 'Completed', payloadsAt: 'result' },
    { attributes: 'workflowExecutionFailedEventAttributes', label: 'Failed' },
    { attributes: 'workflowExecutionTimedOutEventAttributes', label: 'Timed out' },
    {
        attributes: 'workflowExecutionTerminatedEventAttributes',
        label: 'Terminated',
        payloadsAt: 'details',
        note: 'reason',
    },
    { attributes: 'workflowExecutionCanceledEventAttributes', label: 'Canceled', payloadsAt: 'details' },
    {
        attributes: 'workflowExecutionContinuedAsNewEventAttributes',
        label: 'Continued as new',
        note: 'newExecutionRunId',
    },
];

export function extractInput(history: unknown): Extracted | null {
    for (const event of eventsOf(history)) {
        const attributes = asObject(asObject(event)?.[STARTED_ATTRIBUTES]);
        if (!attributes) continue;
        return { label: 'Input', note: null, payloads: payloadsIn(attributes['input']) };
    }
    return null;
}

export function extractOutcome(history: unknown): Extracted | null {
    for (const event of eventsOf(history)) {
        const holder = asObject(event);
        if (!holder) continue;
        for (const shape of OUTCOME_SHAPES) {
            const attributes = asObject(holder[shape.attributes]);
            if (!attributes) continue;
            const note = shape.attributes.endsWith('FailedEventAttributes')
                ? describeFailure(attributes['failure'])
                : shape.note
                  ? asText(attributes[shape.note])
                  : null;
            return {
                label: shape.label,
                note,
                payloads: shape.payloadsAt ? payloadsIn(attributes[shape.payloadsAt]) : [],
            };
        }
    }
    return null;
}

// The events of a history response. `history.events` is the documented shape; a
// bare `events` array is accepted too, because it costs one line and a response
// that changed shape is otherwise indistinguishable from a workflow with no
// events — one of those is a bug to report, the other is normal.
function eventsOf(history: unknown): unknown[] {
    const root = asObject(history);
    const events = asObject(root?.['history'])?.['events'] ?? root?.['events'];
    return Array.isArray(events) ? events : [];
}

// A history response is a document from outside, so its payload elements are
// validated rather than cast.
//
// ABSENT AND MALFORMED ARE DIFFERENT ANSWERS, and this is where they part company.
// A workflow that recorded nothing is normal and the panel has a shape for it. A
// history this extension cannot read is not, and reporting it as "nothing recorded"
// would be a confident wrong answer: byte-identical, on screen, to an argument-less
// workflow. So the unreadable cases throw, and servePayloadRequest() turns the
// message into visible text.
//
// FOUR CASES, and the boundary between them is proto3's JSON mapping rather than our
// preference — `input`, `result` and `details` are all `temporal.api.common.v1.Payloads`
// message fields holding one repeated `payloads`:
//
//   container absent, or `null`          → nothing recorded. `null` is a legal
//                                          encoding of an unset message field, so
//                                          both spellings mean the same thing; this
//                                          is the wire format, not laxity.
//   container present, not an object     → THROW. A message is encoded as an object
//                                          or as `null`, never as a string, a number
//                                          or an array.
//   `payloads` absent, `null`, or `[]`   → nothing recorded. `null` and `[]` are both
//                                          the empty repeated field.
//   `payloads` present and malformed     → THROW.
//
// The middle case is the one two versions of this function got wrong, each silently.
// The first returned `[]` for everything unreadable, on the argument that nothing was
// on screen yet — wrong about the order of events, since this runs AFTER the hover and
// the history fetch, with the panel open and reading `Loading…`. The second threw for a
// malformed `payloads` but reached it through `asObject(container)?.['payloads']`, so a
// scalar container collapsed to `undefined` on the way and `input: "bad"` reported
// "nothing recorded" again — the same wrong answer, one level up, and invisible because
// the fix looked like it covered the field it was written for.
//
// WHOLE OR NOTHING within a present array — see rawPayloadsSchema for why one bad
// element costs the array.
function payloadsIn(container: unknown): RawPayload[] {
    if (container === undefined || container === null) return [];
    const holder = asObject(container);
    if (!holder) throw unreadableHistory();
    const raw = holder['payloads'];
    if (raw === undefined || raw === null) return [];
    const payloads = v.safeParse(rawPayloadsSchema, raw);
    if (!payloads.success) throw unreadableHistory();
    return payloads.output;
}

// One message for every unreadable shape, because the reader can do nothing different
// about a scalar container than about a bad element, and naming which field failed
// would put a fragment of somebody's history into the panel.
function unreadableHistory(): Error {
    return new Error(
        'The history holds a payload list in a shape this extension cannot read, so nothing is shown rather than something wrong.',
    );
}

// A Temporal failure is a linked list: the interesting message is usually the
// innermost cause, and the outermost one is "activity task failed". So the chain
// is walked and joined rather than reporting only the top.
//
// The depth cap is not defensive dressing: `cause` is server-provided data, and
// a cycle in it would hang the panel.
const MAX_CAUSE_DEPTH = 8;

export function describeFailure(failure: unknown): string | null {
    const lines: string[] = [];
    let current = asObject(failure);
    for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
        const message = asText(current['message']);
        if (message) lines.push(depth === 0 ? message : `caused by: ${message}`);
        current = asObject(current['cause']);
    }
    const stack = asText(asObject(failure)?.['stackTrace']);
    if (stack) lines.push('', stack);
    return lines.length > 0 ? lines.join('\n') : null;
}

// ── Decoding a payload ──────────────────────────────────────────────────────

// Encodings we can read here, with no codec server and no egress. Everything
// else — `binary/encrypted` above all — is what a codec server is for.
//
// `json/protobuf` is deliberately NOT in this set even though it is not
// encrypted: decoding it needs the message's descriptor, which we do not have,
// and a codec server usually does.
const READABLE_ENCODINGS = new Set(['json/plain', 'binary/plain', 'text/plain']);
const NULL_ENCODING = 'binary/null';

export function encodingOf(payload: RawPayload): string {
    const raw = payload?.metadata?.['encoding'];
    return typeof raw === 'string' ? base64ToText(raw) : '';
}

// The one question that decides whether anything leaves the browser. src/payloads/codec.ts
// asks it of every payload and sends only the ones that answer yes.
export function needsCodec(payload: RawPayload): boolean {
    const encoding = encodingOf(payload);
    return encoding !== NULL_ENCODING && !READABLE_ENCODINGS.has(encoding);
}

// Anything longer than this is clipped before it reaches the DOM — the ONE bound
// this file's every consumer sees, whatever it goes on to do with the text. Cut
// tighter than a consumer's OWN bound (node count, say, rather than character
// count) and that consumer's bound never gets the chance to matter: its input
// arrives pre-broken into an invalid prefix instead. That is what the old value
// here, 20,000, did to 04-ui-goodies's JSON viewer — see "The clip underneath
// the cap" in docs/design-notes.md for the incident and how 2,000,000 was
// measured, both against the viewer's own budget and against a real render of
// the plain-text fallback this number's OWN worst case still is.
//
// Raising this number also raises payloadClient.ts's worst-case cache size —
// it caches every answer this size, up to MAX_CACHED_PAYLOADS of them. See
// MAX_CACHED_PAYLOAD_CHARS there: a change to either number now has to be
// weighed against the other.
export const MAX_DISPLAY_CHARS = 2_000_000;

export function decodePayload(payload: RawPayload): string {
    const encoding = encodingOf(payload);
    if (encoding === NULL_ENCODING) return 'null';
    if (needsCodec(payload)) {
        const bytes = base64Bytes(payload.data);
        return `(${encoding || 'unknown encoding'} — ${bytes} bytes, not decoded here. Set a codec server in the popup to read it.)`;
    }
    // NO PARSING AND NO REFORMATTING, whatever the encoding claims. Nothing here
    // re-indents, re-orders or re-serialises a payload — not even one that says it is
    // JSON. `JSON.parse` turns every number into an IEEE double, so a round-trip
    // silently rewrites a 20-digit account id into a different 20-digit account id
    // that looks exactly as real; the worked example is in
    // docs/design-notes.md#pretty-printing-silently-corrupted-long-integers.
    //
    // Formatting it *safely* is possible — it takes a lossless formatter that edits
    // only the whitespace between tokens, which takes a real JSON lexer, which takes
    // a dependency. That is stage 04's trade, together with the viewer it belongs to.
    // This rung shows you the payload; it does not typeset it.
    return base64ToText(payload.data ?? '');
}

export function formatPayloads(payloads: RawPayload[]): string {
    if (payloads.length === 0) return '';
    if (payloads.length === 1) return clip(decodePayload(payloads[0]!));
    // A workflow started with several arguments. Numbered, because "which
    // argument is this" is otherwise guesswork once two of them are objects.
    const parts = payloads.map(
        (payload, index) => `── ${index + 1} of ${payloads.length} ──\n${decodePayload(payload)}`,
    );
    return clip(parts.join('\n\n'));
}

export function clip(text: string): string {
    if (text.length <= MAX_DISPLAY_CHARS) return text;
    return `${text.slice(0, MAX_DISPLAY_CHARS)}\n\n… clipped: ${text.length - MAX_DISPLAY_CHARS} more characters.`;
}

// ── base64 ──────────────────────────────────────────────────────────────────

// base64 → text, via bytes. `atob` alone gives one char per BYTE, which mangles
// every non-ASCII character in a payload; TextDecoder is what makes it UTF-8.
//
// WHAT THIS FUNCTION CLAIMS, exactly: valid UTF-8 is handed back with no JSON parsing
// and no reformatting; anything else is LABELLED and shown as its base64. Not "the
// exact bytes the server sent" — that was the claim written here first, and it was
// wrong in three ways at once, each of them silent.
//
// `fatal: true` closes the worst one. The default decoder is lossy without saying so:
// every byte it cannot interpret becomes U+FFFD, so a `binary/plain` payload holding
// 0xff renders as the replacement character — U+FFFD, the black-diamond question mark
// — and the panel has shown the reader a character the server never sent: an
// alteration that looks like data. Fatal turns it into a named case. (Named here
// rather than shown, for the reason the BOM fixture gives in payloads.spec.ts: a
// character nobody can see in a diff is a character nobody reviews.)
//
// `ignoreBOM: true` closes the second. A leading EF BB BF is a real character of a
// real payload, and the default decoder eats it: `EF BB BF 61` decoded as `"a"`, so a
// payload whose first byte mattered came back one character short with nothing
// flagged. It is the same failure as the replacement character, one direction over.
//
// The third is not fixable here and is stated instead: formatPayloads() clips at
// MAX_DISPLAY_CHARS, so a long payload — or the base64 of an unreadable one — is a
// prefix, and says so. What is on screen is not always something that pastes back.
export function base64ToText(data: string): string {
    let bytes: Uint8Array;
    try {
        const binary = atob(data);
        bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    } catch {
        return `(not valid base64 — ${data.length} characters, shown as they arrived.)\n${data}`;
    }
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return `(not UTF-8 text — ${bytes.length} bytes, shown as base64.)\n${data}`;
    }
}

// Byte count from the base64 length, without decoding it: this is called to
// describe payloads we are NOT decoding, several of which may be large.
export function base64Bytes(data: string | null | undefined): number {
    if (!data) return 0;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
