// Two questions about a single run that the workflow-list response cannot
// answer, and the pure code that asks them.
//
// This is the file to read if you want to know what "we can make our own API
// calls" actually costs. Everything else in this extension is a piggyback: it
// reads a response the page was fetching anyway. These two are not. They are the
// reason src/page/pageApi.ts exists.
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
// the internal extension this starter reimplements does show it. This one
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

import { MESSAGE_SOURCE } from '../types';

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
    // "Do not answer these from what you already know." False on every automatic
    // pass; true only when the user pressed the refresh control in the column
    // header.
    //
    // This flag switches OFF the TTL cache, which is the first of the four things
    // that keep this feature from being a load generator (see rowInfoServe.ts) —
    // and anything running in the page can post this message, so a flag that
    // switched it off on request would have switched it off for whoever asked, as
    // often as they liked. FRESH_FLOOR_MS below is what stops that, enforced by
    // the receiver rather than promised by the sender.
    //
    // It is a flag on the existing message and NOT a message of its own, which is
    // deliberate: the number of message types this extension accepts from the page
    // is what a reviewer enumerates, and a refresh button is not worth adding one.
    fresh: boolean;
}

export interface RowInfoResult {
    source: typeof MESSAGE_SOURCE;
    type: 'row-info-result';
    // Echoed back from the request it answers. A workflow id is unique within a
    // namespace and NOT across them, and a Temporal UI page fetches lists for more
    // than one — so without this an answer about `order-42` in a namespace the
    // picker touched could be filed under the `order-42` on screen. It is what lets
    // the ISOLATED world file answers per namespace, and what lets it recognise an
    // answer to a question it never asked.
    namespace: string;
    workflowId: string;
    runId: string;
    lastEvent: LastEvent | null;
    retry: PendingRetry | null;
    // WHEN THIS WAS TRUE — the instant the answer was read from Temporal, not the
    // instant it was sent on. The two differ by up to the TTL, because an answer may
    // be served from the cache in rowInfoServe.ts.
    //
    // Everything that renders an age measures it against THIS and never against
    // Date.now(), and that is the whole reason the field exists. An age is a
    // subtraction, so measuring against the current clock produces a number that
    // creeps upward on its own — which reads as a live measurement of a workflow
    // nobody is watching. The event timestamp is at most 35 seconds old (see
    // ASK_INTERVAL_MS) and may be a great deal staler than the display implies; what
    // this extension actually knows is "at 12:04:31, the newest event was 3m 00s
    // old", and that is the sentence the column now tells.
    //
    // The cost of the honest version is that the age UNDER-reports a stall by up to
    // one ask interval. That is the right direction to be wrong in: the alternative
    // was a number that looked precise to the second while the fact under it was half
    // a minute old, and the only way to make a per-second age truthful would be a
    // per-second request per row — the load this whole file exists to avoid.
    //
    // Where fields disagree — one served from cache, the other freshly fetched — this
    // is the OLDER of them, so it is a floor: everything in this message was true at
    // or after this instant.
    observedAtMs: number;
    // Set when a question could not be answered at all. Rendered into a title
    // attribute, so it is written for a human — never a status code on its own.
    error: string | null;
}

// A forged message can name as many runs as it likes, and each one costs a URL
// build and a ledger lookup. The bound is deliberately larger than a Temporal
// list page so the real caller never trips it.
export const MAX_RUNS_PER_REQUEST = 500;

// The floor under `fresh`. An answer that arrived less than this ago is not
// re-fetched however many times it is asked for, so the worst a page script can do
// by posting `fresh` in a loop is one round of requests per run per five seconds —
// rather than one per message. It is the bound that lets the flag exist at all.
//
// Five seconds is short enough that a human who presses refresh gets something they
// would call fresh, and far enough below the TTL that the button is not decoration.
// The button disables itself for the same interval, so the rule the receiver
// enforces is the rule the reader can see.
export const FRESH_FLOOR_MS = 5_000;

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
    // Required, not optional. A message that does not say which mode it is asking
    // for is a message from a different build, and defaulting it here would make the
    // cache-bypassing mode the one you get by omission.
    if (typeof message['fresh'] !== 'boolean') return false;
    const runs = message['runs'];
    if (!Array.isArray(runs) || runs.length > MAX_RUNS_PER_REQUEST) return false;
    return runs.every((run) => {
        const entry = asObject(run);
        return typeof entry?.['workflowId'] === 'string' && typeof entry['runId'] === 'string';
    });
}

// SHAPE ONLY, for the same reason as above and with one extra sting in the tail:
// this message travels INTO the isolated world, which is the side that renders.
// Anything on the page can post a well-formed one. So the shape check below is
// deliberately total — every field, to the leaves — but it is still not provenance,
// and it never will be: `postMessage` carries no authenticated sender. What narrows
// forged and accidental traffic is the correlation check in rowInfoClient.ts, which
// keeps an answer only when this side asked that exact question. The worst a forged
// answer can then do is put a wrong event type or retry count in a row it was asked
// about; it cannot make a request, reach the network, or move a payload.
//
// Validating to the leaves is what makes the renderer's `RowInfo` honest. Before
// this, `lastEvent` was declared `LastEvent | null` and checked not at all, so
// `{lastEvent: 42}` type-checked its way to `event.eventType.length` in a template.
export function isRowInfoResult(value: unknown): value is RowInfoResult {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'row-info-result') return false;
    if (typeof message['namespace'] !== 'string' || !message['namespace']) return false;
    if (typeof message['workflowId'] !== 'string' || typeof message['runId'] !== 'string') return false;
    // Required, and NOT nullable. Every age on screen is measured against it, so a
    // message without it would either have to be dropped later or silently fall back
    // to Date.now() — which is the exact behaviour this field was added to remove.
    if (!isFiniteNumber(message['observedAtMs'])) return false;
    if (!isNullOr(message['error'], (error) => typeof error === 'string')) return false;
    if (!isNullOr(message['lastEvent'], isLastEvent)) return false;
    return isNullOr(message['retry'], isPendingRetry);
}

function isLastEvent(value: unknown): boolean {
    const event = asObject(value);
    if (!event) return false;
    if (typeof event['eventId'] !== 'string' || typeof event['eventType'] !== 'string') return false;
    return isNullOr(event['timeMs'], isFiniteNumber);
}

function isPendingRetry(value: unknown): boolean {
    const retry = asObject(value);
    if (!retry) return false;
    if (typeof retry['activityType'] !== 'string') return false;
    if (!isFiniteNumber(retry['attempt'])) return false;
    if (!isNullOr(retry['maximumAttempts'], isFiniteNumber)) return false;
    if (!isNullOr(retry['nextRetryAtMs'], isFiniteNumber)) return false;
    return isNullOr(retry['scheduledAtMs'], isFiniteNumber);
}

// `null` and only null — never `undefined`. An absent field is a different message
// from one that says "asked, and there is nothing", and the readers below already
// return the explicit null.
function isNullOr(value: unknown, ok: (value: unknown) => boolean): boolean {
    return value === null || ok(value);
}

// Rejects NaN and both infinities, which JSON.stringify would have turned into
// `null` anyway — so a number that survives a round-trip as a number is finite.
// Safe against our own serve: numberOf and timeToMs below return null, not NaN.
function isFiniteNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value);
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

// Exported because src/detail/detail.ts folds a history response too, and this is the
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

// EVERY AGE HERE IS FROZEN AT AN OBSERVATION, which is why the second argument of
// each of these is called asOfMs and why passing Date.now() to any of them is a bug.
//
// The value is measured against the instant the answer was READ (observedAtMs on the
// result), so it changes when — and only when — a newer answer arrives. Nothing in
// this extension animates an age. A number that advances on a timer says "I am
// watching this workflow"; this feature reads each running row at most every 35
// seconds, so the honest claim is about a past instant and the tooltip names it.
//
// TWO FORMATS, and the difference is how much room the caller has:
//
//   • formatAgePrecise — the "Last event" column. Exact to the second, because the
//     difference between 12s and 4m 12s of silence is the whole question the column
//     answers, and width-stable because it sits in a table.
//   • formatAge — the tooltips, where a compact "3m" is enough and the string
//     shares a line with other text. detailLinks.ts uses it for an activity's own
//     age, measured from a timestamp in the event history rather than from a reading
//     of one, and rounded to a whole minute — so that tooltip is rewritten at most
//     once a minute rather than once a render pass.
//
// Do not collapse them into one until that difference goes away.

// The two most significant units, seconds included: "47s", "3m 07s", "5h 12m",
// "3d 04h". Three decisions, none of them cosmetic:
//
//   • TWO UNITS, never three. "2d 05h 13m 09s" makes the column wide enough to push
//     the UI's own columns off the right-hand edge, and nobody reads the seconds on
//     a two-day-old event anyway.
//   • THE SMALLER UNIT IS ZERO-PADDED. Without it "3m 9s" and "3m 10s" are different
//     widths, so the column's width would depend on which rows are in it; tabular
//     figures fix the width of a digit, not the number of them.
//   • FLOOR, NOT ROUND. Rounding reports "1m 00s" for an event that is 59 seconds
//     old, and this number's one job is to never claim more silence than there was.
export function formatAgePrecise(timeMs: number | null, asOfMs: number): string {
    if (timeMs === null) return '—';
    const seconds = Math.floor((asOfMs - timeMs) / 1000);
    if (seconds <= 0) return 'now'; // a clock skew of a second or two is normal
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${padTwo(seconds % 60)}s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ${padTwo(minutes % 60)}m`;
    return `${Math.floor(hours / 24)}d ${padTwo(hours % 24)}h`;
}

function padTwo(value: number): string {
    return value < 10 ? `0${value}` : `${value}`;
}

// The compact form: "3m", "2h", "just now". No "ago" — whatever shows this says
// what it is, and the width is the point. Measured from a reading, like everything
// else here, EXCEPT where the timestamp itself is exact: retryBadgeTitle dates the
// string it goes into, while detailLinks.ts feeds this an activity's scheduled time
// straight out of the event history, which is the moment itself and not an
// observation of it — so that one needs no dating.
export function formatAge(timeMs: number | null, asOfMs: number): string {
    if (timeMs === null) return '—';
    const seconds = Math.round((asOfMs - timeMs) / 1000);
    if (seconds < 0) return 'now'; // a clock skew of a second or two is normal
    if (seconds < 10) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

// The title on the column's own cell. It uses the column's own format — a reader
// comparing the two would otherwise be told "3m 07s" in the cell and "3m ago" in the
// tooltip and have to work out which one to trust — and it is where the cell's number
// is DATED.
//
// That last part is the tooltip's real job. The cell has room for an age and nothing
// else, so on its own it cannot say which instant the age is measured from; a reader
// who assumes "now" would be wrong by up to one ask interval. So the title gives the
// reading's own timestamp, and says the number is frozen and how to move it. An
// as-of value that does not disclose its as-of is the thing this feature was
// criticised for, and it was a fair criticism.
export function lastEventTitle(event: LastEvent, asOfMs: number): string {
    const when = event.timeMs === null ? 'no timestamp' : new Date(event.timeMs).toISOString();
    return [
        `Last event #${event.eventId}: ${event.eventType}`,
        `at ${when}`,
        `${formatAgePrecise(event.timeMs, asOfMs)} old when this was read, at ${new Date(asOfMs).toISOString()}`,
        'Frozen at that reading — press ⟳ in the column header to ask Temporal again.',
    ].join('\n');
}

// "↻ 900" — the attempt count, because that single number is what separates "this
// activity failed once" from "this workflow has been stuck since yesterday".
export function retryBadgeLabel(retry: PendingRetry): string {
    return `↻ ${retry.attempt}`;
}

// The badge's title. Read the no-failure-message note at the top of this file
// before adding a line here: everything in this string has to be safe to show to
// somebody looking over the operator's shoulder.
//
// Its two relative times are measured from the reading, like the column's, and the
// last line dates them. "next attempt in 8s" is a statement about a moment that has
// already passed by the time anybody hovers, and without the date it would read as a
// countdown that had stopped.
export function retryBadgeTitle(retry: PendingRetry, asOfMs: number): string {
    const ceiling = retry.maximumAttempts === null ? 'unlimited' : `${retry.maximumAttempts}`;
    const lines = [`${retry.activityType} is retrying`, `attempt ${retry.attempt} of ${ceiling}`];
    if (retry.nextRetryAtMs !== null) lines.push(`next attempt ${formatWhen(retry.nextRetryAtMs, asOfMs)}`);
    if (retry.scheduledAtMs !== null) {
        lines.push(`this attempt scheduled ${formatAge(retry.scheduledAtMs, asOfMs)} ago`);
    }
    lines.push(`read at ${new Date(asOfMs).toISOString()}`);
    lines.push('(the failure message is deliberately not read — see src/rowInfo/rowInfo.ts)');
    return lines.join('\n');
}

function formatWhen(atMs: number, asOfMs: number): string {
    const seconds = Math.round((atMs - asOfMs) / 1000);
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
