// @vitest-environment jsdom
//
// The trust boundary of the second MAIN-world bundle (apiInject.ts): what it has to
// learn from the page, what it will fetch with what it learned, and how it stays
// attached to the page long enough to do either.
//
// The failure this file exists for was found on a live Temporal Cloud tenant and is
// invisible offline without it: the tree drew perfectly while every per-row question
// answered “Nothing observed on this page yet”, forever. Two observers of the same
// global, and only one of them still hooked up — no error, no warning, and each half
// looked fine on its own.
//
// Both scripts are IIFEs with no exports: importing them IS running them, in the
// order the manifest lists them. The fake network they run against, and the helper
// that imports them, are in tests/apiInjectHarness.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RowInfoRequest } from '../../src/rowInfo/rowInfo';
import { MESSAGE_SOURCE } from '../../src/types';
import {
    API_PREFIX,
    BEARER,
    LIST_BODY,
    LIST_URL,
    NAMESPACE,
    RUN_ID,
    WORKFLOW_ID,
    askOneRow,
    askPayload,
    askRows,
    describeCalls,
    fake,
    forwardCalls,
    held,
    installApiInjectHarness,
    reachedNetwork,
    releaseHeld,
    reverseCalls,
    rowInfoResults,
    settle,
    teardownApiInjectHarness,
} from '../apiInjectHarness';

beforeEach(installApiInjectHarness);
afterEach(teardownApiInjectHarness);

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

    it('refuses a payload hover for a run the page was never handed', async () => {
        // The claim above this block — one gate, not one per feature — asserted for
        // the SECOND feature that reaches the network. The payload path is the more
        // consequential one to get wrong: a per-row question leaks an event type,
        // while this one would put another customer's decoded input on screen.
        const result = await askPayload({ runId: '00000000-0000-4000-8000-00000000dead' });

        expect(result.error).toMatch(/not in a workflow list this page has loaded/);
        expect(result.text).toBe('');
        expect(forwardCalls()).toHaveLength(0);
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
        rowInfoResults.length = 0;
        reachedNetwork.length = 0;
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
        fake.holdBodyWhen = (url) => url.includes('nextPageToken=page-1');

        // Arrives first, carries the row we will ask about, and its parse hangs.
        fake.listBody = { executions: [{ execution: { workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID } }] };
        await window.fetch(`${OTHER_LIST_URL}&nextPageToken=page-1`, { headers: { authorization: OTHER_BEARER } });
        // Arrives second and parses at once, so it is the one a single-promise
        // ledger is left waiting on — and it does not carry our row.
        fake.listBody = { executions: [{ execution: { workflowId: THIRD_WORKFLOW_ID, runId: THIRD_RUN_ID } }] };
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
        fake.listBody = { executions: [{ execution: { workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID } }] };
        await window.fetch(OTHER_LIST_URL, { headers: { authorization: OTHER_BEARER } });
        fake.listBody = LIST_BODY;

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
        fake.listBody = { executions: [{ execution: { workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID } }] };
        await window.fetch(`${LIST_URL}&nextPageToken=page-2`, { headers: { authorization: BEARER } });

        expect((await askOneRow(ONE_QUESTION)).error).toBeNull();
        expect(
            (await askOneRow({ ...ONE_QUESTION, runs: [{ workflowId: OTHER_WORKFLOW_ID, runId: OTHER_RUN_ID }] }))
                .error,
        ).toBeNull();
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
