// The Temporal HTTP API, expressed as URLs. Pure, so every route this extension
// depends on is in one unit-tested file rather than interpolated at four call
// sites.
//
// These are Temporal's own routes, and its UI drives the same ones — this is not
// a private or undocumented API. Worth knowing before adding a route: path
// parameters are single-encoded, which is what Cloud and a self-hosted server
// from 2.23.0 onwards expect.

// The API prefix, taken from a URL the page itself fetched.
//
// DERIVED, never assumed. Cloud's API lives on a per-tenant host and the OSS
// UI's on the page's own origin; a hardcoded convention for either is a guess
// that breaks silently on the other. Since we only ever ask after having watched
// the page ask, the prefix is already known — cut it off the observed URL.
//
// Returns '' for a relative URL (the OSS case), which is correct and not a
// failure: it resolves against the page. null means "not an API URL at all".
export function apiPrefixOf(observedUrl: string): string | null {
    const cut = observedUrl.indexOf('/api/v1/');
    return cut < 0 ? null : observedUrl.slice(0, cut);
}

// One RUN, which is the unit of identity everywhere in this extension. A
// workflow id alone is not one: a retried or continued-as-new workflow keeps its
// id and gets a new run, and both routinely appear in the same list.
export interface RunRef {
    workflowId: string;
    runId: string;
}

// A run, plus the two things needed to build a URL for it. The prefix and the
// namespace are separate because they come from different places — the prefix
// from a URL we watched, the namespace from the message asking.
export interface ApiTarget extends RunRef {
    apiPrefix: string;
    namespace: string;
}

// `forward` is GetWorkflowExecutionHistory, `reverse` is …HistoryReverse. Both
// are Temporal's own routes and its UI drives both.
//
// The direction is not a detail — it decides what a single event can tell you:
//   forward + maximumPageSize=1  → the FIRST event, i.e. the workflow's input
//   reverse + maximumPageSize=1  → the LAST event, i.e. what it did most recently
// Either way it stays a small request against a workflow with a hundred thousand
// events, which is the only reason a per-row column can afford one.
export function historyUrl(target: ApiTarget & { direction: HistoryDirection; maximumPageSize?: number }): string {
    const route = target.direction === 'forward' ? 'history' : 'history-reverse';
    const size = target.maximumPageSize ?? 1;
    return `${workflowPath(target)}/${route}?maximumPageSize=${size}&execution.runId=${encodeURIComponent(target.runId)}`;
}

export type HistoryDirection = 'forward' | 'reverse';

// DescribeWorkflowExecution.
//
// This is the ONLY route that reports `pendingActivities`, which is the whole
// reason the retry badge cannot be built from history — see the note on
// readPendingRetry() in rowInfo.ts. Unlike the history routes there is nothing to
// page, so a describe is one small response per run and cannot be made smaller.
export function describeWorkflowUrl(target: ApiTarget): string {
    return `${workflowPath(target)}?execution.runId=${encodeURIComponent(target.runId)}`;
}

function workflowPath(target: ApiTarget): string {
    const namespace = encodeURIComponent(target.namespace);
    return `${target.apiPrefix}/api/v1/namespaces/${namespace}/workflows/${encodeURIComponent(target.workflowId)}`;
}
