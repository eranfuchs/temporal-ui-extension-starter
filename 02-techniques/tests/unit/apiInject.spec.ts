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

function fakeResponse(body: unknown): Response {
    const text = JSON.stringify(body);
    return {
        ok: true,
        status: 200,
        clone: () => ({ text: async () => text }),
        json: async () => JSON.parse(text),
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

// The stand-in at the bottom of every chain: answers each of the two per-row
// routes with its own body, and anything else with a workflow list.
function bottomFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
    const headers = new Headers(init?.headers ?? {});
    reachedNetwork.push({ url, authorization: headers.get('authorization') });
    if (url.includes('/history-reverse')) return Promise.resolve(fakeResponse(reverseHistoryBody));
    // A describe URL names a workflow AND carries a query; the list URL carries a
    // query but names no workflow.
    if (/\/workflows\/[^/?]+\?/.test(url)) return Promise.resolve(fakeResponse(describeBody));
    return Promise.resolve(fakeResponse(listBody));
}

function rowInfoRequest(overrides: Partial<RowInfoRequest> = {}): RowInfoRequest {
    return {
        source: MESSAGE_SOURCE,
        type: 'row-info-request',
        namespace: NAMESPACE,
        want: ['lastEvent', 'retry'],
        runs: [{ workflowId: WORKFLOW_ID, runId: RUN_ID }],
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
    // writable + configurable, because the previous test left a getter here.
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: bottomFetch });
    await loadMainWorldScripts();
    window.addEventListener('message', capture);
});

afterEach(() => {
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

    it('answers each run separately, so a slow row does not hold up a fast one', async () => {
        listBody = {
            executions: [
                { execution: { workflowId: WORKFLOW_ID, runId: RUN_ID } },
                { execution: { workflowId: SECOND_WORKFLOW_ID, runId: SECOND_RUN_ID } },
            ],
        };
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        const answers = await askRows({
            runs: [
                { workflowId: WORKFLOW_ID, runId: RUN_ID },
                { workflowId: SECOND_WORKFLOW_ID, runId: SECOND_RUN_ID },
            ],
        });

        expect(answers).toHaveLength(2);
        expect(answers.map((answer) => answer.workflowId).sort()).toEqual([WORKFLOW_ID, SECOND_WORKFLOW_ID].sort());
        // Answers are matched by (workflowId, runId) rather than by a request id,
        // so every message has to name the run it is about.
        expect(answers.every((answer) => answer.runId.length > 0)).toBe(true);
    });

    it('asks the network once and answers a repeat from the cache', async () => {
        // A render pass happens on every DOM mutation. Without the TTL cache each
        // one would be a fresh round of requests, which is how a helpful column
        // becomes a load generator.
        await askRows();
        const again = await askOneRow();

        expect(again.lastEvent).not.toBeNull();
        expect(reverseCalls()).toHaveLength(1);
        expect(describeCalls()).toHaveLength(1);
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
