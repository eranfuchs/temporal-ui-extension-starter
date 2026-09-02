// @vitest-environment jsdom
//
// The only requests this extension makes on its own: one question per running row,
// and everything that keeps those questions from adding up to a load generator.
//
// Everything else the extension reads is a piggyback on a response the page was
// fetching anyway. This is the feature that spends the page’s bearer on traffic the
// page did not ask for, so both its ANSWER and its COST are pinned from the outside,
// by counting requests. What may be asked about at all is a separate question, and it
// is pinned in tests/unit/apiInject.spec.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type RowInfoRequest, type RowInfoResult } from '../../src/rowInfo/rowInfo';
import { MESSAGE_SOURCE } from '../../src/types';
import {
    BEARER,
    LIST_URL,
    NAMESPACE,
    RUN_ID,
    WORKFLOW_ID,
    askOneRow,
    askRows,
    describeCalls,
    fake,
    held,
    installApiInjectHarness,
    reachedNetwork,
    releaseHeld,
    reverseCalls,
    rowInfoRequest,
    rowInfoResults,
    settle,
    teardownApiInjectHarness,
} from '../apiInjectHarness';

beforeEach(installApiInjectHarness);
afterEach(teardownApiInjectHarness);

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
        fake.listBody = {
            executions: [
                { execution: { workflowId: WORKFLOW_ID, runId: RUN_ID } },
                { execution: { workflowId: SECOND_WORKFLOW_ID, runId: SECOND_RUN_ID } },
            ],
        };
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        // Both of the FIRST row's requests hang; the second row's are answered at
        // once. Set after the list call, which must not be held.
        fake.holdWhen = (url) => url.includes(WORKFLOW_ID);

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
        fake.describeBody = { pendingActivities: [{ activityType: { name: 'ChargeCard' }, attempt: 1 }] };

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
    // Mirrors TTL_MS and the pacer's maxConcurrent in src/rowInfo/rowInfoServe.ts, neither
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
        fake.holdWhen = (url) => url.includes('/history-reverse');
        const before = rowInfoResults.length;
        for (let pass = 0; pass < BUSY_ROWS; pass++) ask({ want: ['lastEvent'] });
        await settle();

        expect(reverseCalls()).toHaveLength(1);
        expect(rowInfoResults.slice(before)).toHaveLength(0);

        fake.holdWhen = null;
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
        fake.listBody = listing([FIRST_RUN, SECOND_RUN]);
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
        fake.failWhen = (url) => (url.includes(WORKFLOW_ID) ? { status: 403 } : null);

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
        fake.listBody = listing(runs);
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        // Set after the list call, which must not be held.
        fake.holdWhen = (url) => url.includes('/history-reverse');
        const before = rowInfoResults.length;
        ask({ want: ['lastEvent'], runs });
        await settle();

        expect(reverseCalls()).toHaveLength(MAX_CONCURRENT);
        expect(rowInfoResults.slice(before)).toHaveLength(0);

        fake.holdWhen = null;
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
        fake.listBody = listing([FIRST_RUN, SECOND_RUN]);
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // Date is faked WITH the timers on purpose: the pacer re-checks the clock
        // after each sleep, so a clock that did not move would sleep again forever.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.now() });
        try {
            fake.failWhen = () => ({ status: 429, retryAfter: String(ADVISED_MS / 1000) });
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
            fake.failWhen = null;
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
