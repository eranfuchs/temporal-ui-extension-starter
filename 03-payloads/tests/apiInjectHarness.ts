// The jsdom harness for the second MAIN-world bundle: a fake network at the bottom
// of the fetch chain, the two scripts imported in the manifest's order, and the
// helpers that ask a question and wait for its answer.
//
// WHY IT IS SHARED RATHER THAN COPIED. Three spec files drive apiInject.ts —
// apiInject.spec.ts (the trust boundary), apiInjectRowInfo.spec.ts (the per-row
// questions) and apiInjectCodec.spec.ts (the one egress path) — and all three assert
// against the SAME ledger, filled by the same list response. The ledger is the
// authorisation list: which runs may be asked about at all. A per-file fake network
// would let one file's idea of what the page listed drift from another's, and the
// drift would be invisible, because each file would still be internally consistent.
//
// WHY IT IS NOT IN tests/helpers.ts. That file is lineage-SHARED across all three
// projects and byte-identical in each; this harness imports src/apiInject.ts, which
// 01-family-tree does not have and whose absence is the whole point of that stage.
//
// THE STATE HERE OUTLIVES A TEST, deliberately and dangerously: apiInject.ts
// registers a 'message' listener on a window vitest reuses for the entire file, and
// the module registry is reset per test. installApiInjectHarness() and
// teardownApiInjectHarness() are both required, in beforeEach and afterEach. Left to
// accumulate, the instance from test 1 answers test 2's question as well — and it
// never saw test 2's list call, so it answers "nothing observed" beside the correct
// answer and an assertion reads whichever arrived first.

import { expect, vi } from 'vitest';

import { isPayloadResult, type PayloadRequest, type PayloadResult } from '../src/payloads/payloadMessages';
import { isRowInfoResult, type RowInfoRequest, type RowInfoResult } from '../src/rowInfo/rowInfo';
import { MESSAGE_SOURCE } from '../src/types';

export const NAMESPACE = 'sample-namespace';
export const LIST_URL = `https://tenant.example.com/api/v1/namespaces/${NAMESPACE}/workflows?query=`;
export const API_PREFIX = 'https://tenant.example.com';
export const BEARER = 'Bearer page-owns-this';
export const WORKFLOW_ID = 'order-1';
export const RUN_ID = '00000000-0000-4000-8000-000000000001';

export function b64(text: string): string {
    return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

// ── What a payload hover reads ────────────────────────────────────────────────
//
// The panel's two questions come from OPPOSITE ENDS of one history: the input is
// the first event, fetched forward, and the outcome is the last, fetched in
// reverse — the same route the "last event" column uses. Only the forward body is
// varied by the specs, because the input is what every codec test hovers.

// A history holding one started event, which is all extractInput reads.
export const INPUT_BODY = {
    history: {
        events: [
            {
                eventId: '1',
                workflowExecutionStartedEventAttributes: {
                    input: { payloads: [{ metadata: { encoding: b64('json/plain') }, data: b64('"hello"') }] },
                },
            },
        ],
    },
};

// The same, but the input is a payload nothing here can read: this is what a codec
// server exists for, and the only history that reaches one.
export const ENCRYPTED_INPUT_BODY = {
    history: {
        events: [
            {
                eventId: '1',
                workflowExecutionStartedEventAttributes: {
                    input: { payloads: [{ metadata: { encoding: b64('binary/encrypted') }, data: b64('opaque') }] },
                },
            },
        ],
    },
};

// The two answers a per-row question is folded from, kept apart because they come
// from DIFFERENT ROUTES: the newest event comes from history-reverse, and
// pendingActivities comes from DescribeWorkflowExecution and from nowhere else. A
// fixture that conflated them would hide exactly the mistake that makes the "last
// event" column show the FIRST event of every workflow.

// As history-reverse returns it: newest first, so events[0] is the answer. The
// enum spelling is the long one on purpose — a server that says
// EVENT_TYPE_ACTIVITY_TASK_STARTED and one that says ActivityTaskStarted must
// produce the same cell.
export const LAST_EVENT_BODY = {
    history: {
        events: [{ eventId: '42', eventType: 'EVENT_TYPE_ACTIVITY_TASK_STARTED', eventTime: '2026-01-01T11:59:00Z' }],
    },
};

// A describe response for a workflow whose activity is stuck. `lastFailure` is
// present because the real one always is — that is what makes the assertion about
// what we decline to read worth writing.
export const STUCK_DESCRIBE_BODY = {
    pendingActivities: [
        {
            activityId: 'customer-4711-step-2',
            activityType: { name: 'ChargeCard' },
            attempt: 1518,
            maximumAttempts: 0,
            scheduledTime: '2026-01-01T11:58:00Z',
            nextAttemptScheduleTime: '2026-01-01T12:00:30Z',
            lastFailure: { message: 'account 4711 is overdrawn', stackTrace: 'at charge.ts:88' },
        },
    ],
};

// The list response is not only how the API prefix and the bearer are learned —
// it is the AUTHORISATION LIST. Every run in it may be asked about; nothing else
// may. See the trust-boundary note at the top of src/page/pageApi.ts.
export const LIST_BODY = { executions: [{ execution: { workflowId: WORKFLOW_ID, runId: RUN_ID } }] };

// What the fake network does, as a spec may change it BETWEEN two requests. One
// mutable object rather than a `let` per field, because an imported binding cannot be
// assigned by the module that imports it, and a setter per field would be seven
// functions that do nothing but assign.
//
// Bodies are set per test rather than branched on inside the fake, so the request
// assertions stay about the request.
export const fake: {
    forwardHistoryBody: unknown;
    reverseHistoryBody: unknown;
    describeBody: unknown;
    listBody: unknown;
    // Which requests the fake network HOLDS OPEN until a spec lets them go.
    //
    // Without this, a spec that claims something about slowness proves nothing: if
    // every fake response resolves immediately, "the fast row answered first" is true
    // of a batched implementation too. Timing claims need a network the spec controls.
    holdWhen: ((url: string) => boolean) | null;
    // Which responses have their BODY PARSE held. The ledger is filled off
    // `clone.text()` a moment after a list response arrives, so this is the only way
    // to make two overlapping list responses finish parsing in the opposite order to
    // their arrival — the case a single "the parse in flight" promise cannot cover.
    holdBodyWhen: ((url: string) => boolean) | null;
    // Which requests the fake network REFUSES, and with what — the status, and a
    // Retry-After when the spec is about backoff. Per-url rather than global, because
    // the interesting assertions are about what a refusal does to the OTHER rows.
    failWhen: ((url: string) => { status: number; retryAfter?: string } | null) | null;
} = {
    forwardHistoryBody: INPUT_BODY,
    reverseHistoryBody: LAST_EVENT_BODY,
    describeBody: STUCK_DESCRIBE_BODY,
    listBody: LIST_BODY,
    holdWhen: null,
    holdBodyWhen: null,
    failWhen: null,
};

// `bodyGate`, when a spec passes one, delays `clone().text()` — the step the ledger
// is filled from. It is deliberately separate from holding the response itself: the
// interesting race is between two responses that have both ARRIVED and are being
// parsed, and it cannot be produced by delaying arrival.
function fakeResponse(body: unknown, bodyGate?: Promise<void>): Response {
    const text = JSON.stringify(body);
    return {
        ok: true,
        status: 200,
        clone: () => ({
            text: async () => {
                if (bodyGate) await bodyGate;
                return text;
            },
        }),
        json: async () => JSON.parse(text),
    } as unknown as Response;
}

// A response the server refused. Separate from fakeResponse because the two are
// read by different code: `ok` decides which branch runs, and `headers` is reached
// ONLY on the failing branch — refuse() in rowInfoServe.ts asks it for Retry-After.
// A fake without headers turns "the 429 path" into a TypeError that passes as a
// failure for the wrong reason.
function failedResponse(status: number, retryAfter: string | null): Response {
    return {
        ok: false,
        status,
        headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
    } as unknown as Response;
}

// A codec server that answers correctly: one decoded payload per payload sent,
// which is the count readCodecResponse insists on.
function decodedAnswer(init?: RequestInit): unknown {
    const sent = JSON.parse(String(init?.body ?? '{"payloads":[]}')) as { payloads: unknown[] };
    return {
        payloads: sent.payloads.map(() => ({ metadata: { encoding: b64('json/plain') }, data: b64('"decrypted"') })),
    };
}

// Every request that reached the bottom of the chain, with the header it carried
// and what it posted — the Authorization header is the point of most of these
// tests, the URL is the point of several more, and the BODY is the point of the
// egress ones: "only the payloads it cannot read left the browser" is a claim about
// bytes, not about a destination.
export interface Seen {
    url: string;
    authorization: string | null;
    body: string | null;
    // `credentials` decides whether the BROWSER attaches cookies, so a header-only
    // record cannot see an ambient credential at all — the request that carries one
    // looks identical to the request that does not. This field was added because the
    // egress tests read as though they covered credentials and did not: the codec
    // call now hard-wires 'omit', and this is what lets a test say so from outside.
    credentials: RequestCredentials | undefined;
}

// All three are emptied IN PLACE rather than reassigned, so a spec can hold a
// reference across a reset.
export const reachedNetwork: Seen[] = [];
export const rowInfoResults: RowInfoResult[] = [];
export const payloadResults: PayloadResult[] = [];

const capture = (event: MessageEvent) => {
    if (isRowInfoResult(event.data)) rowInfoResults.push(event.data);
    if (isPayloadResult(event.data)) payloadResults.push(event.data);
};

export const reverseCalls = () => reachedNetwork.filter((seen) => seen.url.includes('/history-reverse'));
export const describeCalls = () => reachedNetwork.filter((seen) => /\/workflows\/[^/?]+\?/.test(seen.url));
export const forwardCalls = () =>
    reachedNetwork.filter((seen) => seen.url.includes('/history?') && !seen.url.includes('/history-reverse'));
export const decodeCalls = () => reachedNetwork.filter((seen) => seen.url.includes('/decode'));

// Both kinds of hold release from here, so one call in afterEach cannot miss one.
//
// Exported, and a `let` rather than one of the emptied-in-place arrays above,
// because a spec asserts on its LENGTH: "two requests are outstanding" is how the
// concurrency claims say the network really was held. An importing module can read
// a live binding; it just cannot assign one, which is what makes this safe to export
// while releaseHeld() swaps the array.
export let held: (() => void)[] = [];

export function releaseHeld(): void {
    const waiting = held;
    held = [];
    for (const release of waiting) release();
}

// Which body answers which route. A function rather than a ternary chain now that
// there are five of them, and the ORDER of the tests inside it is load-bearing:
// '/history-reverse' contains '/history', and a describe URL names a workflow AND
// carries a query while the list URL carries a query but names no workflow.
function bodyFor(url: string, init?: RequestInit): unknown {
    if (url.includes('/decode')) return decodedAnswer(init);
    if (url.includes('/history-reverse')) return fake.reverseHistoryBody;
    if (url.includes('/history')) return fake.forwardHistoryBody;
    if (/\/workflows\/[^/?]+\?/.test(url)) return fake.describeBody;
    return fake.listBody;
}

// The stand-in at the bottom of every chain: answers each route with its own body,
// and anything it does not recognise with a workflow list.
function bottomFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    const headers = new Headers(init?.headers ?? {});
    reachedNetwork.push({
        url,
        authorization: headers.get('authorization'),
        body: init?.body === undefined ? null : String(init.body),
        credentials: init?.credentials,
    });
    const body = bodyFor(url, init);
    const bodyGate = fake.holdBodyWhen?.(url) ? new Promise<void>((resolve) => held.push(resolve)) : undefined;
    const refusal = fake.failWhen?.(url) ?? null;
    // Built when the hold is let go rather than now, so a refusal and a hold can be
    // combined in one test.
    const answer = () =>
        refusal ? failedResponse(refusal.status, refusal.retryAfter ?? null) : fakeResponse(body, bodyGate);
    if (fake.holdWhen?.(url)) {
        return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    }
    return Promise.resolve(answer());
}

export function rowInfoRequest(overrides: Partial<RowInfoRequest> = {}): RowInfoRequest {
    return {
        source: MESSAGE_SOURCE,
        type: 'row-info-request',
        namespace: NAMESPACE,
        want: ['lastEvent', 'retry'],
        runs: [{ workflowId: WORKFLOW_ID, runId: RUN_ID }],
        // The automatic mode. The tests that care about the other one set it
        // explicitly, so a reader of any single test can see which one it is about.
        fresh: false,
        ...overrides,
    };
}

export function payloadRequest(overrides: Partial<PayloadRequest> = {}): PayloadRequest {
    return {
        source: MESSAGE_SOURCE,
        type: 'payload-request',
        id: 1,
        namespace: NAMESPACE,
        workflowId: WORKFLOW_ID,
        runId: RUN_ID,
        kind: 'input',
        codec: { endpoint: '' },
        ...overrides,
    };
}

// apiInject.ts answers a message with a message, and its answer is a fetch away,
// so several macrotask hops are needed before anything has arrived.
export async function settle(): Promise<void> {
    for (let hop = 0; hop < 10; hop++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

// Returns the answers to THIS question, not rowInfoResults[0]: several specs ask
// twice, because "one namespace's list does not stand in for another's" cannot be
// asserted with one question.
export async function askRows(overrides: Partial<RowInfoRequest> = {}): Promise<RowInfoResult[]> {
    const before = rowInfoResults.length;
    window.dispatchEvent(new MessageEvent('message', { data: rowInfoRequest(overrides), source: window }));
    await settle();
    return rowInfoResults.slice(before);
}

// One answer, asserted to be there. Most specs ask about one run and reading `[0]`
// of an empty array would fail as `undefined` has no `.error` rather than as
// "nothing answered", which is the thing that actually went wrong.
export async function askOneRow(overrides: Partial<RowInfoRequest> = {}): Promise<RowInfoResult> {
    const answers = await askRows(overrides);
    expect(answers).toHaveLength(1);
    return answers[0]!;
}

// One hover. Returns the answer to THIS one rather than payloadResults[0], for the
// same reason askRows() slices: a spec that hovers twice must be able to tell the
// two answers apart.
export async function askPayload(overrides: Partial<PayloadRequest> = {}): Promise<PayloadResult> {
    const before = payloadResults.length;
    window.dispatchEvent(new MessageEvent('message', { data: payloadRequest(overrides), source: window }));
    await settle();
    expect(payloadResults).toHaveLength(before + 1);
    return payloadResults[before]!;
}

// What an import registered, so afterEach can unregister it. See the note at the
// top of this file: without this, listeners accumulate across tests.
let installed: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = [];

async function loadMainWorldScripts(): Promise<void> {
    const real = window.addEventListener.bind(window);
    (window as { addEventListener: typeof window.addEventListener }).addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
    ) => {
        installed.push({ type, listener });
        real(type, listener, options);
    }) as typeof window.addEventListener;
    try {
        vi.resetModules();
        // The manifest's order, and it matters: inject.ts installs the property
        // that pageApi.ts then has to compose with.
        await import('../src/inject');
        await import('../src/apiInject');
    } finally {
        // Put it back by assignment, not by `delete`: in jsdom addEventListener
        // is an OWN property of window, so deleting it removes the method rather
        // than uncovering the prototype's.
        (window as { addEventListener: typeof window.addEventListener }).addEventListener = real;
    }
}

export async function installApiInjectHarness(): Promise<void> {
    reachedNetwork.length = 0;
    rowInfoResults.length = 0;
    payloadResults.length = 0;
    installed = [];
    fake.forwardHistoryBody = INPUT_BODY;
    fake.reverseHistoryBody = LAST_EVENT_BODY;
    fake.describeBody = STUCK_DESCRIBE_BODY;
    fake.listBody = LIST_BODY;
    fake.holdWhen = null;
    fake.holdBodyWhen = null;
    fake.failWhen = null;
    held = [];
    // writable + configurable, because the previous test left a getter here.
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: bottomFetch });
    await loadMainWorldScripts();
    window.addEventListener('message', capture);
}

export function teardownApiInjectHarness(): void {
    // Let go of anything a spec held, so a failed assertion cannot leave a
    // never-settling promise behind for the next one.
    fake.holdWhen = null;
    fake.holdBodyWhen = null;
    fake.failWhen = null;
    releaseHeld();
    window.removeEventListener('message', capture);
    for (const { type, listener } of installed) window.removeEventListener(type, listener);
}
