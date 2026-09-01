// @vitest-environment jsdom
//
// The second MAIN-world bundle (apiInject.ts) observes the page’s own traffic to
// learn two things it cannot guess: the API prefix and the Authorization header.
// Everything here is about STAYING observed.
//
// The failure this file exists for was found on a live Temporal Cloud tenant and
// is invisible offline without it: the tree drew perfectly while every per-row
// question answered "Nothing observed on this page yet", forever. Two observers of
// the same global, and only one of them still hooked up — no error, no warning,
// and each half looked fine on its own.
//
// Both scripts are IIFEs with no exports: importing them IS running them, in the
// order the manifest lists them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRowInfoResult, type RowInfoRequest, type RowInfoResult } from '../../src/rowInfo';
import { MESSAGE_SOURCE } from '../../src/types';

const NAMESPACE = 'sample-namespace';
const LIST_URL = `https://tenant.example.com/api/v1/namespaces/${NAMESPACE}/workflows?query=`;
const API_PREFIX = 'https://tenant.example.com';
const BEARER = 'Bearer page-owns-this';
const WORKFLOW_ID = 'order-1';
const RUN_ID = '00000000-0000-4000-8000-000000000001';

// The two answers a per-row question is folded from, kept apart because they come
// from DIFFERENT ROUTES: the newest event comes from history-reverse, and
// pendingActivities comes from DescribeWorkflowExecution and from nowhere else. A
// fixture that conflated them would hide exactly the mistake that makes the "last
// event" column show the FIRST event of every workflow.

// As history-reverse returns it: newest first, so events[0] is the answer. The
// enum spelling is the long one on purpose — a server that says
// EVENT_TYPE_ACTIVITY_TASK_STARTED and one that says ActivityTaskStarted must
// produce the same cell.
const LAST_EVENT_BODY = {
    history: {
        events: [{ eventId: '42', eventType: 'EVENT_TYPE_ACTIVITY_TASK_STARTED', eventTime: '2026-01-01T11:59:00Z' }],
    },
};

// A describe response for a workflow whose activity is stuck. `lastFailure` is
// present because the real one always is — that is what makes the assertion about
// what we decline to read worth writing.
const STUCK_DESCRIBE_BODY = {
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

// Set per test rather than branched on inside it, so the request assertions stay
// about the request.
let reverseHistoryBody: unknown = LAST_EVENT_BODY;
let describeBody: unknown = STUCK_DESCRIBE_BODY;

// The list response is not only how the API prefix and the bearer are learned —
// it is the AUTHORISATION LIST. Every run in it may be asked about; nothing else
// may. See the trust-boundary note at the top of pageApi.ts.
const LIST_BODY = { executions: [{ execution: { workflowId: WORKFLOW_ID, runId: RUN_ID } }] };
// Which body the fake network answers a list call with, so a test can put a
// different set of runs on the page.
let listBody: unknown = LIST_BODY;

// `bodyGate`, when a test passes one, delays `clone().text()` — the step the ledger
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

// Every request that reached the bottom of the chain, with the header it carried —
// the Authorization header is the point of most of these tests, and the URL is the
// point of the rest.
interface Seen {
    url: string;
    authorization: string | null;
}

let reachedNetwork: Seen[] = [];
let rowInfoResults: RowInfoResult[] = [];

const capture = (event: MessageEvent) => {
    if (isRowInfoResult(event.data)) rowInfoResults.push(event.data);
};

const reverseCalls = () => reachedNetwork.filter((seen) => seen.url.includes('/history-reverse'));
const describeCalls = () => reachedNetwork.filter((seen) => /\/workflows\/[^/?]+\?/.test(seen.url));

// Which requests the fake network HOLDS OPEN until a test lets them go.
//
// Without this, a test that claims something about slowness proves nothing: if
// every fake response resolves immediately, "the fast row answered first" is true
// of a batched implementation too. Timing claims need a network the test controls.
let holdWhen: ((url: string) => boolean) | null = null;

// Which responses have their BODY PARSE held. The ledger is filled off
// `clone.text()` a moment after a list response arrives, so this is the only way to
// make two overlapping list responses finish parsing in the opposite order to their
// arrival — the case a single "the parse in flight" promise cannot cover.
let holdBodyWhen: ((url: string) => boolean) | null = null;

// Which requests the fake network REFUSES, and with what — the status, and a
// Retry-After when the test is about backoff. Per-url rather than global, because
// the interesting assertions are about what a refusal does to the OTHER rows.
let failWhen: ((url: string) => { status: number; retryAfter?: string } | null) | null = null;

// Both kinds of hold release from here, so one call in afterEach cannot miss one.
let held: (() => void)[] = [];

function releaseHeld(): void {
    const waiting = held;
    held = [];
    for (const release of waiting) release();
}

// The stand-in at the bottom of every chain: answers each of the two per-row
// routes with its own body, and anything else with a workflow list.
function bottomFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    const headers = new Headers(init?.headers ?? {});
    reachedNetwork.push({ url, authorization: headers.get('authorization') });
    const body = url.includes('/history-reverse')
        ? reverseHistoryBody
        : // A describe URL names a workflow AND carries a query; the list URL
          // carries a query but names no workflow.
          /\/workflows\/[^/?]+\?/.test(url)
          ? describeBody
          : listBody;
    const bodyGate = holdBodyWhen?.(url) ? new Promise<void>((resolve) => held.push(resolve)) : undefined;
    const refusal = failWhen?.(url) ?? null;
    // Built when the hold is let go rather than now, so a refusal and a hold can be
    // combined in one test.
    const answer = () =>
        refusal ? failedResponse(refusal.status, refusal.retryAfter ?? null) : fakeResponse(body, bodyGate);
    if (holdWhen?.(url)) {
        return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    }
    return Promise.resolve(answer());
}

function rowInfoRequest(overrides: Partial<RowInfoRequest> = {}): RowInfoRequest {
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

// apiInject.ts answers a message with a message, and its answer is a fetch away,
// so several macrotask hops are needed before anything has arrived.
async function settle(): Promise<void> {
    for (let hop = 0; hop < 10; hop++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

// Returns the answers to THIS question, not rowInfoResults[0]: several tests below
// ask twice, because "one namespace's list does not stand in for another's" cannot
// be asserted with one question.
async function askRows(overrides: Partial<RowInfoRequest> = {}): Promise<RowInfoResult[]> {
    const before = rowInfoResults.length;
    window.dispatchEvent(new MessageEvent('message', { data: rowInfoRequest(overrides), source: window }));
    await settle();
    return rowInfoResults.slice(before);
}

// One answer, asserted to be there. Most tests ask about one run and reading
// `[0]` of an empty array would fail as `undefined` has no `.error` rather than as
// "nothing answered", which is the thing that actually went wrong.
async function askOneRow(overrides: Partial<RowInfoRequest> = {}): Promise<RowInfoResult> {
    const answers = await askRows(overrides);
    expect(answers).toHaveLength(1);
    return answers[0]!;
}

// Every test imports the two scripts fresh, and apiInject.ts registers a
// 'message' listener on a window vitest reuses for the whole file. Left to
// accumulate, the instance from test 1 answers test 2's question as well — and it
// never saw test 2's list call, so it answers "nothing observed" beside the
// correct answer and an assertion reads whichever arrived first. Record what an
// import registers; unregister it afterwards.
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
        await import('../../src/inject');
        await import('../../src/apiInject');
    } finally {
        // Put it back by assignment, not by `delete`: in jsdom addEventListener
        // is an OWN property of window, so deleting it removes the method rather
        // than uncovering the prototype's.
        (window as { addEventListener: typeof window.addEventListener }).addEventListener = real;
    }
}

beforeEach(async () => {
    reachedNetwork = [];
    rowInfoResults = [];
    installed = [];
    reverseHistoryBody = LAST_EVENT_BODY;
    describeBody = STUCK_DESCRIBE_BODY;
    listBody = LIST_BODY;
    holdWhen = null;
    holdBodyWhen = null;
    failWhen = null;
    held = [];
    // writable + configurable, because the previous test left a getter here.
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: bottomFetch });
    await loadMainWorldScripts();
    window.addEventListener('message', capture);
});

afterEach(() => {
    // Let go of anything a test held, so a failed assertion cannot leave a
    // never-settling promise behind for the next one.
    holdWhen = null;
    holdBodyWhen = null;
    failWhen = null;
    releaseHeld();
    window.removeEventListener('message', capture);
    for (const { type, listener } of installed) window.removeEventListener(type, listener);
});

describe('learning the API prefix and the bearer from the page', () => {
    it('answers a per-row question once the page has fetched its list', async () => {
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        const result = await askOneRow({ want: ['lastEvent'] });

        expect(result.error).toBeNull();
        expect(result.lastEvent).not.toBeNull();
        expect(reverseCalls()).toHaveLength(1);
        // Derived from the observed URL, never from location.origin: on Cloud the
        // API is on the tenant host and the page is on cloud.temporal.io.
        expect(reverseCalls()[0]!.url).toBe(
            `${API_PREFIX}/api/v1/namespaces/${NAMESPACE}/workflows/${WORKFLOW_ID}/history-reverse?maximumPageSize=1&execution.runId=${RUN_ID}`,
        );
        // Cloud answers 403 to a request carrying only cookies.
        expect(reverseCalls()[0]!.authorization).toBe(BEARER);
    });

    it('says what to do when the page has not fetched a list yet', async () => {
        const result = await askOneRow();

        expect(result.error).toMatch(/reload the workflow list/);
        expect(reachedNetwork).toHaveLength(0);
    });

    it('reads a bearer the page passed on a Request object rather than an init', async () => {
        await window.fetch(new Request(LIST_URL, { headers: { authorization: BEARER } }));

        const result = await askOneRow({ want: ['lastEvent'] });

        expect(result.error).toBeNull();
        expect(reverseCalls()[0]!.authorization).toBe(BEARER);
    });

    it('ignores every call that is not a workflow list', async () => {
        await window.fetch(`${API_PREFIX}/api/v1/namespaces/${NAMESPACE}/workflow-count`, {
            headers: { authorization: BEARER },
        });

        expect((await askOneRow()).error).toMatch(/reload the workflow list/);
    });
});

// ── The ledger: what this extension will and will not fetch ──────────────────
//
// The message bus is not authenticated. `event.source === window` means "somebody
// in this page", which includes the Temporal UI, any dependency of it, and any
// other installed extension's content script — and MESSAGE_SOURCE and every field
// of the request are published in this repository. So the request cannot be the
// authority for what gets fetched with the page's bearer.
//
// The authority is the list RESPONSE: a run the page itself was handed. Every test
// here is written from the attacker's side — a well-formed message asking about
// something the page never listed — and the assertion that matters in each is that
// NO request reached the network. Being refused after the bearer has already been
// spent is not being refused.
//
// There is one gate, not one per feature, and this is where it is pinned: a new
// feature cannot forget the check, because fetchForListedRun() is the only route to
// the page's Authorization header.
describe('answering only for runs the page itself listed', () => {
    const OTHER_NAMESPACE = 'other-namespace';
    const OTHER_PREFIX = 'https://other-tenant.example.com';
    const OTHER_LIST_URL = `${OTHER_PREFIX}/api/v1/namespaces/${OTHER_NAMESPACE}/workflows?query=`;
    const OTHER_BEARER = 'Bearer other-tenant-owns-this';
    const OTHER_WORKFLOW_ID = 'invoice-9';
    const OTHER_RUN_ID = '00000000-0000-4000-8000-000000000002';

    // One question, so a refusal is one absent request rather than two. The ledger
    // does not know which field was asked for, so asking for one field tests it
    // exactly as well as asking for both.
    const ONE_QUESTION: Partial<RowInfoRequest> = { want: ['lastEvent'] };

    beforeEach(async () => {
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
    });

    it('refuses a run id the page was never handed, without spending the bearer', async () => {
        // The forged-message case in full: correct source, correct type, correct
        // namespace, a real workflow id, and a run id of the attacker's choosing.
        // isRowInfoRequest accepts it — it is well-formed — and this is where it
        // stops instead.
        const result = await askOneRow({
            ...ONE_QUESTION,
            runs: [{ workflowId: WORKFLOW_ID, runId: '00000000-0000-4000-8000-00000000dead' }],
        });

        expect(result.error).toMatch(/not in a workflow list this page has loaded/);
        expect(result.lastEvent).toBeNull();
        expect(reachedNetwork.filter((seen) => seen.url !== LIST_URL)).toHaveLength(0);
    });

    it('refuses a workflow id the page was never handed', async () => {
        const result = await askOneRow({
            ...ONE_QUESTION,
            runs: [{ workflowId: 'someone-elses-order', runId: RUN_ID }],
        });

        expect(result.error).toMatch(/not in a workflow list this page has loaded/);
        expect(reverseCalls()).toHaveLength(0);
    });

    it('refuses a namespace the page never asked about', async () => {
        // The worst of the three, because a user's token is frequently good for
        // namespaces they have not opened: this is the one that would read a
        // production workflow out of a tab showing a test one.
        const result = await askOneRow({ ...ONE_QUESTION, namespace: 'production' });

        expect(result.error).toMatch(/reload the workflow list/);
        expect(reverseCalls()).toHaveLength(0);
    });

    it('refuses nothing the page did list, however it was asked', async () => {
        // The other half of the gate, and the reason it is safe to be strict: the
        // ordinary row still answers. Without this test a ledger that refused
        // EVERYTHING would pass the three above.
        const result = await askOneRow();

        expect(result.error).toBeNull();
        expect(reverseCalls()).toHaveLength(1);
        expect(describeCalls()).toHaveLength(1);
    });

    it('answers a question that lands while the list response is still being read', async () => {
        // The ledger is filled off the response body a moment after the response
        // arrives. A question inside that window must WAIT, not be refused: refusing
        // would present as the feature being intermittently broken, which is worse
        // than being broken. No settle() between the two lines is the whole test.
        rowInfoResults = [];
        reachedNetwork = [];
        const listing = window.fetch(LIST_URL, { headers: { authorization: BEARER } });
        const answered = askRows(ONE_QUESTION);
        await listing;
        const [result] = await answered;

        expect(result!.error).toBeNull();
        expect(result!.lastEvent).not.toBeNull();
    });

    it('waits for EVERY list parse in flight, not only the newest', async () => {
        // The ledger used to hold ONE promise for "the parse in flight", and a
        // second list response overwrote it. Two of them overlap routinely — the UI
        // polls its own list, the namespace picker fetches another — and they finish
        // in whatever order their bodies happen to parse in. A question about a row
        // from the FIRST response then awaited only the SECOND's parse, found the
        // ledger without that row, and REFUSED it: a false refusal, in the one code
        // path whose whole job is deciding what may be fetched with the page's
        // bearer. It would present as the column being intermittently empty.
        //
        // Made deterministic by holding the first response's body parse open, so the
        // two finish in the opposite order to their arrival. A namespace of its own,
        // because this describe's beforeEach has already listed the default one and
        // an already-filled ledger would answer regardless.
        const THIRD_WORKFLOW_ID = 'shipment-3';
        const THIRD_RUN_ID = '00000000-0000-4000-8000-000000000003';
        holdBodyWhen = (url) => url.includes('nextPageToken=page-1');

        // Arrives first, carries the row we will ask about, and its parse hangs.
        listBody = { executions: [{ execution: { workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID } }] };
        await window.fetch(`${OTHER_LIST_URL}&nextPageToken=page-1`, { headers: { authorization: OTHER_BEARER } });
        // Arrives second and parses at once, so it is the one a single-promise
        // ledger is left waiting on — and it does not carry our row.
        listBody = { executions: [{ execution: { workflowId: THIRD_WORKFLOW_ID, runId: THIRD_RUN_ID } }] };
        await window.fetch(`${OTHER_LIST_URL}&nextPageToken=page-2`, { headers: { authorization: OTHER_BEARER } });

        const answered = askRows({
            ...ONE_QUESTION,
            namespace: OTHER_NAMESPACE,
            runs: [{ workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID }],
        });
        // One hop, so the question reaches the gate and has its chance to be refused
        // BEFORE the held parse is let go. Releasing in the same turn as the
        // dispatch would let the broken version pass.
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseHeld();
        const [result] = await answered;

        expect(result!.error).toBeNull();
        expect(result!.lastEvent).not.toBeNull();
    });

    it('keeps one namespace’s list from standing in for another’s', async () => {
        // Finding 2. A Temporal UI page fetches lists for more than one namespace —
        // the namespace picker does — and a single global record was overwritten by
        // whichever answered last. Both consequences are asserted: the wrong API
        // prefix and bearer on the request, and a ledger belonging to a namespace
        // the user is not looking at.
        listBody = { executions: [{ execution: { workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID } }] };
        await window.fetch(OTHER_LIST_URL, { headers: { authorization: OTHER_BEARER } });
        listBody = LIST_BODY;

        // The row on screen still answers, with ITS tenant host and ITS bearer.
        const onScreen = await askOneRow(ONE_QUESTION);
        expect(onScreen.error).toBeNull();
        expect(reverseCalls()).toHaveLength(1);
        expect(reverseCalls()[0]!.url.startsWith(API_PREFIX)).toBe(true);
        expect(reverseCalls()[0]!.authorization).toBe(BEARER);

        // And the other namespace's own row answers with the other tenant's.
        const other = await askOneRow({
            ...ONE_QUESTION,
            namespace: OTHER_NAMESPACE,
            runs: [{ workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID }],
        });
        expect(other.error).toBeNull();
        expect(reverseCalls()).toHaveLength(2);
        expect(reverseCalls()[1]!.url.startsWith(OTHER_PREFIX)).toBe(true);
        expect(reverseCalls()[1]!.authorization).toBe(OTHER_BEARER);

        // Neither ledger vouches for the other's run.
        const crossed = await askOneRow({ ...ONE_QUESTION, namespace: OTHER_NAMESPACE });
        expect(crossed.error).toMatch(/not in a workflow list this page has loaded/);
        expect(reverseCalls()).toHaveLength(2);
    });

    it('remembers an earlier page of the list as well as the latest one', async () => {
        // Paging forward must not un-authorise the rows behind you: the user can
        // still page back, and the tree draws ancestors from every page it has seen.
        listBody = { executions: [{ execution: { workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID } }] };
        await window.fetch(`${LIST_URL}&nextPageToken=page-2`, { headers: { authorization: BEARER } });

        expect((await askOneRow(ONE_QUESTION)).error).toBeNull();
        expect(
            (await askOneRow({ ...ONE_QUESTION, runs: [{ workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID }] }))
                .error,
        ).toBeNull();
    });
});

// ── The requests this extension makes on its own ──────────────────────────────
//
// Everything else is a piggyback: it reads a response the page was fetching
// anyway. The row-info feature is the one that asks Temporal questions of its own,
// per row, so it is the one whose COST and whose ANSWER both have to be pinned
// from the outside.
describe('asking Temporal about rows the page is showing', () => {
    const SECOND_WORKFLOW_ID = 'order-2';
    const SECOND_RUN_ID = '00000000-0000-4000-8000-000000000009';

    beforeEach(async () => {
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
    });

    it('reads the newest event from history-reverse and the retry from describe', async () => {
        const result = await askOneRow();

        expect(result.error).toBeNull();
        // Two routes, one per question, because neither answers the other's.
        expect(reverseCalls()).toHaveLength(1);
        expect(describeCalls()).toHaveLength(1);
        // One event, not a page of them: this is what makes the column affordable.
        expect(reverseCalls()[0]!.url).toContain('maximumPageSize=1');
        // Both carry the page's own bearer, and neither could have been built
        // without having watched the page.
        expect(reverseCalls()[0]!.authorization).toBe(BEARER);
        expect(describeCalls()[0]!.authorization).toBe(BEARER);
        // The describe route must name the run. Without it the server answers about
        // the LATEST run of that workflow id, which on a retried workflow is a
        // different execution — and the answer looks perfectly valid.
        expect(describeCalls()[0]!.url).toContain(`execution.runId=${RUN_ID}`);

        expect(result.lastEvent).toEqual({
            eventId: '42',
            eventType: 'ActivityTaskStarted',
            timeMs: Date.parse('2026-01-01T11:59:00Z'),
        });
        expect(result.retry).toMatchObject({ activityType: 'ChargeCard', attempt: 1518, maximumAttempts: null });
    });

    it('never carries the failure message, or the activity id, out of the page', async () => {
        // THE ONE ASSERTION IN THIS FILE ABOUT WHAT WE DECLINE TO READ.
        //
        // `lastFailure.message` sits in the same object as `attempt`, and reading it
        // would cost nothing and improve the tooltip. It is application data —
        // account numbers, customer ids, upstream response bodies — and this project
        // reads none of it. `activityId` goes the same way: unlike the activity TYPE
        // it is chosen by the caller, and is regularly built out of a business
        // identifier, as the fixture above is.
        const result = await askOneRow();

        const posted = JSON.stringify(result);
        expect(posted).not.toContain('overdrawn');
        expect(posted).not.toContain('4711');
        expect(posted).not.toContain('charge.ts');
        // …while the fields that do get read are all there, so this is a boundary
        // rather than a broken parse.
        expect(posted).toContain('ChargeCard');
        expect(posted).toContain('1518');
    });

    it('answers a fast row while an EARLIER slow row is still in the air', async () => {
        // ONE MESSAGE PER RUN, not one per batch — and the difference only shows
        // when one row is genuinely slower than the other.
        //
        // Two things about this test were got wrong before, and both made it pass
        // for the wrong reason:
        //   • it let both fake responses resolve immediately, so "two answers
        //     arrived" was also true of an implementation that awaited every row
        //     before replying. The fake network now HOLDS the slow row open.
        //   • it held the row asked about LAST, which a strictly sequential
        //     implementation answers in the right order anyway. The held row must
        //     be the FIRST one asked about; then only an implementation that does
        //     not queue behind it can answer the second.
        listBody = {
            executions: [
                { execution: { workflowId: WORKFLOW_ID, runId: RUN_ID } },
                { execution: { workflowId: SECOND_WORKFLOW_ID, runId: SECOND_RUN_ID } },
            ],
        };
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        // Both of the FIRST row's requests hang; the second row's are answered at
        // once. Set after the list call, which must not be held.
        holdWhen = (url) => url.includes(WORKFLOW_ID);

        const before = rowInfoResults.length;
        window.dispatchEvent(
            new MessageEvent('message', {
                data: rowInfoRequest({
                    runs: [
                        { workflowId: WORKFLOW_ID, runId: RUN_ID },
                        { workflowId: SECOND_WORKFLOW_ID, runId: SECOND_RUN_ID },
                    ],
                }),
                source: window,
            }),
        );
        await settle();

        // The slow row's requests really are outstanding — asserted, so that the
        // assertion below is about ordering and not about a row nobody asked for.
        expect(held).toHaveLength(2);
        const early = rowInfoResults.slice(before);
        expect(early).toHaveLength(1);
        expect(early[0]!.workflowId).toBe(SECOND_WORKFLOW_ID);
        expect(early[0]!.lastEvent).not.toBeNull();

        releaseHeld();
        await settle();

        const answers = rowInfoResults.slice(before);
        expect(answers).toHaveLength(2);
        expect(answers[1]!.workflowId).toBe(WORKFLOW_ID);
        expect(answers[1]!.lastEvent).not.toBeNull();
        // Answers are matched by (workflowId, runId) rather than by a request id,
        // so every message has to name the run it is about.
        expect(answers.every((answer) => answer.runId.length > 0)).toBe(true);
    });

    it('asks the network once and answers a repeat from the cache', async () => {
        // A render pass happens on every DOM mutation. Without the TTL cache each
        // one would be a fresh round of requests, which is how a helpful column
        // becomes a load generator.
        const first = await askOneRow();
        const again = await askOneRow();

        expect(again.lastEvent).not.toBeNull();
        expect(reverseCalls()).toHaveLength(1);
        expect(describeCalls()).toHaveLength(1);
        // AND THE SECOND ANSWER IS DATED WHEN THE FIRST ONE WAS READ. This is the
        // field the column measures its age against, so taking it from the clock at
        // reply time — the obvious implementation — would date data up to the full TTL
        // old to "just now", and the cell would show an age that much too short. A
        // fresh message does not make the fact in it fresh.
        expect(again.observedAtMs).toBe(first.observedAtMs);
    });

    it('asks only for the field it was asked for', async () => {
        // One request per running row PER FEATURE, so turning one off in the popup
        // has to actually stop its request rather than only hide its output.
        await askRows({ want: ['lastEvent'] });

        expect(reverseCalls()).toHaveLength(1);
        expect(describeCalls()).toHaveLength(0);
    });

    it('reports no retry for an activity on its first attempt', async () => {
        // attempt 1 is an activity that is simply running. Badging it would put a
        // retry marker on every healthy workflow, which is the same as having no
        // badge at all.
        describeBody = { pendingActivities: [{ activityType: { name: 'ChargeCard' }, attempt: 1 }] };

        const result = await askOneRow();

        expect(result.retry).toBeNull();
        expect(result.error).toBeNull();
    });

    it('ignores a malformed request instead of fetching for it', async () => {
        const before = reachedNetwork.length;
        window.dispatchEvent(
            new MessageEvent('message', {
                data: { source: MESSAGE_SOURCE, type: 'row-info-request', namespace: NAMESPACE, want: [], runs: [] },
                source: window,
            }),
        );
        await settle();

        expect(rowInfoResults).toHaveLength(0);
        expect(reachedNetwork).toHaveLength(before);
    });
});

// ── The four things that keep this from being a load generator ────────────────
//
// rowInfoServe.ts opens by naming four of them, and until this block existed only
// one was asserted from outside: a cache HIT, by the "asks the network once and
// answers a repeat from the cache" test above. TTL EXPIRY, IN-FLIGHT COALESCING,
// FAILURE CACHING, the CONCURRENCY CAP and the 429 BACKOFF WIRING were claims in a
// comment. Each of them is a claim about how much traffic this extension makes with
// the page's own credentials, which is the one cost a reader of this repository
// cannot measure for themselves, so each gets a test that COUNTS REQUESTS.
//
// These drive the two modules together, through the message bus and the fake
// network. The pacer's own invariants — a slot held across a backoff, the longest
// overlapping Retry-After winning, a success during a block not resetting the
// doubling — are pinned with a fake clock and no network in tests/unit/pacer.spec.ts.
describe('the four things that keep the per-row questions affordable', () => {
    // Mirrors TTL_MS and the pacer's maxConcurrent in src/rowInfoServe.ts, neither
    // of which is exported: a static import of that module here would run
    // pageApi.ts — and install its window.fetch property — before beforeEach could
    // put the fake network in place. Duplicating the two numbers is self-detecting
    // rather than a drift risk: change either in the source and the boundary
    // assertions below go red, which is what they are for.
    const TTL_MS = 30_000;
    const MAX_CONCURRENT = 4;
    // More rows than the cap, so something has to queue. With MAX_CONCURRENT or
    // fewer, "four at a time" is also true of an implementation with no cap at all.
    const BUSY_ROWS = MAX_CONCURRENT * 3;

    const SECOND_WORKFLOW_ID = 'order-2';
    const SECOND_RUN = { workflowId: SECOND_WORKFLOW_ID, runId: '00000000-0000-4000-8000-000000000009' };
    const FIRST_RUN = { workflowId: WORKFLOW_ID, runId: RUN_ID };

    type Runs = RowInfoRequest['runs'];

    // What the page was handed, which is what the ledger will authorise.
    const listing = (runs: Runs): unknown => ({ executions: runs.map((run) => ({ execution: run })) });

    const manyRuns = (count: number): Runs =>
        Array.from({ length: count }, (_, index) => ({
            workflowId: `order-${index}`,
            runId: `00000000-0000-4000-8000-0000000002${String(index).padStart(2, '0')}`,
        }));

    // Dispatched without settling, because three of these tests are about what has
    // NOT happened yet.
    const ask = (overrides: Partial<RowInfoRequest>): void => {
        window.dispatchEvent(new MessageEvent('message', { data: rowInfoRequest(overrides), source: window }));
    };

    const newest = (): RowInfoResult => {
        const last = rowInfoResults.at(-1);
        expect(last).toBeDefined();
        return last!;
    };

    beforeEach(async () => {
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
    });

    it('asks again once an answer has gone stale, and not a moment before', async () => {
        // 1. THE TTL CACHE — its expiry, which is the half that decides the
        // traffic. A TTL that never expires is a column that silently stops
        // updating; one that expires immediately is a request per DOM mutation, and
        // the Temporal UI produces dozens of those a second while it re-renders.
        const start = Date.now();
        const clock = vi.spyOn(Date, 'now');
        try {
            clock.mockReturnValue(start);
            await askRows({ want: ['lastEvent'] });
            expect(reverseCalls()).toHaveLength(1);

            // One millisecond inside the window: answered, without a request.
            clock.mockReturnValue(start + TTL_MS - 1);
            expect((await askOneRow({ want: ['lastEvent'] })).lastEvent).not.toBeNull();
            expect(reverseCalls()).toHaveLength(1);

            // And one millisecond outside it. Both sides are asserted because
            // either one alone passes for an implementation with no cache and for
            // one that never expires.
            clock.mockReturnValue(start + TTL_MS);
            expect((await askOneRow({ want: ['lastEvent'] })).lastEvent).not.toBeNull();
            expect(reverseCalls()).toHaveLength(2);
        } finally {
            clock.mockRestore();
        }
    });

    it('turns many render passes during one slow request into one request', async () => {
        // 2. IN-FLIGHT COALESCING, which the cache above cannot do: nothing has
        // been answered yet, so there is nothing to hit. A request that takes a
        // second outlives dozens of render passes, and each of them asks again.
        holdWhen = (url) => url.includes('/history-reverse');
        const before = rowInfoResults.length;
        for (let pass = 0; pass < BUSY_ROWS; pass++) ask({ want: ['lastEvent'] });
        await settle();

        expect(reverseCalls()).toHaveLength(1);
        expect(rowInfoResults.slice(before)).toHaveLength(0);

        holdWhen = null;
        releaseHeld();
        await settle();

        // Every pass is then answered off that one response. Asserting the ANSWERS
        // as well as the request is what separates coalescing from the later
        // questions being dropped on the floor — which would leave the column empty
        // and pass a request count on its own.
        const answers = rowInfoResults.slice(before);
        expect(answers).toHaveLength(BUSY_ROWS);
        expect(answers.every((answer) => answer.lastEvent !== null)).toBe(true);
        expect(reverseCalls()).toHaveLength(1);
    });

    it('caches a refusal too, without pausing the rows that were not refused', async () => {
        // 3a. A FAILURE IS CACHED, on the same TTL. Otherwise every render pass
        // retries a request that has just failed, which is the fastest way to turn
        // one 403 into a thousand.
        listBody = listing([FIRST_RUN, SECOND_RUN]);
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
        failWhen = (url) => (url.includes(WORKFLOW_ID) ? { status: 403 } : null);

        const first = await askOneRow({ want: ['lastEvent'] });
        const again = await askOneRow({ want: ['lastEvent'] });

        expect(first.error).toMatch(/HTTP 403/);
        expect(first.lastEvent).toBeNull();
        expect(again.error).toBe(first.error);
        expect(reverseCalls()).toHaveLength(1);

        // 3b. And a 403 is a permanent answer for THAT run, not a signal to slow
        // down — only 429 and 503 mean "later". A row the server never refused
        // still asks at once and still answers.
        const other = await askOneRow({ want: ['lastEvent'], runs: [SECOND_RUN] });
        expect(other.error).toBeNull();
        expect(other.lastEvent).not.toBeNull();
        expect(reverseCalls()).toHaveLength(2);
    });

    it('keeps a capped number of requests in the air, not one per row', async () => {
        // 4. THE CONCURRENCY CAP. A hundred running rows is two hundred requests,
        // and fired at once they arrive looking, from the server's side, exactly
        // like an attack. This is the assertion that a burst is a queue.
        const runs = manyRuns(BUSY_ROWS);
        listBody = listing(runs);
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        // Set after the list call, which must not be held.
        holdWhen = (url) => url.includes('/history-reverse');
        const before = rowInfoResults.length;
        ask({ want: ['lastEvent'], runs });
        await settle();

        expect(reverseCalls()).toHaveLength(MAX_CONCURRENT);
        expect(rowInfoResults.slice(before)).toHaveLength(0);

        holdWhen = null;
        releaseHeld();
        await settle();

        // The queue drains rather than being dropped: a cap that lost the rest
        // would satisfy the assertion above and leave most of the column empty.
        expect(reverseCalls()).toHaveLength(BUSY_ROWS);
        expect(rowInfoResults.slice(before)).toHaveLength(BUSY_ROWS);
    });

    it('stops asking for as long as a 429 asked for, then resumes', async () => {
        // 4b. BACKOFF, and specifically its WIRING: the Retry-After header has to
        // reach the pacer, and the pause it produces has to apply to rows that had
        // nothing to do with the refused one.
        //
        // Fake timers rather than settle(), because that pause is a real sleep. Left
        // to run for real it fires during a LATER test, where its fetch lands in
        // that test's request log — the cross-test contamination the note above
        // loadMainWorldScripts() is about, arriving from the other direction.
        const ADVISED_MS = 5_000;
        listBody = listing([FIRST_RUN, SECOND_RUN]);
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Date is faked WITH the timers on purpose: the pacer re-checks the clock
        // after each sleep, so a clock that did not move would sleep again forever.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
        try {
            failWhen = () => ({ status: 429, retryAfter: String(ADVISED_MS / 1000) });
            ask({ want: ['lastEvent'] });
            await vi.advanceTimersByTimeAsync(0);

            expect(reverseCalls()).toHaveLength(1);
            // Not "HTTP 429": the tooltip has to say this is temporary, because the
            // user's next move otherwise is to reload the page and ask again.
            expect(newest().error).toMatch(/rate-limiting/);
            // The header, not the built-in doubling. The log line is the only place
            // the wait it settled on is visible, which is why it is asserted.
            expect(
                warn.mock.calls.some((call) => String(call[1]).includes(`pausing row info for ${ADVISED_MS / 1000}s`)),
            ).toBe(true);

            // A different row, which the server never refused — and which is
            // nevertheless not asked about while the pause lasts.
            failWhen = null;
            ask({ want: ['lastEvent'], runs: [SECOND_RUN] });
            await vi.advanceTimersByTimeAsync(ADVISED_MS - 1);
            expect(reverseCalls()).toHaveLength(1);

            // …and asked about when the pause expires, rather than never. A backoff
            // that never lifts is indistinguishable from the feature being broken.
            await vi.advanceTimersByTimeAsync(2);
            expect(reverseCalls()).toHaveLength(2);
            expect(newest().error).toBeNull();
        } finally {
            vi.useRealTimers();
            warn.mockRestore();
        }
    });
});

// ── The bug that shipped ─────────────────────────────────────────────────────
//
// The Temporal UI (SvelteKit) assigns window.fetch after document_start, and so
// does any tracing or retry layer on the page. inject.ts adopts such an
// assignment — into ONE slot. When pageApi.ts had installed itself by
// plain assignment, it was living in that slot, and the app's assignment
// overwrote it.
//
// Nothing announced that. inject.ts stays outermost through its own getter, so
// rows kept arriving and the tree kept drawing; only the second observer went
// deaf. Hence a spec per shape of later wrapper.
describe('surviving a wrapper the page installs afterwards', () => {
    // The ordinary shape: read what is there, call it from the replacement.
    const appWrapper = () => {
        const inherited = window.fetch;
        const wrapper = (input: RequestInfo | URL, init?: RequestInit) => inherited(input as RequestInfo, init);
        window.fetch = wrapper as typeof fetch;
    };

    it('still observes the list after the page replaces window.fetch', async () => {
        appWrapper();

        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
        const result = await askOneRow({ want: ['lastEvent'] });

        expect(result.error).toBeNull();
        expect(result.lastEvent).not.toBeNull();
        expect(reverseCalls()[0]!.authorization).toBe(BEARER);
    });

    it('keeps the page-installed wrapper in the chain, rather than dropping it', async () => {
        const calls: string[] = [];
        const inherited = window.fetch;
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            calls.push(String(input));
            return inherited(input as RequestInfo, init);
        }) as typeof fetch;

        await window.fetch(LIST_URL);

        // Adopting an assignment and then never calling it would break the app's
        // own retry or tracing layer with no symptom other than its silence.
        expect(calls).toEqual([LIST_URL]);
        // Drain this test's own queued postMessage. Without it the rows land
        // during the NEXT test's settle() and are counted there.
        await settle();
    });

    it('still draws the tree after the page replaces window.fetch', async () => {
        const rows: unknown[] = [];
        window.addEventListener('message', (event: MessageEvent) => {
            const data = event.data as { source?: string; type?: string } | undefined;
            if (data?.source === MESSAGE_SOURCE && data.type === 'workflows') rows.push(data);
        });
        appWrapper();

        await window.fetch(LIST_URL);
        await settle();

        expect(rows).toHaveLength(1);
    });

    it('survives two later wrappers, installed one after the other', async () => {
        appWrapper();
        appWrapper();

        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        expect((await askOneRow({ want: ['lastEvent'] })).error).toBeNull();
    });
});
