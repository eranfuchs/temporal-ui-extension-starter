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

import { asObject, asText } from './valueGuards';

// ── Reading the history ──────────────────────────────────────────────────────

// One entry of a `payloads[]` array, as Temporal serialises it: both fields are
// base64 in JSON.
export interface RawPayload {
    metadata?: Record<string, string> | null;
    data?: string | null;
}

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

function payloadsIn(container: unknown): RawPayload[] {
    const payloads = asObject(container)?.['payloads'];
    return Array.isArray(payloads) ? (payloads as RawPayload[]) : [];
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

// Anything longer than this is clipped before it reaches the DOM. A single
// workflow argument can be megabytes; laying that into a tooltip freezes the
// tab, and nobody reads past the first screen of it anyway.
export const MAX_DISPLAY_CHARS = 20_000;

export function decodePayload(payload: RawPayload): string {
    const encoding = encodingOf(payload);
    if (encoding === NULL_ENCODING) return 'null';
    if (needsCodec(payload)) {
        const bytes = base64Bytes(payload.data);
        return `(${encoding || 'unknown encoding'} — ${bytes} bytes, not decoded here. Set a codec server in the popup to read it.)`;
    }
    // EXACTLY THE BYTES THE SERVER SENT, whatever the encoding claims. Nothing here
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
export function base64ToText(data: string): string {
    try {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return new TextDecoder().decode(bytes);
    } catch {
        // Not valid base64. Returning the raw string is more useful than
        // throwing inside a tooltip.
        return data;
    }
}

// Byte count from the base64 length, without decoding it: this is called to
// describe payloads we are NOT decoding, several of which may be large.
export function base64Bytes(data: string | null | undefined): number {
    if (!data) return 0;
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
