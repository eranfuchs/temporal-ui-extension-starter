// @vitest-environment jsdom
//
// The MAIN-world script is the one part of this extension that touches a global
// the whole page shares. Everything asserted here is a property that fails
// SILENTLY in a browser — no error, no log, just no rows, or rows from the wrong
// answer — so a spec is the only place any of it can be noticed going wrong.
//
// inject.ts is an IIFE with no exports: importing it IS running it. Each test
// therefore resets the module registry and imports it fresh, against a window
// whose fetch has been put back to a stand-in first.

import { parse, safeParse } from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    temporalApiWorkflowSchema,
    workflowsMessageSchema,
    type WorkflowsMessage,
} from '../../src/types';
import { fakeRunId } from '../helpers';

const LIST_URL = '/api/v1/namespaces/sample-namespace/workflows?query=';
// A real route the page really does fetch, and one we must stay quiet about.
const COUNT_URL = '/api/v1/namespaces/sample-namespace/workflow-count';

// A Response stand-in carrying only the three members inject.ts touches.
// Anything more would be asserting on fetch's behaviour rather than on ours.
function fakeResponse(body: unknown): Response {
    const text = JSON.stringify(body);
    return { ok: true, clone: () => ({ text: async () => text }) } as unknown as Response;
}

const listBody = (ids: string[]) => ({
    executions: ids.map((workflowId) => ({ execution: { workflowId, runId: fakeRunId() } })),
});

// URLs that reached the fetch nobody has wrapped, and the messages that were
// posted to the page. Both are the whole observable surface of this module.
let reachedNetwork: string[] = [];
let received: WorkflowsMessage[] = [];

// Captured through the SAME schema the real receiver uses, so these tests also
// prove the sender emits something the receiving side will accept. A cast here
// would have let the two sides drift apart with every spec still green.
const capture = (event: MessageEvent) => {
    const parsed = safeParse(workflowsMessageSchema, event.data);
    if (parsed.success) received.push(parsed.output);
};

// postMessage is delivered as a task and inject.ts reads the body in a microtask
// before sending, so nothing has arrived by the time the fetch resolves. Hop
// several macrotasks to drain both queues: one hop is not enough, and exactly
// which hop delivers is not something a spec should depend on.
async function settle(): Promise<void> {
    for (let hop = 0; hop < 10; hop++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

beforeEach(async () => {
    reachedNetwork = [];
    received = [];
    const stub = ((input: RequestInfo | URL) => {
        reachedNetwork.push(String(input));
        return Promise.resolve(fakeResponse(listBody(['sample-workflow'])));
    }) as typeof fetch;
    // writable + configurable, because the previous test left our own getter here.
    Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: stub });
    window.addEventListener('message', capture);
    vi.resetModules();
    await import('../../src/inject');
});

afterEach(() => {
    window.removeEventListener('message', capture);
});

describe('the fetch piggyback', () => {
    it('posts the rows it saw, stamped with the generation the request was issued at', async () => {
        await window.fetch(LIST_URL);
        await window.fetch(LIST_URL);
        await settle();

        expect(received.map((message) => message.generation)).toEqual([1, 2]);
        expect(received[0]!.type).toBe('workflows');
        expect(received[0]!.url).toBe(LIST_URL);
        expect(received[0]!.executions).toHaveLength(1);
    });

    it('stays silent about a request that is not a workflow list', async () => {
        await window.fetch(COUNT_URL);
        await window.fetch(LIST_URL);
        await settle();

        // Passed through untouched, and counted out of the generation sequence:
        // the numbers only have to order the answers we act on.
        expect(reachedNetwork).toEqual([COUNT_URL, LIST_URL]);
        expect(received.map((message) => message.url)).toEqual([LIST_URL]);
        expect(received[0]!.generation).toBe(1);
    });

    it('survives the page reassigning window.fetch', async () => {
        // SvelteKit does exactly this, after document_start. A plain
        // `window.fetch = wrapped` is evicted here and the extension goes quiet.
        const ours = window.fetch;
        window.fetch = (() =>
            Promise.resolve(fakeResponse(listBody(['replacement-fetch-answered'])))) as typeof fetch;
        expect(window.fetch).toBe(ours);

        await window.fetch(LIST_URL);
        await settle();

        // Still observed, and observed through the fetch the page installed —
        // the rows came from its answer, and the stub underneath was not called.
        expect(received).toHaveLength(1);
        const entry = parse(temporalApiWorkflowSchema, received[0]!.executions[0]);
        expect(entry.execution.workflowId).toBe('replacement-fetch-answered');
        expect(reachedNetwork).toEqual([]);
    });

    it('adopts a wrapper installed after it, and stays outermost', async () => {
        // The ordinary idiom, and a cycle: `next` IS our wrapper.
        const seenByThem: string[] = [];
        const next = window.fetch;
        window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            seenByThem.push(String(input));
            return next(input, init);
        }) as typeof fetch;

        const response = await window.fetch(LIST_URL);
        await settle();

        expect(response.ok).toBe(true);
        // Their wrapper works — the whole point of adopting instead of swallowing.
        expect(seenByThem).toEqual([LIST_URL]);
        // And exactly one request, observed exactly once. Generation 1, not 2:
        // the re-entry was recognised rather than counted as a second request.
        expect(reachedNetwork).toEqual([LIST_URL]);
        expect(received).toHaveLength(1);
        expect(received[0]!.generation).toBe(1);
    });

    it('terminates when an adopted wrapper calls back in after an await', async () => {
        // The shape the synchronous cycle guard cannot see: by the time this one
        // calls back, the call is indistinguishable from a fresh one. Unbounded
        // recursion here would hang the page; this test would time out.
        const next = window.fetch;
        let hops = 0;
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            hops++;
            await Promise.resolve();
            return next(input, init);
        }) as typeof fetch;

        const response = await window.fetch(LIST_URL);
        await settle();

        expect(response.ok).toBe(true);
        expect(hops).toBeGreaterThan(1); // it really did re-enter
        // AND STOPPED, at MAX_IN_FLIGHT_PER_URL. "It terminates" was the whole
        // assertion here for a while, and it was satisfied by terminating after
        // ~50 hops — fifty runs of somebody else's tracing or retry layer for one
        // call the page made once. Exact, so that raising the cap has to be a
        // deliberate edit to this line rather than a number nobody notices.
        expect(hops).toBe(3);
        expect(reachedNetwork).toEqual([LIST_URL]); // one request, not fifty
        expect(received).toHaveLength(1); // one message, not one per hop
    });

    it('terminates when an adopted wrapper rewrites the url on every hop', async () => {
        // Why the global MAX_IN_FLIGHT is still there. A cache-buster or a retry
        // with a changed query is a NEW url each time, so the per-url count sees
        // depth 1 forever and cannot stop this one.
        const next = window.fetch;
        let hops = 0;
        window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            hops++;
            await Promise.resolve();
            return next(`${LIST_URL}&hop=${hops}`, init);
        }) as typeof fetch;

        const response = await window.fetch(LIST_URL);
        await settle();

        expect(response.ok).toBe(true);
        expect(hops).toBeGreaterThan(3); // the per-url cap could not see it
        expect(hops).toBe(50); // and the global backstop is what stopped it
        // Still one request at the bottom and one message, however many hops it
        // took to get there: the response object is the same one on the way back.
        expect(reachedNetwork).toHaveLength(1);
        expect(received).toHaveLength(1);
    });

    it('ignores an assignment that is not a function', async () => {
        // Adopting a non-function would break every fetch on the page.
        (window as unknown as { fetch: unknown }).fetch = null;
        await window.fetch(LIST_URL);
        await settle();

        expect(reachedNetwork).toEqual([LIST_URL]);
        expect(received).toHaveLength(1);
    });
});
