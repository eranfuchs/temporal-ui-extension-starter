// ISOLATED world: which rows to ask about, and what came back.
//
// The other half of rowInfoServe.ts. This side can see the table, so it is the
// side that can be cheap:
//
//   • RUNNING ROWS ONLY. A closed workflow's last event and pending activities
//     cannot change, and asking about one is a request that can never tell you
//     anything new. This single filter is usually most of the saving — a list
//     filtered to "Completed" makes no requests at all.
//   • ROWS THIS TABLE IS SHOWING. Not the whole list response: the page fetches
//     more rows than it draws.
//   • ASK ONCE PER TTL. The MAIN world caches answers, but a request it answers
//     from cache is still a postMessage per row per render pass, and there are a
//     lot of render passes. `askedAt` here is what makes a settled table quiet.
//
// Nothing in this file holds a timer. Automatic refresh comes from the Temporal UI
// polling its own list, which re-renders the table, which asks again — and the TTLs
// decide whether asking turns into fetching. The one path that does not wait for
// that is 'fresh' below, and it is only ever reached by a user pressing the control
// in the column header.

import {
    isRowInfoResult,
    MAX_RUNS_PER_REQUEST,
    type LastEvent,
    type PendingRetry,
    type RowInfoField,
    type RowInfoRequest,
} from './rowInfo';
import { runKey } from './rows';
import { MESSAGE_SOURCE, type WorkflowRow } from './types';

// Slightly longer than the MAIN world's own TTL. Asking sooner than it can
// possibly answer differently is pure message traffic; asking later than that
// would let the column go stale for reasons the user cannot see.
const ASK_INTERVAL_MS = 35_000;

export interface RowInfo {
    lastEvent: LastEvent | null;
    retry: PendingRetry | null;
    // The instant Temporal was read, carried through from the answer. Every age the
    // renderer prints is measured against this and never against the current clock —
    // see the long note on RowInfoResult.observedAtMs in rowInfo.ts. It is stored
    // rather than recomputed on arrival, because an answer served from the MAIN
    // world's TTL cache can be up to that TTL older than the message carrying it.
    observedAtMs: number;
    error: string | null;
}

// Both maps are keyed by (namespace, workflowId, runId), never by the run alone.
// A workflow id is unique WITHIN a namespace only, and one tab reaches several of
// them — the namespace picker, a parent link into another namespace — so a run-only
// key lets an answer about `order-42` in one namespace be rendered on the `order-42`
// of another. It is also what makes askedAt usable as the correlation check below:
// the question and the answer have to agree on all three parts.
const results = new Map<string, RowInfo>();
const askedAt = new Map<string, number>();

// Namespace prefixed the same length-prefixed way runKey does it, and BUILT ON
// runKey rather than beside it, so the collision argument lives in one place.
function askKey(namespace: string, workflowId: string, runId: string): string {
    return `${namespace.length}:${namespace}:${runKey(workflowId, runId)}`;
}

// A tab left open on a busy namespace scrolls through many runs; without this the
// two maps grow for the life of the tab. Same reasoning as MAX_LEDGER_ENTRIES in
// pageApi.ts, and the same crude, adequate remedy.
//
// Exported for the spec that drives eviction: a test that hard-codes 2000 stops
// testing eviction the day this number changes, and passes while doing it.
export const MAX_REMEMBERED_RUNS = 2_000;

export function installRowInfo(onUpdate: () => void): void {
    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        const data: unknown = event.data;
        // Well-formed to the leaves — see isRowInfoResult, which validates every
        // nested field for exactly this reason. It is still only a SHAPE check.
        if (!isRowInfoResult(data)) return;
        const key = askKey(data.namespace, data.workflowId, data.runId);
        // ONLY IF WE ASKED. `postMessage` has no authenticated sender, so this is
        // not authentication and cannot be made into it — anything running in the
        // page can post a valid-looking answer. What it does buy is that a message
        // has to name a question THIS side actually asked, which rules out the
        // realistic cases: another extension's traffic, a copy of our own message
        // replayed from a different namespace, and a forged answer about a run the
        // user is not looking at. A forger who reads the request we just posted can
        // still answer it — and the ceiling on that is small by construction,
        // because the worst a wrong answer does is show the wrong event type or
        // retry count in that row's cell. It reaches no credential, starts no
        // request, and moves no payload.
        if (!askedAt.has(key)) return;
        results.set(key, {
            lastEvent: data.lastEvent,
            retry: data.retry,
            observedAtMs: data.observedAtMs,
            error: data.error,
        });
        // One re-render per answer, coalesced by the caller's own scheduler (one
        // pass per animation frame). A hundred answers arriving in one second are
        // therefore a handful of passes, not a hundred.
        onUpdate();
    });
}

export function rowInfoFor(namespace: string, workflowId: string, runId: string): RowInfo | undefined {
    return results.get(askKey(namespace, workflowId, runId));
}

// WHY A ROW IS BEING ASKED ABOUT, which decides both of the things that make asking
// cheap — whether the ask interval applies here, and whether the MAIN world may
// answer from its cache.
//
//   • 'due'   — a render pass. Skips any row asked about recently, and takes the
//               cached answer. This is every automatic ask.
//   • 'fresh' — the user pressed refresh. Asks about every visible running row
//               regardless of when it was last asked, and tells the MAIN world to
//               ignore what it already has. Bounded there by FRESH_FLOOR_MS, not
//               here: this side is a page script's to imitate.
export type RowInfoAskMode = 'due' | 'fresh';

// Ask about every row that is worth asking about. Returns how many runs went into
// the message, which the popup reports — a feature whose cost is invisible is a
// feature nobody can review.
export function requestRowInfo(
    namespace: string,
    want: RowInfoField[],
    rows: WorkflowRow[],
    nowMs: number,
    mode: RowInfoAskMode = 'due',
): number {
    if (!namespace || want.length === 0) return 0;

    // BEFORE recording this pass, not after. askedAt is now the gate that lets an
    // answer in, so clearing it immediately after asking would throw away the
    // answers to the questions in this very message — and the user would see the
    // column stay empty for one whole round. The bound this keeps is therefore
    // MAX_REMEMBERED_RUNS plus one table's worth, which is the point of it.
    evictIfHuge();

    const runs: { workflowId: string; runId: string }[] = [];
    for (const row of rows) {
        // The one filter that does most of the work. Every other status is final.
        if (row.status !== 'Running') continue;
        const key = askKey(namespace, row.workflowId, row.runId);
        const asked = askedAt.get(key);
        // The ask interval is what makes a settled table quiet, and pressing refresh
        // is a statement that quiet is not what was wanted.
        if (mode === 'due' && asked !== undefined && nowMs - asked < ASK_INTERVAL_MS) continue;
        askedAt.set(key, nowMs);
        runs.push({ workflowId: row.workflowId, runId: row.runId });
    }
    if (runs.length === 0) return 0;

    // Sent in chunks the receiver will accept. isRowInfoRequest caps `runs` —
    // because anyone in the page can send that message — and a cap is enforced by
    // dropping the WHOLE message, so a table larger than the cap would silently
    // produce no answers at all. Chunking here rather than raising the cap keeps
    // the bound on what a forged message can ask for.
    for (let from = 0; from < runs.length; from += MAX_RUNS_PER_REQUEST) {
        const request: RowInfoRequest = {
            source: MESSAGE_SOURCE,
            type: 'row-info-request',
            namespace,
            want,
            runs: runs.slice(from, from + MAX_RUNS_PER_REQUEST),
            fresh: mode === 'fresh',
        };
        // location.origin, never '*': this message names runs the user is looking
        // at, and an iframe on the page has no business reading the list.
        window.postMessage(request, location.origin);
    }
    return runs.length;
}

// Called when a setting changes what an answer would have been, so that a stale
// answer cannot outlive the reason it was right.
//
// NOT called by refresh, on purpose. A refresh that emptied `results` would blank
// the whole column for as long as the round takes to drain, and a column that goes
// blank when you ask it to update reads as a feature that broke rather than one that
// is working. The old answers stay on screen and are overwritten as the new ones
// arrive. (This is the safe half of the pairing evictIfHuge() reasons about below:
// keeping answers while re-asking costs one extra round; the reverse — dropping
// answers while every row still counts as recently asked — is the one that shows the
// user an empty column.)
export function clearRowInfo(): void {
    results.clear();
    askedAt.clear();
}

function evictIfHuge(): void {
    // Whole-map eviction rather than an LRU: the next render pass re-asks for the
    // rows that are actually on screen, so the cost of being crude here is one
    // extra round of requests for the current table and nothing else.
    //
    // BOTH OR NEITHER. They used to be evicted independently, and dropping
    // `results` while keeping `askedAt` is the one combination that shows the user
    // something wrong: the answers are gone, but every row still counts as recently
    // asked, so the column sits empty until the ask interval expires. Clearing
    // together costs one extra round and ends there.
    if (results.size > MAX_REMEMBERED_RUNS || askedAt.size > MAX_REMEMBERED_RUNS) {
        results.clear();
        askedAt.clear();
    }
}
