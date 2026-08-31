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
//      each one would be a fresh round of requests.
//   2. IN-FLIGHT COALESCING. Ten render passes during one slow request must
//      produce one request, not ten. The pending promise is the dedupe key.
//   3. A CONCURRENCY CAP, and
//   4. BACKOFF ON 429/503 honouring Retry-After — both in src/pacer.ts, which
//      exists as a separate module because it is about TIME and therefore needs an
//      injected clock to be testable at all. It was inline here, untested, and
//      wrong: read the note at the top of that file before copying either idea.
//
// It also refreshes for free: the Temporal UI polls its own workflow list, every
// poll re-renders the table, every re-render asks again, and the TTL decides
// whether that becomes a request. Nothing here holds a timer of its own.

import { fetchFailureMessage, fetchForListedRun, replyToPage, TAG } from './pageApi';
import { makePacer } from './pacer';
import {
    readLastEvent,
    readPendingRetry,
    type LastEvent,
    type PendingRetry,
    type RowInfoField,
    type RowInfoRequest,
    type RowInfoResult,
} from './rowInfo';
import { describeWorkflowUrl, historyUrl, type RunRef } from './temporalApi';
import { MESSAGE_SOURCE } from './types';

// How long an answer is worth keeping. A last event that is 30 seconds stale is
// still the right shape of answer for "is this workflow moving?", and this is the
// single number that decides how much traffic the feature makes.
const TTL_MS = 30_000;

// ── The pacer ────────────────────────────────────────────────────────────────
//
// Points 3 and 4 of the four above live in src/pacer.ts, with the clock and the
// sleep injected so that "never more than four, even coming out of a backoff" is a
// test rather than a claim. It was inline here, and it was broken here; the note at
// the top of that file says exactly how.
//
// This is the only pacer in the extension, and every request in this file goes
// through it. There is nowhere else a fetch to Temporal can be added from.
const pacer = makePacer(
    { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    {
        // A hundred running rows is two hundred requests; fired at once they arrive
        // as a burst that looks, from the server's side, exactly like an attack.
        // Four at a time turns it into a queue that drains in seconds.
        maxConcurrent: 4,
        backoffStartMs: 2_000,
        backoffCeilingMs: 60_000,
        // A Retry-After longer than this is honoured up to here and no further; see
        // PacerLimits for why a server-supplied wait needs a ceiling of its own.
        advisedCeilingMs: 300_000,
    },
);

// Turns a non-OK response into the error that will be shown, and applies backoff
// when the server said to slow down.
//
// 429 and 503 are the two that mean "later, not never". Everything else (403 on a
// namespace the token cannot read, 404 on a run that has been archived) is a
// permanent answer for this run, and pausing every other row because of it would
// be wrong.
function refuse(response: Response, what: string): never {
    if (response.status === 429 || response.status === 503) {
        const wait = pacer.noteRateLimit(response.headers.get('retry-after'));
        console.warn(TAG, `rate-limited by the Temporal API — pausing row info for ${Math.round(wait / 1000)}s`);
        throw new Error(`Temporal is rate-limiting this page; ${what} will be retried shortly.`);
    }
    throw new Error(`${what} failed: HTTP ${response.status}`);
}

// ── One cache per field ──────────────────────────────────────────────────────

interface Answer<T> {
    value: T | null;
    error: string | null;
    atMs: number;
}

interface FieldStore<T> {
    get(namespace: string, run: RunRef): Promise<Answer<T>>;
    clear(): void;
}

function makeFieldStore<T>(load: (namespace: string, run: RunRef) => Promise<T | null>): FieldStore<T> {
    const answers = new Map<string, Answer<T>>();
    const inFlight = new Map<string, Promise<Answer<T>>>();

    return {
        async get(namespace: string, run: RunRef): Promise<Answer<T>> {
            // Namespace is part of the key: the same workflow id can exist in two
            // of them, and this map is not per-namespace.
            const key = `${namespace.length}:${namespace}:${run.workflowId.length}:${run.workflowId}:${run.runId}`;
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
                answers.set(key, answer);
                inFlight.delete(key);
                return answer;
            })();
            inFlight.set(key, promise);
            return await promise;
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
        void answerOne(request.namespace, run, request.want);
    }
}

async function answerOne(namespace: string, run: RunRef, want: RowInfoField[]): Promise<void> {
    const errors: string[] = [];
    let lastEvent: LastEvent | null = null;
    let retry: PendingRetry | null = null;

    // Both questions in parallel — they are two independent GETs, and the pacer
    // above is what keeps "in parallel" from meaning "all at once".
    const asked: Promise<void>[] = [];
    if (want.includes('lastEvent')) {
        asked.push(
            lastEventStore.get(namespace, run).then((answer) => {
                lastEvent = answer.value;
                if (answer.error) errors.push(answer.error);
            }),
        );
    }
    if (want.includes('retry')) {
        asked.push(
            retryStore.get(namespace, run).then((answer) => {
                retry = answer.value;
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
        // Deduplicated: both questions failing for the same reason (an evicted
        // ledger, a rate limit) must not print that reason twice in a tooltip.
        error: errors.length > 0 ? Array.from(new Set(errors)).join('\n') : null,
    };
    replyToPage(result);
}
