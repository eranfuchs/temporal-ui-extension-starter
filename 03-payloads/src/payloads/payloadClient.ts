// The isolated-world client for one payload question.
//
// RESPONSIBILITY: turn "what was this run's input?" into at most one message, and
// return the answer that belongs to that question. Nothing here touches the DOM,
// and nothing here fetches — the fetch is payloadServe.ts's, in the page's world,
// for the CORS reasons set out at the top of codec.ts. src/payloads/tooltip.ts owns the
// element and decides WHEN to ask; this file owns what happens between asking and
// answering.
//
// It is the second client of a pattern src/rowInfo/rowInfoClient.ts established, kept
// separate rather than generalised: the two ask different questions, and the
// consequence of a wrong answer is not the same size on the two sides.
//
// FOUR INVARIANTS. Each of them fails silently in a browser, which is why each is
// pinned by a spec rather than by review.
//
//  1. AN ANSWER NAMES THE QUESTION IT ANSWERS. namespace, workflow id, run id and
//     kind must all match what was asked. The same four are the cache key, so the
//     check and the key cannot drift apart. The request id alone is not enough: it
//     is a small integer starting at 1 in every tab.
//
//     This is not authentication and cannot be made into it — postMessage has no
//     authenticated sender. What it rules out is every case that does not involve
//     reading our traffic first: another extension's messages, one of our own
//     answers replayed for a different namespace, and an unsolicited answer about
//     a run nobody hovered.
//  2. ONE QUESTION IS ONE REQUEST. A question already in flight is joined, not
//     asked again — the cache cannot cover the interval between the message going
//     out and the answer coming back, and three separate gestures reach the same
//     row. See "One question, three entry points" in docs/design-notes.md.
//  3. AN ANSWER NEVER OUTLIVES THE SETTING IT WAS DECODED UNDER. Emptying the
//     cache is not enough on its own; a request already in flight resolves a moment
//     later and would refill the map it was invalidated out of. Every request
//     remembers the epoch it was asked under.
//  4. A REQUEST THAT NEVER COMES BACK STILL ANSWERS. The MAIN-world script can be
//     absent entirely — an older build, a page it did not run on — and a section
//     saying "Loading…" for ever is not an answer.
//
// The incidents behind 1–3, and the reason invariant 3 needs a fourth step that
// lives in tooltip.ts, are in docs/design-notes.md under "The payload panel".

import {
    isPayloadResult,
    type CodecConfig,
    type PayloadKind,
    type PayloadRequest,
    type PayloadResult,
} from './payloadMessages';
import { runKey } from '../family/rows';
import { MESSAGE_SOURCE } from '../types';

// What one hover asks about. Invariant 1: this is both the correlation check on
// the answer and the cache key.
export interface Question {
    namespace: string;
    workflowId: string;
    runId: string;
    kind: PayloadKind;
}

export interface PayloadClientDeps {
    codec: () => CodecConfig;
}

// A request that never comes back must not leave a section saying "Loading…"
// for ever. Invariant 4. Exported for the same reason MAX_CACHED_PAYLOADS is: the
// spec that drives it advances a fake clock past this value, and a spec that
// hard-codes 15_000 keeps passing after the number changes.
export const REQUEST_TIMEOUT_MS = 15_000;

// The cache is bounded, which the per-row cache in rowInfoClient.ts needs for
// memory and this one needs for a second reason: its values are DECODED payloads,
// up to MAX_DISPLAY_CHARS each. A tab left open all afternoon would otherwise keep
// every customer record its owner had glanced at, long after the panel closed.
// Exported so the spec that drives eviction does not hard-code the number and then
// keep passing after it changes.
export const MAX_CACHED_PAYLOADS = 200;

let deps: PayloadClientDeps | null = null;
let nextRequestId = 1;

// Answers already received. A pointer moving back and forth between two rows is
// very common and each round trip is a real request.
const cache = new Map<string, PayloadResult>();

// Questions asked and not yet answered, keyed the same way the cache is.
// Invariant 2: this is the cache for the interval the cache cannot cover. Entries
// are removed as they settle, so the map is bounded by what is genuinely in flight
// and needs no eviction pass.
const inFlight = new Map<string, Promise<PayloadResult>>();

// Requests posted and not yet settled, by id. Separate from `inFlight` because
// this one is keyed by the id the answer carries, and it is what the message
// listener looks in.
const pending = new Map<number, { question: Question; settle: (result: PayloadResult) => void }>();

// Invariant 3. Bumped on every reset, and compared when an answer arrives.
let cacheEpoch = 0;

// One listener, installed once. The `codec` dependency is a function rather than a
// value because the setting can change while a tab is open, and the request must
// carry the setting as it is at the moment of asking.
export function installPayloadClient(dependencies: PayloadClientDeps): void {
    deps = dependencies;

    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        // Well-formed to the leaves — isPayloadResult validates every field,
        // including the three run fields this check is about to read.
        if (!isPayloadResult(event.data)) return;
        const waiting = pending.get(event.data.id);
        if (!waiting) return;
        // Invariant 1. NOT `pending.delete` on a mismatch: a message that names the
        // wrong run must not settle — or cancel — the question it collided with.
        // Dropping it leaves the real answer (or the timeout) to do that, so the
        // worst a forged answer achieves here is nothing at all.
        if (!answersTheQuestion(waiting.question, event.data)) return;
        pending.delete(event.data.id);
        waiting.settle(event.data);
    });
}

// Every answer this client has kept, and every question it is still waiting on,
// discarded; answers still in flight are barred from being cached when they land.
//
// Called when the codec settings change and when the payload panel is switched
// off: an answer that failed because no codec server was configured must not be the
// answer for ever, and an answer decoded by a server the user has since removed
// must not outlive the setting. Not needed for a namespace change — the namespace
// is in the key.
//
// THIS IS THREE OF THE FOUR HOLDERS, NOT ALL OF THEM. The fourth is the text
// already painted into the panel, which only tooltip.ts can reach — see
// resetPayloadState() there, and "A late answer, and the four places one can hide"
// in docs/design-notes.md.
export function resetPayloadClient(): void {
    cache.clear();
    inFlight.clear();
    cacheEpoch++;
}

export function answersTheQuestion(question: Question, result: PayloadResult): boolean {
    return (
        result.namespace === question.namespace &&
        result.workflowId === question.workflowId &&
        result.runId === question.runId &&
        result.kind === question.kind
    );
}

// The namespace is part of the key, prefixed the same length-prefixed way runKey
// does it. A workflow id is unique WITHIN a namespace, and one tab reaches several
// of them, so a run-only key would serve `order-42`'s input from one namespace as
// `order-42`'s input in another — see the same argument, at more length, in
// rowInfoClient.ts.
function cacheKey(question: Question): string {
    const { namespace, workflowId, runId, kind } = question;
    return `${kind}|${namespace.length}:${namespace}:${runKey(workflowId, runId)}`;
}

// The answer to one question: from the cache, or from a request already in flight,
// or from a new one. Never throws — a failure comes back as a PayloadResult with
// `error` set, because the caller is a tooltip and has nowhere to put an exception.
export async function requestPayload(question: Question): Promise<PayloadResult> {
    const key = cacheKey(question);
    const cached = cache.get(key);
    if (cached) return cached;

    // Invariant 2.
    const inflight = inFlight.get(key);
    if (inflight) return await inflight;

    const epoch = cacheEpoch;
    const attempt = ask(question)
        .then((result) => {
            // Remembered HERE rather than at each awaiter, so two callers sharing one
            // request write one cache entry, and so the eviction pass in remember()
            // is not run twice for the same insert.
            //
            // Errors are not cached: they are usually a setting the user is about to
            // fix. Neither is an answer whose epoch has passed — invariant 3.
            if (!result.error && epoch === cacheEpoch) remember(key, result);
            return result;
        })
        // Whatever happened, this question is no longer in flight. In `finally` and
        // not in the `then` above so that a rejection — which ask() should never
        // produce, but a future edit could — cannot leave a permanently poisoned
        // entry that every later hover joins.
        //
        // ONLY IF THE ENTRY IS STILL THIS ATTEMPT'S: a reset empties the map while
        // requests are still out, so the same key can legitimately hold a NEWER
        // attempt by the time this one settles. Deleting unconditionally breaks
        // invariant 2 in the one situation nobody hovers twice to check — the
        // incident is in docs/design-notes.md.
        .finally(() => {
            if (inFlight.get(key) === attempt) inFlight.delete(key);
        });

    inFlight.set(key, attempt);
    return await attempt;
}

async function ask(question: Question): Promise<PayloadResult> {
    const id = nextRequestId++;
    const message: PayloadRequest = {
        source: MESSAGE_SOURCE,
        type: 'payload-request',
        id,
        namespace: question.namespace,
        workflowId: question.workflowId,
        runId: question.runId,
        kind: question.kind,
        // The fallback is the no-egress config: an uninstalled dependency must not
        // be able to produce a request that sends anything anywhere.
        codec: deps?.codec() ?? { endpoint: '' },
    };

    return await new Promise<PayloadResult>((resolve) => {
        const timeout = window.setTimeout(() => {
            pending.delete(id);
            resolve(timedOut(id, question));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
            question,
            settle: (answer) => {
                window.clearTimeout(timeout);
                resolve(answer);
            },
        });
        // location.origin, never '*': this names a run the user is looking at, and
        // an iframe on the page has no business reading it.
        window.postMessage(message, location.origin);
    });
}

// Invariant 4, as a well-formed answer rather than as a rejection: the panel
// renders `error` and has no other way to say "this did not work".
function timedOut(id: number, question: Question): PayloadResult {
    return {
        source: MESSAGE_SOURCE,
        type: 'payload-result',
        id,
        namespace: question.namespace,
        workflowId: question.workflowId,
        runId: question.runId,
        kind: question.kind,
        label: '',
        text: '',
        decodedBy: null,
        error: 'No answer from the page world. Reload the tab.',
    };
}

function remember(key: string, result: PayloadResult): void {
    // Whole-map eviction rather than an LRU, for the same reason rowInfoClient.ts
    // gives: what is on screen is one hover away from being re-fetched, so being
    // crude here costs one round trip and nothing else. Cleared BEFORE the insert,
    // so the entry the user is looking at survives its own eviction pass.
    if (cache.size >= MAX_CACHED_PAYLOADS) cache.clear();
    cache.set(key, result);
}
