// Workflow input and result: the pure half.
//
// This is the file that makes 03 a different extension from 02 rather than a
// bigger one. 02 reads history and reads nobody's data: event types, ids,
// timestamps, attempt counts, activity type names. Everything here is the data
// itself — the arguments a workflow was started with, what it returned, why it
// failed — and once a codec server is configured, the ciphertext of that data
// leaves the browser for a host the user named.
//
// Not one capability-bearing key of the manifest changes between the two: the same
// single `storage` permission, no host permissions, no service worker, the same
// content-script matches. A `diff` of the two files shows the name, the description,
// the version and a button's tooltip. That is the point worth copying: **a permission
// diff is not a capability diff**, and this is the rung where the difference is
// largest.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FETCH HAPPENS IN THE PAGE'S WORLD, NOT THE EXTENSION'S
//
// A content script cannot make this request. Chrome's own documentation:
// "Cross-origin requests are always treated as such in content scripts, even if
// the extension has host permissions." The request would carry the extension's
// origin, which nobody has allowed:
//
//   • On Temporal Cloud the API is NOT on cloud.temporal.io — it is on the
//     tenant host, so this is a cross-origin request even for the page itself.
//     It succeeds for the page because the tenant host sends the page's origin
//     back in Access-Control-Allow-Origin. It would fail for us.
//   • A codec server is configured with
//     `Access-Control-Allow-Origin: https://cloud.temporal.io` because that is
//     what the Temporal UI needs. Again: the page's origin, not ours.
//
// So the fetch is made from the MAIN world (see payloadServe.ts), where our
// request is indistinguishable from one the Temporal UI would have made itself.
// The consequence is the thing worth copying: **an already-working codec server
// needs no reconfiguration for this extension**, and we still declare no
// host_permissions, because a page-world fetch is the page's request, not ours.
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything in this file is pure and unit-tested. The impure parts — the two
// fetches and the DOM — are payloadServe.ts and tooltip.ts.

// `import type`, so it is erased at build time: this file stays pure, and the
// dependency is on the SHAPE the trust boundary accepts, not on the boundary itself.
import type { UnauthenticatedPost } from './pageApi';
import { MESSAGE_SOURCE } from './types';

// ── What crosses the postMessage boundary ────────────────────────────────────

export type PayloadKind = 'input' | 'outcome';

// A codec server, as the user typed it in the popup. Sent with every request
// rather than read from storage in the page world: the MAIN world holds no
// extension APIs, and it should not learn about settings it does not need.
//
// THIS CONFIG CARRIES NO CREDENTIAL SWITCH OF ANY KIND, AND BOTH ABSENCES ARE
// DELIBERATE DELETIONS RATHER THAN THINGS NOBODY GOT ROUND TO.
//
// Temporal's own UI offers to pass your access token to the codec server, and to
// send cookies with the call. This extension had both. They were removed once the
// request path was read as a trust boundary rather than as a feature list, and the
// argument that removed them is one sentence: THIS OBJECT ARRIVES OVER
// postMessage. Any script on the page — the app itself, another extension's
// content script — can name the endpoint. A credential flag sitting beside a
// caller-chosen host is a credential a forged message can aim, and it would have
// been aimed from the page world, which is exactly where the live bearer and the
// session cookies are.
//
// Note what this is NOT: it is not "the flag defaults to off, so we are fine". A
// default protects the honest path through the popup. It does nothing about a
// message that simply sets the field to true on its way past, because the value
// that reaches the fetch is the one in the message. Ambient authority plus a
// forgeable bus means the only safe number of credential switches is zero — the
// fetch in payloads.ts is hard-wired to `credentials: 'omit'` and there is no
// parameter to change it.
//
// If a fork needs an authenticated codec server, the honest fix is not to add the
// flag back. It is to stop taking the endpoint from a message at all: read it in
// the extension's own world and pass it in with chrome.scripting.executeScript,
// which needs host_permissions — a real permission for a real capability, which is
// the trade this whole repository is about.
export interface CodecConfig {
    endpoint: string;
}

export interface PayloadRequest {
    source: typeof MESSAGE_SOURCE;
    type: 'payload-request';
    // Correlates the answer with the hover that asked for it. Two hovers in
    // quick succession are two requests in flight, and the slower one must not
    // be rendered into the panel the faster one now owns.
    id: number;
    namespace: string;
    workflowId: string;
    runId: string;
    kind: PayloadKind;
    codec: CodecConfig;
}

export interface PayloadResult {
    source: typeof MESSAGE_SOURCE;
    type: 'payload-result';
    id: number;
    // Echoed back from the request, and checked by the asker before a word of
    // this reaches the screen — see the correlation note in tooltip.ts.
    //
    // The id alone is not enough, and the reason is specific to THIS stage. In 02
    // a mismatched answer put a wrong event type in a cell; here the body of the
    // message is somebody's payload, so an answer landing in the wrong panel is
    // one customer's data displayed under another customer's workflow. The id is
    // a small integer starting at 1 in every tab, which makes it exactly the
    // thing a forged message guesses right by accident. All four fields have to
    // agree.
    namespace: string;
    workflowId: string;
    runId: string;
    kind: PayloadKind;
    // "Input", "Completed", "Failed" — the heading, not the body.
    label: string;
    text: string;
    // Set instead of text when we could not answer at all. Rendered as-is, so
    // every message here is written for a human looking at a tooltip.
    error: string | null;
    // The HOST of the codec server that decoded part of this answer, or null when
    // nothing was sent anywhere. Named in the panel, because "decrypted by a
    // server you configured" and "was never encrypted" must not look identical.
    decodedBy: string | null;
}

// SHAPE ONLY. This says the message is well-formed; it says nothing whatever
// about who sent it.
//
// window.postMessage carries no sender identity that cannot be forged, and every
// field below is attacker-chooseable — `source` and `type` are two string
// literals published in this repository. So this function is a parser, not a
// gate: it exists so a malformed message is rejected in one place instead of
// throwing halfway through a fetch, and so `codec` cannot arrive as a string and
// take a different branch downstream.
//
// The actual authorisation is in pageApi.ts, and it is not a shape check:
// the ids in the message are answered only if the PAGE ITSELF listed that run.
// Read the ledger note there before adding a field here.
export function isPayloadRequest(value: unknown): value is PayloadRequest {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'payload-request') return false;
    if (typeof message['id'] !== 'number' || !Number.isFinite(message['id'])) return false;
    if (!isText(message['namespace']) || !isText(message['workflowId']) || !isText(message['runId'])) return false;
    if (!isKind(message['kind'])) return false;
    const codec = asObject(message['codec']);
    // `endpoint` is the whole config. Any other key a sender bothers to attach —
    // `includeCredentials`, `token` — is ignored here and unreadable downstream,
    // because nothing in the codec path takes a second parameter. See CodecConfig.
    return typeof codec?.['endpoint'] === 'string';
}

// SHAPE ONLY, for the same reason as above and with the sting 02's own result
// guard carries: this message travels INTO the isolated world, which is the side
// that renders. Anything on the page can post a well-formed one.
//
// So the check is total — every field, to the leaves — and it is still not
// provenance, which `postMessage` cannot provide. What narrows forged and
// accidental traffic is the correlation check in tooltip.ts, which keeps an answer
// only for a question this side asked, about the run it asked about.
//
// Validating to the leaves is what makes the panel's rendering honest: before
// this the declared `text: string` was never checked, so `{text: {}}` reached
// `textContent = …` as "[object Object]" and an `error` of `0` rendered as a
// panel with no error and no body.
export function isPayloadResult(value: unknown): value is PayloadResult {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'payload-result') return false;
    if (typeof message['id'] !== 'number' || !Number.isFinite(message['id'])) return false;
    if (!isText(message['namespace']) || !isText(message['workflowId']) || !isText(message['runId'])) return false;
    if (!isKind(message['kind'])) return false;
    if (typeof message['label'] !== 'string' || typeof message['text'] !== 'string') return false;
    // `null` and only null for both, never `undefined`: an absent field is a
    // different message from one that says "asked, and there is nothing", and
    // every answer this repository builds sends the explicit null.
    if (!isNullOr(message['error'], (error) => typeof error === 'string')) return false;
    return isNullOr(message['decodedBy'], (host) => typeof host === 'string');
}

function isKind(value: unknown): value is PayloadKind {
    return value === 'input' || value === 'outcome';
}

function isNullOr(value: unknown, ok: (value: unknown) => boolean): boolean {
    return value === null || ok(value);
}

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
    const text = base64ToText(payload.data ?? '');
    return encoding === 'json/plain' ? prettyJson(text) : text;
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

// PRETTY-PRINTING IS NOT FREE, AND THE COST IS SILENT.
//
// JSON.parse turns any number into an IEEE double, so an id of
// 12345678901234567890 comes back as 12345678901234567000 and JSON.stringify
// writes that back out. The value on screen is then simply wrong, in a way that
// looks exactly like real data — and account numbers and transaction ids are
// precisely the fields long enough for it to happen to.
//
// So when the text contains a long integer literal, the server's own formatting
// is shown untouched. Ugly beats wrong.
const LONG_INTEGER = /-?\b\d{16,}\b/;

export function prettyJson(text: string): string {
    if (LONG_INTEGER.test(text)) return text;
    try {
        return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
        // Not JSON despite the encoding saying so. Show what arrived.
        return text;
    }
}

// ── Talking to a codec server ───────────────────────────────────────────────

// Only these may be typed into the codec-endpoint field.
//
// The rule is about the payloads, not about the URL. A codec server's whole job
// is to hand back DECRYPTED data — the account numbers, the customer records,
// the tokens — so plain http to anywhere but this machine would put exactly that
// on the wire in the clear, one typo away from doing it to a host on the public
// internet. https, or loopback where there is no wire.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function safeCodecEndpoint(raw: string): string | null {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }
    if (parsed.protocol === 'https:') return trimmed;
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return trimmed;
    return null;
}

// ONE SOURCE FOR THE ENDPOINT: the popup. That is a deliberate limit, and it was
// briefly the other thing.
//
// A version of this extension read the endpoint out of the Temporal UI's own
// settings, so that a page already decoding these payloads did not have to be
// told where its codec server is. It is a genuinely nicer first run, and it is
// not what a starter kit is for: it added a second trust question (page state
// chose a host, so the access token had to be excluded from that path and the
// panel had to say which endpoint it used and why), a resolution order to keep in
// step with the UI's own — `(override && localStorage.endpoint) ||
// settings.codec.endpoint`, which is not guessable and did change between
// releases — and about a third of this file's code and prose, for a convenience.
//
// Deleted on that basis. If you want it in your own fork, read the UI's
// `getCodecEndpoint` (src/lib/utilities/get-codec.ts) and mirror it rather than
// guessing key names: guessing produced a feature that was silently off, on a
// page whose codec server was configured and working.

// WHAT GETS SENT: only the payloads that cannot be read here. Never the rest.
//
// The first version sent the whole `payloads` array whenever ANY member of it
// needed a codec, because that keeps the answer aligned with the request by
// index and costs one line less. The cost of that line is data: a workflow
// started with two arguments — a plaintext json/plain customer record and one
// encrypted blob — would have had BOTH posted to the codec server, and the
// plaintext one had no reason to leave the browser at all.
//
// So the positions are carried instead. `positions` is what makes the answer
// re-attachable; sending a subset without it is what would mislabel data.
export interface CodecPlan {
    // Indexes into the original array, ascending, of the payloads being sent.
    positions: number[];
    // Exactly those payloads, in the same order: the whole request body.
    send: RawPayload[];
}

export function planCodecCall(payloads: RawPayload[]): CodecPlan {
    const plan: CodecPlan = { positions: [], send: [] };
    payloads.forEach((payload, index) => {
        if (!needsCodec(payload)) return;
        plan.positions.push(index);
        plan.send.push(payload);
    });
    return plan;
}

// The decoded payloads back in their original positions, everything else
// untouched. Length-checked for the same reason readCodecResponse counts: the
// panel pairs answer N with argument N, and mislabelled decrypted data is worse
// than an error message.
export function mergeDecoded(original: RawPayload[], plan: CodecPlan, decoded: RawPayload[]): RawPayload[] {
    if (decoded.length !== plan.positions.length) {
        throw new Error(`Codec server returned ${decoded.length} payloads for ${plan.positions.length} sent.`);
    }
    const merged = [...original];
    plan.positions.forEach((position, index) => {
        merged[position] = decoded[index]!;
    });
    return merged;
}

export interface CodecCall {
    url: string;
    // NOT a RequestInit. This is the type fetchFromPageWorld accepts, and it has no
    // `credentials` field — so this builder cannot ask for an ambient credential even
    // by accident, and neither can whatever calls it next. Read the note above
    // UnauthenticatedPost in pageApi.ts; the rule lives with the function that sends
    // the request rather than with the one that describes it.
    init: UnauthenticatedPost;
}

// The request Temporal's own UI makes, minus its two credential options: POST
// {endpoint}/decode, the namespace in X-Namespace, and `{"payloads": […]}` in and
// out. Route, header and body match exactly, which is the point — a codec server
// already serving the Temporal UI needs no change to serve this, unless it
// authenticates its callers, and that is the one case this cannot do (below).
//
// NO CREDENTIAL OF ANY SORT IS REACHABLE FROM HERE — not the page's bearer, not
// its cookies. There is no parameter for either, and the call this returns cannot
// express one: `credentials` is not a field of the type, and fetchFromPageWorld
// sets it to 'omit' itself and refuses an Authorization header outright. See the
// CodecConfig note above for why both are deletions rather than omissions: the
// endpoint arrives over postMessage, and a credential switch beside a
// caller-chosen host is a credential a forged message can aim.
//
// The consequence, stated plainly because it is a real limitation: a codec server
// that authenticates its callers cannot be used from this extension. That is the
// intended trade at this rung of the ladder. An unauthenticated codec server on
// your own machine is the case this stage is built for.
export function codecDecodeCall(input: { endpoint: string; namespace: string; payloads: RawPayload[] }): CodecCall {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Namespace': input.namespace,
    };
    return {
        url: `${input.endpoint}/decode`,
        init: {
            method: 'POST',
            headers,
            body: JSON.stringify({ payloads: input.payloads }),
        },
    };
}

// What came back, checked before it is believed.
//
// The count check is not pedantry. The panel pairs answer N with argument N, so
// a server that returns three payloads for two arguments would relabel data
// rather than fail — and mislabelled decrypted data is worse than an error
// message.
export function readCodecResponse(body: unknown, sent: number): RawPayload[] {
    const payloads = asObject(body)?.['payloads'];
    if (!Array.isArray(payloads)) throw new Error('Codec server did not return a payloads array.');
    if (payloads.length !== sent) {
        throw new Error(`Codec server returned ${payloads.length} payloads for ${sent} sent.`);
    }
    return payloads as RawPayload[];
}

// ── Small shared helpers ────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function asText(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function isText(value: unknown): value is string {
    return typeof value === 'string' && value !== '';
}

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
