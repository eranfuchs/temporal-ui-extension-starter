// Two questions about a single run that the workflow-list response cannot
// answer, and the pure code that asks them.
//
// This is the file to read if you want to know what "we can make our own API
// calls" actually costs. Everything else in this extension is a piggyback: it
// reads a response the page was fetching anyway. These two are not. They are the
// reason src/pageApi.ts exists.
//
//   • LAST EVENT — what this workflow did most recently. One
//     GetWorkflowExecutionHistoryReverse with maximumPageSize=1 per run.
//   • RETRYING ACTIVITY — is an activity stuck in a retry loop, and on which
//     attempt. One DescribeWorkflowExecution per run.
//
// WHY THE SECOND ONE CANNOT PIGGYBACK, WHICH IS THE WHOLE JUSTIFICATION.
//
// `pendingActivities` is returned by DescribeWorkflowExecution and by nothing
// else — it is not in the list response and not in the history. Nor can it be
// reconstructed from the history tail: an activity on attempt 900 had its
// ActivityTaskScheduled event written ~900 events ago, so a tail of any sane size
// misses exactly the workflows this badge exists to find. There is no cheaper
// question that answers it.
//
// NO FAILURE MESSAGE IS READ HERE, DELIBERATELY.
//
// `pendingActivities[].lastFailure.message` is right there next to `attempt`, and
// the internal extension this starter was extracted from does show it. This one
// does not, and will not: a failure message is application data — it routinely
// carries account numbers, customer ids, upstream response bodies — and this
// project's 02 stage is the one that reads history WITHOUT reading anybody's data.
// Attempt count, the activity TYPE (a name from the workflow's own source) and a
// next-retry time are enough to find a stuck workflow, and none of the three is
// user data. `activityId` is skipped for the same reason: unlike the type, it is
// chosen by the caller and is regularly built out of a business identifier.
//
// Everything in this file is pure. The requests are in rowInfoServe.ts (MAIN
// world, where the page's own credentials are) and the decision about WHICH rows
// to ask about is in rowInfoClient.ts (ISOLATED world, where the table is).

import { MESSAGE_SOURCE } from './types';

// ── What we ask for ──────────────────────────────────────────────────────────

// One field = one API call per run. Kept separate so a user who turned on one of
// the two features pays for one request per row and not two.
export type RowInfoField = 'lastEvent' | 'retry';

export interface RowInfoRequest {
    source: typeof MESSAGE_SOURCE;
    type: 'row-info-request';
    namespace: string;
    want: RowInfoField[];
    // Every run the asker wants answered, in one message. There is no request id:
    // answers are matched by (workflowId, runId), because a run's last event is
    // the same answer no matter which render pass asked for it — and one answer
    // per run means the slow ones do not hold up the fast ones.
    runs: { workflowId: string; runId: string }[];
}

export interface RowInfoResult {
    source: typeof MESSAGE_SOURCE;
    type: 'row-info-result';
    workflowId: string;
    runId: string;
    lastEvent: LastEvent | null;
    retry: PendingRetry | null;
    // Set when a question could not be answered at all. Rendered into a title
    // attribute, so it is written for a human — never a status code on its own.
    error: string | null;
}

// A forged message can name as many runs as it likes, and each one costs a URL
// build and a ledger lookup. The bound is deliberately larger than a Temporal
// list page so the real caller never trips it.
export const MAX_RUNS_PER_REQUEST = 500;

// SHAPE ONLY. This says the message is well-formed and nothing whatever about who
// sent it — every field of it is published in this repository. What stops a forged
// message from being answered is the ledger in pageApi.ts, which fetches only for
// runs the PAGE ITSELF was handed.
export function isRowInfoRequest(value: unknown): value is RowInfoRequest {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'row-info-request') return false;
    if (typeof message['namespace'] !== 'string' || !message['namespace']) return false;
    const want = message['want'];
    if (!Array.isArray(want) || want.length === 0) return false;
    if (!want.every((field) => field === 'lastEvent' || field === 'retry')) return false;
    const runs = message['runs'];
    if (!Array.isArray(runs) || runs.length > MAX_RUNS_PER_REQUEST) return false;
    return runs.every((run) => {
        const entry = asObject(run);
        return typeof entry?.['workflowId'] === 'string' && typeof entry['runId'] === 'string';
    });
}

export function isRowInfoResult(value: unknown): value is RowInfoResult {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'row-info-result') return false;
    return typeof message['workflowId'] === 'string' && typeof message['runId'] === 'string';
}

// ── Reading the answers ──────────────────────────────────────────────────────

export interface LastEvent {
    // int64 in the proto, and therefore a STRING in JSON. Kept as one: it is
    // displayed and compared, never added up. See the note on numberOf below.
    eventId: string;
    // Normalised — see prettyEventType.
    eventType: string;
    timeMs: number | null;
}

export interface PendingRetry {
    // activityType.name: a symbol from the workflow's source, not user data.
    activityType: string;
    // The attempt now pending. 1 means "running for the first time", which is not
    // a retry and never produces a badge — see readPendingRetry.
    attempt: number;
    // 0 in the API means UNLIMITED, and reporting "attempt 900 of 0" is worse
    // than saying nothing, so it becomes null here.
    maximumAttempts: number | null;
    nextRetryAtMs: number | null;
    // When the CURRENT attempt was scheduled. Retained because "attempt 900" says
    // nothing about whether it is moving; a scheduled time that is minutes old is
    // a different situation from one that is seconds old.
    scheduledAtMs: number | null;
}

// The newest event of a run, from a history-reverse page.
//
// With `history-reverse` the events come back newest-first, so events[0] is the
// answer. (Asking the forward route for one event returns the FIRST event of the
// workflow instead — the same shape, a completely different fact, and no error.)
export function readLastEvent(body: unknown): LastEvent | null {
    const events = eventsOf(body);
    const event = asObject(events?.[0]);
    if (!event) return null;
    const rawType = typeof event['eventType'] === 'string' ? event['eventType'] : '';
    const timeMs = timeToMs(event['eventTime']);
    return {
        eventId: typeof event['eventId'] === 'string' ? event['eventId'] : String(event['eventId'] ?? ''),
        eventType: prettyEventType(rawType),
        timeMs,
    };
}

// Exported because src/detail.ts folds a history response too, and this is the
// one line of it that is a FACT ABOUT THE API rather than local convenience. If
// the two files each kept their own copy, a server that stopped nesting the array
// would break one of them and not the other, which is the harder bug to find.
export function eventsOf(body: unknown): unknown[] | null {
    const root = asObject(body);
    if (!root) return null;
    // Both shapes are real: the history routes wrap the array in `history`, and
    // some responses (and every fixture written by hand) carry it bare.
    const nested = asObject(root['history'])?.['events'];
    const events = Array.isArray(nested) ? nested : root['events'];
    return Array.isArray(events) ? events : null;
}

// "EVENT_TYPE_WORKFLOW_TASK_COMPLETED" and "WorkflowTaskCompleted" are the same
// event from two Temporal versions, and a column that shows one spelling on Cloud
// and the other on a self-hosted server looks broken in a way nobody reports.
// Both normalise to the second form.
//
// (rows.ts::simplifyStatus does the same job for status enums. It is not reused
// because rows.ts is byte-identical across the projects in this repository —
// scripts/lineage.json enforces that — so a change there would have to be a
// change in 01 too, for a feature 01 does not have.)
export function prettyEventType(raw: string): string {
    const bare = raw.replace(/^EVENT_TYPE_/, '');
    if (!bare) return 'Unknown';
    // Already CamelCase (no underscores): leave it exactly as the server said it.
    if (!bare.includes('_')) return bare;
    return bare
        .toLowerCase()
        .split('_')
        .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
        .join('');
}

// The retrying activity of a DescribeWorkflowExecution response, or null.
//
// ONE activity is reported, not all of them: the badge is a signal, not a report,
// and the highest attempt count is the one that says how stuck this workflow is.
// A workflow with three retrying activities is not three times as interesting as
// one with the worst of them.
export function readPendingRetry(body: unknown): PendingRetry | null {
    const pending = asObject(body)?.['pendingActivities'];
    if (!Array.isArray(pending)) return null;

    let worst: PendingRetry | null = null;
    for (const entry of pending) {
        const activity = asObject(entry);
        if (!activity) continue;
        const attempt = numberOf(activity['attempt']) ?? 1;
        // attempt === 1 is the first, still-hopeful run of an activity. Badging it
        // would put a retry marker on every healthy running workflow in the list,
        // which is the same as having no badge at all.
        if (attempt < 2) continue;
        const maximum = numberOf(activity['maximumAttempts']) ?? 0;
        const candidate: PendingRetry = {
            activityType: textOf(asObject(activity['activityType'])?.['name']) ?? 'activity',
            attempt,
            maximumAttempts: maximum > 0 ? maximum : null,
            nextRetryAtMs: timeToMs(activity['nextAttemptScheduleTime']),
            scheduledAtMs: timeToMs(activity['scheduledTime']),
        };
        if (!worst || candidate.attempt > worst.attempt) worst = candidate;
    }
    return worst;
}

// ── Saying it in a cell ──────────────────────────────────────────────────────

// The compact form for the column: "3m", "2h", "just now". No "ago" — the column
// header says what these are, and the width is the point.
export function formatAge(timeMs: number | null, nowMs: number): string {
    if (timeMs === null) return '—';
    const seconds = Math.round((nowMs - timeMs) / 1000);
    if (seconds < 0) return 'now'; // a clock skew of a second or two is normal
    if (seconds < 10) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

export function lastEventTitle(event: LastEvent, nowMs: number): string {
    const when = event.timeMs === null ? 'no timestamp' : new Date(event.timeMs).toISOString();
    return `Last event #${event.eventId}: ${event.eventType}\n${when} (${formatAge(event.timeMs, nowMs)} ago)`;
}

// "↻ 900" — the attempt count, because that single number is what separates "this
// activity failed once" from "this workflow has been stuck since yesterday".
export function retryBadgeLabel(retry: PendingRetry): string {
    return `↻ ${retry.attempt}`;
}

// The badge's title. Read the no-failure-message note at the top of this file
// before adding a line here: everything in this string has to be safe to show to
// somebody looking over the operator's shoulder.
export function retryBadgeTitle(retry: PendingRetry, nowMs: number): string {
    const ceiling = retry.maximumAttempts === null ? 'unlimited' : `${retry.maximumAttempts}`;
    const lines = [`${retry.activityType} is retrying`, `attempt ${retry.attempt} of ${ceiling}`];
    if (retry.nextRetryAtMs !== null) lines.push(`next attempt ${formatWhen(retry.nextRetryAtMs, nowMs)}`);
    if (retry.scheduledAtMs !== null) {
        lines.push(`this attempt scheduled ${formatAge(retry.scheduledAtMs, nowMs)} ago`);
    }
    lines.push('(the failure message is deliberately not read — see src/rowInfo.ts)');
    return lines.join('\n');
}

function formatWhen(atMs: number, nowMs: number): string {
    const seconds = Math.round((atMs - nowMs) / 1000);
    if (seconds <= 0) return 'due now';
    if (seconds < 60) return `in ${seconds}s`;
    return `in ${Math.floor(seconds / 60)}m`;
}

// ── Small readers ────────────────────────────────────────────────────────────

function asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

// Numbers arrive as numbers OR as strings, depending on the field's proto type:
// int32 serialises as a JSON number, int64 as a JSON STRING. `attempt` is an
// int32 today, which is exactly the kind of thing that changes quietly, so both
// are accepted rather than one being assumed.
function numberOf(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function timeToMs(value: unknown): number | null {
    if (typeof value !== 'string' || !value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}
