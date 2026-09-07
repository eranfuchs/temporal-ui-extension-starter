// ONE workflow's own page: what can be known about it, and its activities,
// WITHOUT this extension asking Temporal anything at all.
//
// The purest piggyback in the repository. A workflow's page already fetches its
// history and already fetches DescribeWorkflowExecution — that is where its event
// list, its status and its pending-activity table come from — and both answers pass
// through the fetch wrapper this extension already installed. Reading them costs one
// clone and one parse.
//
// THE TWO RESPONSES ANSWER DIFFERENT QUESTIONS, AND THAT IS NOT AN ACCIDENT.
//
//   • HISTORY names every activity that has been SCHEDULED, with its id, its type
//     and the moment it was scheduled — including the ones that finished hours
//     ago, which are the ones somebody debugging usually wants a log link for.
//   • DESCRIBE is the only place a PENDING activity's attempt count exists. Temporal
//     deliberately does not write ActivityTaskStarted into the history until the
//     activity has completed or failed for the last time — "to avoid filling the
//     Event History with noise" — and points at the Describe API for a pending
//     attempt count instead: https://docs.temporal.io/encyclopedia/retry-policies
//
// So an activity retrying right now appears in the history as a bare
// ActivityTaskScheduled with no attempt count anywhere near it. That is the same fact
// that forces the list page's retry badge to call Describe (see the top of
// src/rowInfo/rowInfo.ts), and folding both responses into one shape is how the links
// end up with both halves.
//
// INVARIANT: no payload is read here. Every activity event carries `input`, `result`
// or `failure`, all of them application data and some of them encrypted; this fold
// walks straight past them, and what crosses the postMessage boundary is the reduced
// shape below and nothing else.
// Breaking it: reduce after crossing instead of at the boundary, and a "small" message
// quietly carries a customer's data onto the page bus.
//
// Everything in this file is pure. src/detail/detailWatch.ts does the observing (MAIN
// world) and src/detail/detailLinks.ts does the drawing (ISOLATED world).

import * as v from 'valibot';

import { eventsOf } from '../rowInfo/rowInfo';
import { simplifyStatus } from '../family/rows';
import type { DeepLinkActivity } from '../links/deepLink';
import { MESSAGE_SOURCE, type WorkflowRow } from '../types';

// ── Which workflow are we looking at ─────────────────────────────────────────

export interface DetailRef {
    namespace: string;
    workflowId: string;
    // null when the request did not name one. A history call without a run id is
    // answering about the latest run — see acceptFactsFor().
    runId: string | null;
}

// The run-id shape, in one place. Both readers below need it for the same reason
// render.ts::idsFromRow does: `/workflows/{id}/history` and
// `/workflows/{id}/{run}` are the same shape until you look at the last segment,
// and "history" is not a run id.
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRunId(value: string): boolean {
    return RUN_ID_RE.test(value);
}

// The workflow the PAGE is showing, from its own URL.
//
// Cloud: /namespaces/{ns}/workflows/{workflowId}/{runId}/timeline
// OSS:   /namespaces/{ns}/workflows/{workflowId}/{runId}/history
//
// Returns null for the list page and for `/workflows/{id}` with no run, because
// this feature needs a run: a workflow id can name several of them.
export function detailRefFromPath(pathname: string): DetailRef | null {
    const match = /\/namespaces\/([^/]+)\/workflows\/([^/?#]+)\/([^/?#]+)/.exec(pathname);
    if (!match) return null;
    const runId = decodeSafely(match[3]!);
    if (!isRunId(runId)) return null;
    return { namespace: decodeSafely(match[1]!), workflowId: decodeSafely(match[2]!), runId };
}

// The workflow an API URL is asking about, and which of the two answers it is.
//
// `null` means "not one of the two calls this file reads", which is also the
// signal not to look at the response — the same shape of decision as
// namespaceFromApiUrl() in rows.ts, and kept out of the MAIN-world file for the
// same reason: it is a rule about a URL, so it can be a pure function with tests.
//
// A schema rather than a bare union because the message at the bottom of this file
// carries the same two words across a postMessage, and one declaration is what keeps
// the wire and the reader from drifting apart.
export const detailSourceSchema = v.picklist(['history', 'describe']);
export type DetailSource = v.InferOutput<typeof detailSourceSchema>;

export function detailRefFromApiUrl(url: string): (DetailRef & { from: DetailSource }) | null {
    const match = /\/api\/v1\/namespaces\/([^/]+)\/workflows\/([^/?#]+)(\/history-reverse|\/history)?(\?|$)/.exec(url);
    if (!match) return null;
    const namespace = decodeSafely(match[1]!);
    const workflowId = decodeSafely(match[2]!);
    // No trailing route at all is DescribeWorkflowExecution: the workflow itself.
    const from: DetailSource = match[3] ? 'history' : 'describe';
    return { namespace, workflowId, runId: runIdFromQuery(url), from };
}

// `execution.runId` out of the query string, without constructing a URL — the
// page uses relative URLs on the OSS UI, and `new URL()` would need a base.
function runIdFromQuery(url: string): string | null {
    const match = /[?&]execution\.runId=([^&#]*)/.exec(url);
    if (!match) return null;
    const runId = decodeSafely(match[1]!);
    return isRunId(runId) ? runId : null;
}

function decodeSafely(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        // A malformed escape is not a reason to stop reading the page.
        return raw;
    }
}

// Is this message about the workflow on screen?
//
// The identity rule from judgeListResponse() in rows.ts, one page down: an answer
// about a DIFFERENT workflow must not be drawn onto this one. A single-page app
// keeps fetching after you navigate, so this is not hypothetical.
//
// A RUNLESS ANSWER IS ACCEPTED ONLY ON A RUNLESS PAGE, and that asymmetry is the
// correction to this function's first version, which accepted one anywhere.
//
// A request with no `execution.runId` means "the latest run of this workflow id",
// and the latest run is NOT necessarily the run on screen: open an older attempt of
// a retried workflow and the two differ. The old rule read "we are only watching
// the page's own request, so whatever came back is what the page is showing" — true
// of the page's own rendering, false of ours, because the URL we compare against is
// the run in the address bar, not whatever the app last asked for. On a run page a
// runless answer was folded straight into another run's links, with no marker that
// anything was mixed: an activity list belonging to attempt 12 under the heading of
// attempt 3.
//
// Rejecting it costs nothing in practice. The Temporal UI names the run on every
// history and describe call it makes from a run page — its own fetch omits
// `execution.runId` only when it was not given one — so the links are not starved by
// being strict here. And detailRefFromPath() above refuses a URL with no run id, so
// on the only page this feature draws on, `page.runId` is never null.
//
// Which is why the rule is plain equality rather than a special case for null: it
// pairs a runless answer with a runless page and refuses every other combination,
// including the one that used to slip through as `answer.runId === null ||`.
export function acceptFactsFor(page: DetailRef, answer: DetailRef): boolean {
    if (page.namespace !== answer.namespace) return false;
    if (page.workflowId !== answer.workflowId) return false;
    return answer.runId === page.runId;
}

// ── What we fold out of the two responses ────────────────────────────────────

// Where an activity got to, as far as the events read so far can tell.
//
// 'open' is not "running": it means no terminal event for this activity has been
// read yet, which on a history page that has not finished loading is the answer
// for everything near the end of the list.
export const activityOutcomeSchema = v.picklist(['open', 'completed', 'failed', 'timedOut', 'cancelled']);
export type ActivityOutcome = v.InferOutput<typeof activityOutcomeSchema>;

// `number | null` throughout, with the key REQUIRED: v.nullable() accepts null and
// refuses an absent key, which is the distinction the readers rely on — null means
// "read, and not there", absent means "this came from something that is not us".
// finite() is spelled out because v.number() accepts both infinities, and an
// Infinity in a timestamp would format as a date and compare as an eternity.
const finiteNumber = v.pipe(v.number(), v.finite());

// A schema rather than an interface because this shape is BOTH folded here and
// received over a postMessage in detailLinks.ts, and one declaration cannot drift
// from the other. See the note on detailFactsMessageSchema at the bottom of the file
// for why the leaves are described and not just the envelope.
export const detailActivitySchema = v.object({
    // The id of the ActivityTaskScheduled event, which is how every later event
    // refers back to this activity, and the number the Temporal UI shows beside
    // it. int64 in the proto, therefore a string in JSON (see rowInfo.ts).
    scheduledEventId: v.string(),
    // Empty until the ActivityTaskScheduled event itself has been read. A page of
    // history can carry an activity's later events without its first one, so the
    // entry is kept rather than dropped — dropping it would lose the attempt count
    // when the earlier page arrives. linkableActivities() filters instead.
    activityId: v.string(),
    activityType: v.string(),
    // null when unknown, which for a PENDING activity is the normal state: the
    // history has no attempt count for one. Describe supplies it.
    attempt: v.nullable(finiteNumber),
    scheduledAtMs: v.nullable(finiteNumber),
    // When the terminal event for this activity was written, null while it is still
    // open. This is what turns a log query into a link about ONE execution of an
    // activity rather than about every execution of its type: the pair
    // (scheduledAtMs, closedAtMs) is a window no other instance shares, even when
    // the workflow ran the same activity type twenty times.
    closedAtMs: v.nullable(finiteNumber),
    outcome: activityOutcomeSchema,
    // True when this came from Describe's `pendingActivities` — the activity is
    // pending right now. Shown beside the links, because "attempt 900, pending" and
    // "attempt 900, finished eventually" are different situations.
    pending: v.boolean(),
});
export type DetailActivity = v.InferOutput<typeof detailActivitySchema>;

// A workflow with a hundred thousand events has thousands of activities, and the map
// this bounds lives for as long as the tab is on the page. Same reasoning as
// MAX_LEDGER_ENTRIES in pageApi.ts: the bound is generous, crude and stated.
// The NEWEST are kept, because they are the ones somebody is looking at.
//
// State the cost, because it is paid silently: on a workflow that exceeds this, an
// OLD activity's panel gets no link, and "no link" looks exactly like a broken
// selector. Nothing in the panel can say why. The popup therefore says out loud when
// the cap is in effect — it is the only place a reader can tell an evicted activity
// from a stale anchor.
export const MAX_ACTIVITIES = 500;

export const detailFactsSchema = v.object({
    // From WorkflowExecutionStarted, or from Describe. null = not read yet, and
    // the token that needs it is reported unknown rather than guessed.
    workflowType: v.nullable(v.string()),
    taskQueue: v.nullable(v.string()),
    startTimeMs: v.nullable(finiteNumber),
    endTimeMs: v.nullable(finiteNumber),
    // Simplified in the same vocabulary as the list page's rows ("Running",
    // "TimedOut", …) so `{status}` means the same thing in both scopes.
    status: v.nullable(v.string()),
    // Bounded HERE, on the shape itself, rather than only in capActivities() where
    // our own fold applies it: this shape also arrives over a postMessage, and a
    // bound that only the honest producer keeps is not a bound.
    activities: v.pipe(v.array(detailActivitySchema), v.maxLength(MAX_ACTIVITIES)),
    // The most events any ONE response has carried — a floor, and NOT a running
    // total, which is what this said until it was read against mergeFacts(): that
    // takes Math.max, because the UI re-fetches the same first page on every
    // re-mount and a sum reports a history several times the size of the workflow.
    // The cost of the max is that paged history counts the biggest page rather than
    // all of them, so the number UNDER-states what the activity list was folded
    // from. Under-stating is the right direction for a scope disclosure and it is
    // why the wording on the page is "at least" — the UI pages history lazily, so
    // some number has to be shown, and the honest one is a lower bound.
    eventsSeen: finiteNumber,
});
export type DetailFacts = v.InferOutput<typeof detailFactsSchema>;

export const NO_FACTS: DetailFacts = {
    workflowType: null,
    taskQueue: null,
    startTimeMs: null,
    endTimeMs: null,
    status: null,
    activities: [],
    eventsSeen: 0,
};

// ── The history fold ─────────────────────────────────────────────────────────

// Keyed by ATTRIBUTE NAME rather than by `eventType`, deliberately. The type
// string arrives in two spellings depending on the server version
// ("ActivityTaskCompleted" and "EVENT_TYPE_ACTIVITY_TASK_COMPLETED" — see
// prettyEventType in rowInfo.ts), while the attribute key that carries the event's
// own fields is the same in both. Reading the key is one lookup and cannot be
// wrong about the spelling.
const WORKFLOW_CLOSED_BY_ATTRIBUTE: Record<string, string> = {
    workflowExecutionCompletedEventAttributes: 'Completed',
    workflowExecutionFailedEventAttributes: 'Failed',
    workflowExecutionTimedOutEventAttributes: 'TimedOut',
    workflowExecutionCanceledEventAttributes: 'Canceled',
    workflowExecutionTerminatedEventAttributes: 'Terminated',
    workflowExecutionContinuedAsNewEventAttributes: 'ContinuedAsNew',
};

const ACTIVITY_OUTCOME_BY_ATTRIBUTE: Record<string, ActivityOutcome> = {
    activityTaskCompletedEventAttributes: 'completed',
    activityTaskFailedEventAttributes: 'failed',
    activityTaskTimedOutEventAttributes: 'timedOut',
    activityTaskCanceledEventAttributes: 'cancelled',
};

export function readHistoryFacts(body: unknown): DetailFacts {
    const events = eventsOf(body);
    if (!events) return NO_FACTS;

    const facts: DetailFacts = { ...NO_FACTS, activities: [], eventsSeen: events.length };
    const activities = new Map<string, DetailActivity>();

    for (const raw of events) {
        const event = asObject(raw);
        if (!event) continue;
        const eventId = idOf(event['eventId']);
        const atMs = timeToMs(event['eventTime']);

        const started = asObject(event['workflowExecutionStartedEventAttributes']);
        if (started) {
            facts.workflowType = textOf(asObject(started['workflowType'])?.['name']);
            facts.taskQueue = textOf(asObject(started['taskQueue'])?.['name']);
            facts.startTimeMs = atMs;
        }

        const closedStatus = Object.keys(WORKFLOW_CLOSED_BY_ATTRIBUTE).find((key) => asObject(event[key]));
        if (closedStatus) {
            facts.status = WORKFLOW_CLOSED_BY_ATTRIBUTE[closedStatus]!;
            facts.endTimeMs = atMs;
        }

        const scheduled = asObject(event['activityTaskScheduledEventAttributes']);
        if (scheduled && eventId) {
            const entry = entryFor(activities, eventId);
            entry.activityId = textOf(scheduled['activityId']) ?? '';
            entry.activityType = textOf(asObject(scheduled['activityType'])?.['name']) ?? '';
            entry.scheduledAtMs = atMs;
            continue;
        }

        // Every event below refers to its activity by the id of the event that
        // scheduled it, never by activityId — two activities in one workflow may
        // share an activityId if the workflow code reuses one.
        const startedActivity = asObject(event['activityTaskStartedEventAttributes']);
        if (startedActivity) {
            const key = idOf(startedActivity['scheduledEventId']);
            // Present only once the activity has finished retrying, which is why an
            // attempt count from here is a HISTORICAL fact and not a live one.
            if (key) entryFor(activities, key).attempt = numberOf(startedActivity['attempt']);
            continue;
        }

        const outcomeKey = Object.keys(ACTIVITY_OUTCOME_BY_ATTRIBUTE).find((key) => asObject(event[key]));
        if (outcomeKey) {
            const key = idOf(asObject(event[outcomeKey])?.['scheduledEventId']);
            // NOT the failure or the result: `activityTaskFailedEventAttributes`
            // carries `failure`, and `…Completed` carries `result`. Both are
            // application data and neither is read — same rule as rowInfo.ts. The
            // event's own TIME is not application data, and it is the end of this
            // activity's window.
            if (key) {
                const entry = entryFor(activities, key);
                entry.outcome = ACTIVITY_OUTCOME_BY_ATTRIBUTE[outcomeKey]!;
                entry.closedAtMs = atMs;
            }
        }
    }

    facts.activities = capActivities(Array.from(activities.values()));
    return facts;
}

// ── The describe fold ────────────────────────────────────────────────────────

// DescribeWorkflowExecution: the exact workflow facts, plus the activities that
// are pending RIGHT NOW with their live attempt counts.
//
// `pendingActivities[].lastFailure` is right there and is not read, for the reason
// spelled out at the top of src/rowInfo/rowInfo.ts: a failure message is application data.
// Nothing here shows more than the list page's badge does.
export function readDescribeFacts(body: unknown): DetailFacts {
    const root = asObject(body);
    if (!root) return NO_FACTS;
    const info = asObject(root['workflowExecutionInfo']);
    const facts: DetailFacts = { ...NO_FACTS, activities: [] };

    if (info) {
        facts.workflowType = textOf(asObject(info['type'])?.['name']);
        facts.startTimeMs = timeToMs(info['startTime']);
        facts.endTimeMs = timeToMs(info['closeTime']);
        const status = textOf(info['status']);
        facts.status = status ? simplifyStatus(status) : null;
        // The task queue is in executionConfig, not in workflowExecutionInfo. Both
        // spellings of the nesting have been seen in the wild, so try each rather
        // than reporting no task queue on one of them.
        facts.taskQueue =
            textOf(asObject(asObject(root['executionConfig'])?.['taskQueue'])?.['name']) ??
            textOf(asObject(info['taskQueue'])?.['name']);
    }

    const pending = root['pendingActivities'];
    if (Array.isArray(pending)) {
        const activities: DetailActivity[] = [];
        for (const raw of pending) {
            const entry = asObject(raw);
            if (!entry) continue;
            const key = idOf(entry['scheduledEventId']);
            if (!key) continue;
            activities.push({
                scheduledEventId: key,
                activityId: textOf(entry['activityId']) ?? '',
                activityType: textOf(asObject(entry['activityType'])?.['name']) ?? '',
                attempt: numberOf(entry['attempt']),
                scheduledAtMs: timeToMs(entry['scheduledTime']),
                // A pending activity has not closed, by definition.
                closedAtMs: null,
                outcome: 'open',
                pending: true,
            });
        }
        facts.activities = capActivities(activities);
    }
    return facts;
}

// ── Putting the two together ─────────────────────────────────────────────────

// Later beats earlier for a scalar, and known beats unknown.
//
// The order the two responses arrive in is not ours to choose — Describe is a
// single small call and history is paged, so either can win — and neither is
// "the truth" on its own: Describe knows the status, history knows the activities
// that have finished. A merge that let a null overwrite a value would make the
// links flicker between complete and half-empty on every poll of the page.
export function mergeFacts(base: DetailFacts, next: DetailFacts): DetailFacts {
    const activities = new Map<string, DetailActivity>();
    for (const activity of [...base.activities, ...next.activities]) {
        const previous = activities.get(activity.scheduledEventId);
        activities.set(activity.scheduledEventId, previous ? combine(previous, activity) : activity);
    }
    return {
        workflowType: next.workflowType ?? base.workflowType,
        taskQueue: next.taskQueue ?? base.taskQueue,
        startTimeMs: next.startTimeMs ?? base.startTimeMs,
        endTimeMs: next.endTimeMs ?? base.endTimeMs,
        status: next.status ?? base.status,
        activities: capActivities(Array.from(activities.values())),
        // The larger of the two, not the sum: the UI re-fetches the same first
        // page whenever the view is re-mounted, and adding those up would report a
        // history several times the size of the workflow.
        eventsSeen: Math.max(base.eventsSeen, next.eventsSeen),
    };
}

function combine(previous: DetailActivity, next: DetailActivity): DetailActivity {
    return {
        scheduledEventId: previous.scheduledEventId,
        activityId: next.activityId || previous.activityId,
        activityType: next.activityType || previous.activityType,
        attempt: next.attempt ?? previous.attempt,
        scheduledAtMs: next.scheduledAtMs ?? previous.scheduledAtMs,
        closedAtMs: next.closedAtMs ?? previous.closedAtMs,
        // A terminal outcome never goes back to 'open'. Describe reports a pending
        // activity as open, and it arrives after the history page that saw the same
        // activity finish whenever the workflow closed between the two calls.
        outcome: next.outcome === 'open' ? previous.outcome : next.outcome,
        // …and for the same reason, "pending" is dropped as soon as anything says
        // the activity finished.
        pending: next.outcome === 'open' && previous.outcome === 'open' && (next.pending || previous.pending),
    };
}

// Newest first, capped. An activity we have never seen scheduled has no id and no
// type, so there is nothing to build a link from — it stays in the fold (its
// attempt count is real) and is filtered out here.
export function linkableActivities(facts: DetailFacts): DetailActivity[] {
    return facts.activities
        .filter((activity) => activity.activityType !== '' || activity.activityId !== '')
        .sort((a, b) => Number(b.scheduledEventId) - Number(a.scheduledEventId));
}

// ── Matching what the page shows to what we folded ───────────────────────────

// The page renders an activity's own panel with a row labelled "Activity Id". That
// string is the handle the DOM gives us, and this turns it into one activity.
//
// WHY THE ID AND NOT THE TYPE. The first version of the links on this page were
// keyed on `{activityType}`, and a type is not an identity: a workflow that calls
// `chargeCard` three times has three activities with that type, so a link built
// from it opens a log search matching all three — or, worse, matching the wrong
// one and looking right. An id is unique per activity within a run, so it is what
// the link is keyed on, and the WINDOW below (scheduledAtMs → closedAtMs) narrows
// it further for a log backend that indexes the type but not the id, which is the
// common case.
//
// TWO KEYS, IN THIS ORDER, and the order is the whole subtlety:
//
//  1. `activityId` — the field the panel is literally labelled with.
//  2. `scheduledEventId` — because Temporal's DEFAULT activityId is the id of the
//     ActivityTaskScheduled event, rendered as the same digits. A fold that saw an
//     activity's later events but not its scheduled event has no activityId for it
//     (see the comment on DetailActivity.activityId), and this still matches it.
//
// An activityId is caller-chosen, so it can repeat within one run — the workflow
// decides. `ambiguous` says so rather than picking silently; the caller puts it in
// the link's title, because "this link may be about a different attempt" is
// something the person clicking it needs to know and cannot otherwise find out.
export interface ActivityMatch {
    activity: DetailActivity;
    by: 'activityId' | 'scheduledEventId';
    ambiguous: boolean;
}

export function activityByPanelId(facts: DetailFacts, panelId: string): ActivityMatch | null {
    const id = panelId.trim();
    if (!id) return null;
    // Newest first, so the newest is what an ambiguous id resolves to: on a page
    // somebody is debugging, the latest attempt is the one being looked at.
    const byActivityId = linkableActivities(facts).filter((activity) => activity.activityId === id);
    if (byActivityId.length > 0) {
        return { activity: byActivityId[0]!, by: 'activityId', ambiguous: byActivityId.length > 1 };
    }
    const byEvent = facts.activities.find((activity) => activity.scheduledEventId === id);
    // A scheduledEventId is unique by construction — it IS an event id — so a match
    // here is never ambiguous.
    return byEvent ? { activity: byEvent, by: 'scheduledEventId', ambiguous: false } : null;
}

function capActivities(activities: DetailActivity[]): DetailActivity[] {
    if (activities.length <= MAX_ACTIVITIES) return activities;
    return activities
        .slice()
        .sort((a, b) => Number(b.scheduledEventId) - Number(a.scheduledEventId))
        .slice(0, MAX_ACTIVITIES);
}

// The activity as a deep-link context. Separate from DetailActivity because the
// link vocabulary must not grow a field just because this fold has one: `outcome`
// and `pending` are for the label to show, not for a URL to carry.
export function activityForLink(activity: DetailActivity): DeepLinkActivity {
    return {
        scheduledEventId: activity.scheduledEventId,
        activityId: activity.activityId,
        activityType: activity.activityType,
        attempt: activity.attempt,
        scheduledAtMs: activity.scheduledAtMs,
        closedAtMs: activity.closedAtMs,
    };
}

// The workflow as a list-page row, so that every workflow-scoped token resolves
// on this page exactly as it does in the table. One shape, one resolver, two
// pages — the alternative is a second switch statement that agrees with the first
// until somebody edits one of them.
//
// null UNTIL THE START TIME IS KNOWN, which is the one field there is no honest
// default for. WorkflowRow.startTimeMs is a number, so a missing start time would
// have to become 0, and `{startTimeIso}` would then expand to 1970 — a link that
// looks exactly like a working one and returns nothing. Waiting costs at most one
// round trip: a workflow's page fetches DescribeWorkflowExecution to draw its own
// header, and that answer always carries a start time.
export function rowFromFacts(ref: DetailRef, facts: DetailFacts): WorkflowRow | null {
    if (facts.startTimeMs === null) return null;
    return {
        workflowId: ref.workflowId,
        runId: ref.runId ?? '',
        workflowType: facts.workflowType ?? '(unknown)',
        // No close time and no terminal event means still open as far as anything
        // read so far can tell, which is the same reading the list page gives.
        status: facts.status ?? (facts.endTimeMs === null ? 'Running' : 'Unknown'),
        startTimeMs: facts.startTimeMs,
        endTimeMs: facts.endTimeMs,
        parentWorkflowId: null,
        parentRunId: null,
        // No list response here to name one, and no page-local siblings to walk
        // to either — a single workflow's own page knows only its own id. Same
        // self-fallback family/rows.ts's resolveLocalRoots() reaches for a true
        // root, for the same reason: it is the honest answer, not a guess.
        rootWorkflowId: ref.workflowId,
        taskQueue: facts.taskQueue,
        depth: 0,
        segments: [],
    };
}

// ── The message ──────────────────────────────────────────────────────────────

// SHAPE ONLY, and the same warning as every other boundary schema in this project:
// parsing it says the message is well-formed and nothing whatever about who sent it.
// Any script on the page can post one.
//
// What a forged one can do is worth being precise about, because unlike the
// row-info request it reaches no credential and starts no fetch — this feature
// only ever reads. It can put a chosen string in a link's label (written with
// textContent, so it is text and stays text) and in the QUERY part of a link the
// user has already configured. It cannot change that link's origin: the template's
// own text supplies the scheme and host, the expansion percent-encodes by default,
// and safeHref() re-checks the result. The honest summary is "a page that is
// already running script can make these links say something untrue", which is true
// of every extension that renders page data.
//
// It describes the facts TO THE LEAVES, which the hand-written guard it replaced did
// not: that one checked four envelope fields and `scheduledEventId` on each activity,
// then cast the rest, so a forged `outcome: 'exploded'` or `attempt: 'lots'` reached
// the renderer typed as something it was not. Nothing visibly broke, which is the
// problem with a cast — see
// docs/design-notes.md#the-guard-that-checked-the-envelope-and-cast-the-rest.
export const detailFactsMessageSchema = v.object({
    source: v.literal(MESSAGE_SOURCE),
    type: v.literal('detail-facts'),
    from: detailSourceSchema,
    namespace: v.pipe(v.string(), v.minLength(1)),
    workflowId: v.pipe(v.string(), v.minLength(1)),
    // Present and nullable: a history call that named no run is answering about the
    // latest one, and acceptFactsFor() treats that differently from a mismatch.
    runId: v.nullable(v.string()),
    facts: detailFactsSchema,
});
export type DetailFactsMessage = v.InferOutput<typeof detailFactsMessageSchema>;

// ── Small readers ────────────────────────────────────────────────────────────
//
// Deliberate duplicates of the ones in rowInfo.ts, and the line to draw is which
// of them encodes a FACT ABOUT TEMPORAL. `eventsOf` does — the history array is
// nested under `history` on some responses and bare on others — so it is imported
// from rowInfo.ts rather than copied, because a copy could disagree. These four
// are local convenience: "is this an object", "is this a non-empty string". A
// shared module of untyped readers would make both files depend on a shape neither
// of them owns, to save a handful of lines.
//
// They read a TEMPORAL API RESPONSE, which is why they are not schemas: the folds
// below walk a shape whose useful parts are three levels down inside a union of
// event attributes, and pick single fields out of it. A schema for that response
// would be a transcription of the server's proto, most of it never read.

function asObject(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
}

// An event id is an int64 and therefore a JSON string, but a hand-written fixture
// and some proxies send a number. Normalised to a string here, because it is used
// as a map key: `12` and `'12'` are two different keys and would split one
// activity into two entries.
function idOf(value: unknown): string | null {
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

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

function entryFor(activities: Map<string, DetailActivity>, scheduledEventId: string): DetailActivity {
    const existing = activities.get(scheduledEventId);
    if (existing) return existing;
    const fresh: DetailActivity = {
        scheduledEventId,
        activityId: '',
        activityType: '',
        attempt: null,
        scheduledAtMs: null,
        closedAtMs: null,
        outcome: 'open',
        pending: false,
    };
    activities.set(scheduledEventId, fresh);
    return fresh;
}
