// MAIN world: the only part of this extension that makes requests of its own
// VOLUME. It is where "we can call the API too" meets "and here is the bill".
//
// The split with rowInfoClient.ts is deliberate and is the interesting design
// decision in this feature:
//
//   • the ISOLATED world decides WHAT to ask about — it can see the table, so it
//     knows which rows are on screen and which of them are Running;
//   • this file decides WHEN to fire and remembers the answers — it is the only
//     place that knows how many requests are already in the air, and it is where
//     the page's credentials are, so it is where a 429 arrives.
//
// Neither half can do the other's job. A pacer in the ISOLATED world would be one
// pacer PER TAB with no idea what the page itself is already doing; a row selector
// in the MAIN world would have to be told the rows over postMessage and would
// then be pacing whatever a forged message asked for.
//
// FOUR THINGS KEEP THIS FROM BEING A LOAD GENERATOR, and every one of them is on
// this side of the boundary rather than in the caller:
//
//   1. A TTL CACHE, per (run, field). A render pass happens on every DOM mutation
//      — dozens per second while the Temporal UI re-renders — and without this,
//      each one would be a fresh round of requests. The refresh control in the
//      column header is the one thing that may bypass it, via `fresh` on the
//      request; FRESH_FLOOR_MS puts a floor under that, because the message can be
//      posted by anything in the page and not only by the button.
//   2. IN-FLIGHT COALESCING. Ten render passes during one slow request must
//      produce one request, not ten. The pending promise is the dedupe key.
//   3. A CONCURRENCY CAP, and
//   4. BACKOFF ON 429/503 honouring Retry-After — both in src/page/pacer.ts, which
//      exists as a separate module because it is about TIME and therefore needs an
//      injected clock to be testable at all. It was inline here, untested, and
//      wrong: read the note at the top of that file before copying either idea.
//      The single INSTANCE of it, shared with the payload fetch, is in
//      src/page/requestPacing.ts — in 02, where row info was the only requesting
//      feature, it was a const in this file.
//
// It also refreshes for free: the Temporal UI polls its own workflow list, every
// poll re-renders the table, every re-render asks again, and the TTL decides
// whether that becomes a request. Nothing here holds a timer of its own.
//
// EVERY ANSWER IS DATED, and that is not bookkeeping. `observedAtMs` on the reply is
// when the DATA was read — off the cached answer, so a cache hit reports the age of
// the fact and not the age of the message — and it is what the column measures its
// age against. Without it the renderer would subtract the event's timestamp from the
// current clock and print a number that climbs once a second, which is a live
// measurement of a run this file reads at most every 35 seconds.

import { fetchFailureMessage, fetchForListedRun, replyToPage } from '../page/pageApi';
import { pacer, refuse } from '../page/requestPacing';
import {
    FRESH_FLOOR_MS,
    readLastEvent,
    readPendingRetry,
    type LastEvent,
    type PendingRetry,
    type RowInfoField,
    type RowInfoRequest,
    type RowInfoResult,
} from './rowInfo';
import { describeWorkflowUrl, historyUrl, type RunRef } from '../page/temporalApi';
import { MESSAGE_SOURCE } from '../types';

// How long an answer is worth keeping. A last event that is 30 seconds stale is
// still the right shape of answer for "is this workflow moving?", and this is the
// single number that decides how much traffic the feature makes.
const TTL_MS = 30_000;

// INVARIANT: this cache is bounded by ENTRY COUNT and not only by the TTL above.
// Breaking it: an expired entry is overwritten when the same run is asked about
// again, and a run scrolled past is never asked about again — so a TTL alone leaves
// every run a long-lived tab has ever shown sitting in the map for the life of the
// page. The bound was missing here for exactly that reason: the two caches on the
// other side of the boundary have one, and the TTL made this one look like it did.
// See docs/design-notes.md#the-cache-a-ttl-made-look-bounded.
const MAX_CACHED_ANSWERS = 2_000;

// ── One cache per field ──────────────────────────────────────────────────────

interface Answer<T> {
    value: T | null;
    error: string | null;
    atMs: number;
}

interface FieldStore<T> {
    get(namespace: string, run: RunRef): Promise<Answer<T>>;
    forget(namespace: string, run: RunRef, nowMs: number): void;
    clear(): void;
}

// Namespace is part of the key: the same workflow id can exist in two of them, and
// these maps are not per-namespace. Length-prefixed so no pair of parts can be
// re-cut into a different pair that spells the same string.
function storeKey(namespace: string, run: RunRef): string {
    return `${namespace.length}:${namespace}:${run.workflowId.length}:${run.workflowId}:${run.runId}`;
}

function makeFieldStore<T>(load: (namespace: string, run: RunRef) => Promise<T | null>): FieldStore<T> {
    const answers = new Map<string, Answer<T>>();
    const inFlight = new Map<string, Promise<Answer<T>>>();

    return {
        async get(namespace: string, run: RunRef): Promise<Answer<T>> {
            const key = storeKey(namespace, run);
            const cached = answers.get(key);
            if (cached && Date.now() - cached.atMs < TTL_MS) return cached;

            const pending = inFlight.get(key);
            if (pending) return await pending;

            const promise = (async (): Promise<Answer<T>> => {
                let answer: Answer<T>;
                try {
                    answer = { value: await pacer.run(() => load(namespace, run)), error: null, atMs: Date.now() };
                } catch (err) {
                    // A failure is cached too, with the same TTL. Otherwise every
                    // render pass retries a request that just failed, which is the
                    // fastest way to turn one 403 into a thousand.
                    answer = { value: null, error: fetchFailureMessage(err), atMs: Date.now() };
                }
                // Whole-map eviction, cleared BEFORE the insert so the answer just
                // fetched survives its own pass. Crude and adequate for the same
                // reason it is in rowInfoClient.ts: every run still on screen is one
                // render pass away from being asked about again, so the cost of
                // throwing the lot away is one extra round for the current table.
                if (answers.size >= MAX_CACHED_ANSWERS) answers.clear();
                answers.set(key, answer);
                inFlight.delete(key);
                return answer;
            })();
            inFlight.set(key, promise);
            return await promise;
        },
        // Drop one cached answer so the next get() has to fetch it. This is the whole
        // of what `fresh` does, and THE FLOOR IS HERE rather than in the caller: the
        // caller is a postMessage away from anything running in the page, so a bound
        // it applied would be a bound only the honest asker keeps.
        //
        // An answer younger than the floor is left alone, which makes a repeated
        // `fresh` collapse into the cache exactly like a 'due' ask would. Nothing
        // touches `inFlight`: a request already on its way is as fresh as one started
        // now, and cancelling it to start another would spend two requests to answer
        // one question.
        forget(namespace: string, run: RunRef, nowMs: number): void {
            const key = storeKey(namespace, run);
            const cached = answers.get(key);
            if (cached && nowMs - cached.atMs < FRESH_FLOOR_MS) return;
            answers.delete(key);
        },
        clear(): void {
            answers.clear();
        },
    };
}

const lastEventStore = makeFieldStore<LastEvent>(async (namespace, run) => {
    // maximumPageSize=1 against the REVERSE route: one event, the newest one. The
    // whole feature is one small response per run, which is what makes it
    // affordable at all.
    const response = await fetchForListedRun(namespace, run, (target) =>
        historyUrl({ ...target, direction: 'reverse', maximumPageSize: 1 }),
    );
    if (!response.ok) refuse(response, 'reading the last event');
    pacer.noteSuccess();
    return readLastEvent(await response.json());
});

const retryStore = makeFieldStore<PendingRetry>(async (namespace, run) => {
    const response = await fetchForListedRun(namespace, run, describeWorkflowUrl);
    if (!response.ok) refuse(response, 'reading pending activities');
    pacer.noteSuccess();
    return readPendingRetry(await response.json());
});

export function clearRowInfoCache(): void {
    lastEventStore.clear();
    retryStore.clear();
}

// ── Answering ────────────────────────────────────────────────────────────────

// ONE MESSAGE BACK PER RUN, as soon as that run is done.
//
// Not one message for the batch: a hundred rows behind a concurrency cap of four
// take a few seconds to drain, and a batched answer would leave the whole column
// empty for all of them instead of filling in as it goes.
export function serveRowInfo(request: RowInfoRequest): void {
    for (const run of request.runs) {
        void answerOne(request.namespace, run, request.want, request.fresh);
    }
}

async function answerOne(namespace: string, run: RunRef, want: RowInfoField[], fresh: boolean): Promise<void> {
    const errors: string[] = [];
    let lastEvent: LastEvent | null = null;
    let retry: PendingRetry | null = null;
    // When each field was actually read — `atMs` off the cached answer, so a cache
    // hit reports the age of the DATA and not the age of this message. Collected per
    // field because the two can differ: one may be served from cache while the other
    // is fetched. The reply carries the oldest of them.
    const observedAt: number[] = [];

    // One clock reading for both fields, so a run cannot have its last event
    // re-fetched and its pending activities served from cache because the two calls
    // landed either side of the floor.
    const nowMs = Date.now();

    // Both questions in parallel — they are two independent GETs, and the pacer
    // above is what keeps "in parallel" from meaning "all at once".
    const asked: Promise<void>[] = [];
    if (want.includes('lastEvent')) {
        if (fresh) lastEventStore.forget(namespace, run, nowMs);
        asked.push(
            lastEventStore.get(namespace, run).then((answer) => {
                lastEvent = answer.value;
                observedAt.push(answer.atMs);
                if (answer.error) errors.push(answer.error);
            }),
        );
    }
    if (want.includes('retry')) {
        if (fresh) retryStore.forget(namespace, run, nowMs);
        asked.push(
            retryStore.get(namespace, run).then((answer) => {
                retry = answer.value;
                observedAt.push(answer.atMs);
                if (answer.error) errors.push(answer.error);
            }),
        );
    }
    await Promise.all(asked);

    const result: RowInfoResult = {
        source: MESSAGE_SOURCE,
        type: 'row-info-result',
        // Echoed, not looked up: the answer names the namespace it was ASKED about,
        // so the isolated world can match it to the question it asked and file it
        // where a same-named workflow in another namespace cannot reach.
        namespace,
        workflowId: run.workflowId,
        runId: run.runId,
        lastEvent,
        retry,
        // THE OLDEST reading, not the newest and not Date.now(): the reply says "every
        // fact in here was true at or after this instant", which is the claim a frozen
        // age can be built on. `Date.now()` here would be a lie of exactly the kind
        // this field exists to stop — the message is new, the data in it is not.
        //
        // The fallback cannot happen through serveRowInfo (an empty `want` is rejected
        // by rowInfoRequestSchema) and is here so that the field is never absent, because
        // absent would mean the renderer had to invent one.
        observedAtMs: observedAt.length > 0 ? Math.min(...observedAt) : nowMs,
        // Deduplicated: both questions failing for the same reason (an evicted
        // ledger, a rate limit) must not print that reason twice in a tooltip.
        error: errors.length > 0 ? Array.from(new Set(errors)).join('\n') : null,
    };
    replyToPage(result);
}
