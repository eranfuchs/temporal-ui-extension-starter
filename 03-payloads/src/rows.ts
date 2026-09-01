// API shape → our row shape. Pure, so it can be unit-tested without a browser.

import type { TemporalApiWorkflow, WorkflowRow } from './types';

// Identity of a single RUN, length-prefixed rather than joined with a separator.
//
// Workflow ids in the wild contain punctuation — pipes, slashes, colons — so any
// literal separator risks two different (workflowId, runId) pairs producing the
// same key. `12:my|wf|id:abc-123` cannot collide with a different split.
export function runKey(workflowId: string, runId: string): string {
    return `${workflowId.length}:${workflowId}:${runId}`;
}

export function normalizeExecutions(executions: TemporalApiWorkflow[]): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    for (const w of executions) {
        // A row without an execution id is not something we can place in a
        // tree or match to a table row; skip rather than invent an id.
        if (!w?.execution?.workflowId || !w.execution.runId) continue;
        const startMs = w.startTime ? Date.parse(w.startTime) : NaN;
        const endMs = w.closeTime ? Date.parse(w.closeTime) : NaN;
        rows.push({
            workflowId: w.execution.workflowId,
            runId: w.execution.runId,
            workflowType: w.type?.name ?? '(unknown)',
            status: simplifyStatus(w.status ?? ''),
            startTimeMs: Number.isFinite(startMs) ? startMs : 0,
            endTimeMs: Number.isFinite(endMs) ? endMs : null,
            parentWorkflowId: w.parentExecution?.workflowId ?? null,
            parentRunId: w.parentExecution?.runId ?? null,
            taskQueue: w.taskQueue ?? null,
            depth: 0,
            segments: [],
        });
    }
    return rows;
}

// ── From "what the page fetched" to "what this table row is" ─────────────────

// Two indexes over whatever the caller wants to store per row: one keyed by RUN,
// one by workflow id for the hrefs that carry no run.
//
// The byWorkflowId value is `P | null`, and the null is the whole point. A
// workflow id is NOT unique on a page: a retried or continued-as-new workflow
// keeps its id and gets a new run, and both runs routinely appear in the same
// list. The first version of this kept the last placement it saw for an id, so a
// run-less href was silently resolved to an arbitrary one of them — which draws a
// row with another run's indentation. `null` records "more than one, we do not
// know which", and findPlacement() then declines.
export interface PlacementIndex<P> {
    byRun: Map<string, P>;
    byWorkflowId: Map<string, P | null>;
}

export function emptyPlacementIndex<P>(): PlacementIndex<P> {
    return { byRun: new Map(), byWorkflowId: new Map() };
}

export function indexPlacements<P>(
    rows: WorkflowRow[],
    make: (row: WorkflowRow, index: number) => P,
): PlacementIndex<P> {
    const index = emptyPlacementIndex<P>();
    rows.forEach((row, position) => {
        const placement = make(row, position);
        index.byRun.set(runKey(row.workflowId, row.runId), placement);
        // First run of an id wins; a second one makes the id ambiguous.
        index.byWorkflowId.set(row.workflowId, index.byWorkflowId.has(row.workflowId) ? null : placement);
    });
    return index;
}

export function findPlacement<P>(
    index: PlacementIndex<P>,
    workflowId: string,
    runId: string | null,
): P | undefined {
    // A run id we have never seen is NOT "this workflow's only run". Falling back
    // to the workflow-id index here is how a row ends up drawn with a different
    // run's indentation — buildTree() in tree.ts refuses to guess a parent for
    // the same reason, and this is that refusal one layer up.
    if (runId) return index.byRun.get(runKey(workflowId, runId));
    // `null` means ambiguous: leave the row alone rather than pick a run.
    return index.byWorkflowId.get(workflowId) ?? undefined;
}

// ── The one URL shape this extension depends on ──────────────────────────────

// `/api/v1/namespaces/{namespace}/workflows` — the list call the page makes on
// its own. Declared once, here, because two copies of it in two worlds is two
// places to update when Temporal changes the route, and the second one will be
// forgotten. inject.ts uses it to decide what to watch; content.ts uses it to
// decide whether an answer belongs to the table on screen.
const WORKFLOW_LIST_URL_RE = /\/api\/v1\/namespaces\/([^/]+)\/workflows(?:\?|$)/;

// The namespace a list-workflows URL is asking about, or null if this is not a
// list-workflows URL at all. Works on absolute and relative URLs alike, because
// the page uses both.
export function namespaceFromApiUrl(url: string): string | null {
    const match = WORKFLOW_LIST_URL_RE.exec(url);
    if (!match) return null;
    const raw = match[1]!;
    try {
        return decodeURIComponent(raw);
    } catch {
        // A malformed escape is not a reason to stop watching the page.
        return raw;
    }
}

// Should this list response be applied to what is on screen?
//
// WHY THIS EXISTS — two ways the obvious version is wrong:
//
//  1. ORDER. Change a filter twice quickly and two list requests are in flight
//     at once. They can answer in either order, and the receiver applied
//     whichever ARRIVED last, so the older answer routinely won and the table
//     was decorated from data the user had already navigated away from. Requests
//     carry a generation stamped when they were ISSUED, which is the only order
//     that reflects what the user asked for last.
//
//  2. IDENTITY. Any URL of the right shape was accepted, including a list for a
//     DIFFERENT namespace — the page fetches those (namespace pickers, counts).
//     Those rows are not in this table, and applying them threw away everything
//     known about the rows that are.
//
// A separate function, and a pure one, because both rules are easy to state,
// easy to get subtly wrong, and impossible to notice going wrong by looking at
// the page: the failure mode of each is "the tree is briefly, occasionally
// wrong", which reads as a rendering glitch.
export type ListResponseVerdict = 'accept' | 'stale' | 'other-namespace' | 'malformed';

export function judgeListResponse(input: {
    // `unknown` on purpose: this arrives over postMessage, and any script on the
    // page can post whatever it likes. A build of inject.ts older than this
    // function sends no generation at all.
    generation: unknown;
    url: unknown;
    appliedGeneration: number;
    // The namespace the page itself is showing, or null when the URL does not
    // name one — in which case there is nothing to compare and the check is
    // skipped rather than guessed at.
    pageNamespace: string | null;
}): ListResponseVerdict {
    if (typeof input.url !== 'string') return 'malformed';
    if (typeof input.generation !== 'number' || !Number.isFinite(input.generation)) return 'malformed';

    const responseNamespace = namespaceFromApiUrl(input.url);
    if (responseNamespace === null) return 'malformed';
    if (input.pageNamespace !== null && responseNamespace !== input.pageNamespace) return 'other-namespace';

    // Equal generations cannot legitimately happen — one response per request —
    // so only a strictly older one is rejected.
    if (input.generation < input.appliedGeneration) return 'stale';
    return 'accept';
}

// "WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW" → "ContinuedAsNew".
export function simplifyStatus(status: string): string {
    const bare = status.replace(/^WORKFLOW_EXECUTION_STATUS_/, '');
    if (!bare) return 'Unknown';
    return bare
        .toLowerCase()
        .split('_')
        .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
        .join('');
}
