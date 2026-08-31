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
// Nothing in this file holds a timer. Refresh comes from the Temporal UI polling
// its own list, which re-renders the table, which asks again — and the TTLs decide
// whether asking turns into fetching.

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
    error: string | null;
}

const results = new Map<string, RowInfo>();
const askedAt = new Map<string, number>();

// A tab left open on a busy namespace scrolls through many runs; without this the
// two maps grow for the life of the tab. Same reasoning as MAX_LEDGER_ENTRIES in
// pageApi.ts, and the same crude, adequate remedy.
const MAX_REMEMBERED_RUNS = 2_000;

export function installRowInfo(onUpdate: () => void): void {
    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        const data: unknown = event.data;
        if (!isRowInfoResult(data)) return;
        results.set(runKey(data.workflowId, data.runId), {
            lastEvent: data.lastEvent,
            retry: data.retry,
            error: data.error,
        });
        // One re-render per answer, coalesced by the caller's own scheduler (one
        // pass per animation frame). A hundred answers arriving in one second are
        // therefore a handful of passes, not a hundred.
        onUpdate();
    });
}

export function rowInfoFor(workflowId: string, runId: string): RowInfo | undefined {
    return results.get(runKey(workflowId, runId));
}

// Ask about every row that is worth asking about. Returns how many runs went into
// the message, which the popup reports — a feature whose cost is invisible is a
// feature nobody can review.
export function requestRowInfo(namespace: string, want: RowInfoField[], rows: WorkflowRow[], nowMs: number): number {
    if (!namespace || want.length === 0) return 0;

    const runs: { workflowId: string; runId: string }[] = [];
    for (const row of rows) {
        // The one filter that does most of the work. Every other status is final.
        if (row.status !== 'Running') continue;
        const key = runKey(row.workflowId, row.runId);
        const asked = askedAt.get(key);
        if (asked !== undefined && nowMs - asked < ASK_INTERVAL_MS) continue;
        askedAt.set(key, nowMs);
        runs.push({ workflowId: row.workflowId, runId: row.runId });
    }
    if (runs.length === 0) return 0;

    evictIfHuge();

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
        };
        // location.origin, never '*': this message names runs the user is looking
        // at, and an iframe on the page has no business reading the list.
        window.postMessage(request, location.origin);
    }
    return runs.length;
}

// Called when a setting changes what an answer would have been, so that a stale
// answer cannot outlive the reason it was right.
export function clearRowInfo(): void {
    results.clear();
    askedAt.clear();
}

function evictIfHuge(): void {
    // Whole-map eviction rather than an LRU: the next render pass re-asks for the
    // rows that are actually on screen, so the cost of being crude here is one
    // extra round of requests for the current table and nothing else.
    if (results.size > MAX_REMEMBERED_RUNS) results.clear();
    if (askedAt.size > MAX_REMEMBERED_RUNS) askedAt.clear();
}
