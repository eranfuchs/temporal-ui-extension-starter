// The pure half of the detail-page feature: which URLs are read, what is folded
// out of them, and what is deliberately NOT folded out of them.
//
// Every fixture here is hand-written and every id is invented. The shapes come
// from Temporal's own API documentation for GetWorkflowExecutionHistory and
// DescribeWorkflowExecution.

import { describe, expect, it } from 'vitest';

import {
    acceptFactsFor,
    activityByPanelId,
    detailRefFromApiUrl,
    detailRefFromPath,
    isDetailFactsMessage,
    linkableActivities,
    MAX_ACTIVITIES,
    mergeFacts,
    NO_FACTS,
    readDescribeFacts,
    readHistoryFacts,
    rowFromFacts,
    type DetailActivity,
    type DetailFacts,
} from '../../src/detail';
import { expandTemplate } from '../../src/deepLink';
import { fakeRunId } from '../helpers';
import { MESSAGE_SOURCE } from '../../src/types';

const RUN = fakeRunId(701);
const OTHER_RUN = fakeRunId(702);
const NS = 'sample-namespace';

// ── URLs ─────────────────────────────────────────────────────────────────────

describe('detailRefFromPath', () => {
    it('reads the workflow and run out of a detail page URL, on Cloud and on OSS', () => {
        expect(detailRefFromPath(`/namespaces/${NS}/workflows/order-42/${RUN}/timeline`)).toEqual({
            namespace: NS,
            workflowId: 'order-42',
            runId: RUN,
        });
        expect(detailRefFromPath(`/namespaces/${NS}/workflows/order-42/${RUN}/history`)).toEqual({
            namespace: NS,
            workflowId: 'order-42',
            runId: RUN,
        });
    });

    it('single-decodes a workflow id that needed encoding', () => {
        const ref = detailRefFromPath(`/namespaces/${NS}/workflows/order%2F42%7Ca/${RUN}/history`);
        expect(ref?.workflowId).toBe('order/42|a');
    });

    it('is null anywhere there is no run to talk about', () => {
        // The list page, and a workflow URL with no run segment. A workflow id can
        // name several runs, so a card built for "the workflow" would be a card
        // built for whichever run the page happens to be showing.
        expect(detailRefFromPath(`/namespaces/${NS}/workflows`)).toBeNull();
        expect(detailRefFromPath(`/namespaces/${NS}/workflows/order-42`)).toBeNull();
        // 'history' is not a run id, which is the case that makes this a shape test
        // and not a "third segment" test.
        expect(detailRefFromPath(`/namespaces/${NS}/workflows/order-42/history`)).toBeNull();
    });
});

describe('detailRefFromApiUrl', () => {
    it('recognises the two calls a workflow page makes about itself', () => {
        expect(
            detailRefFromApiUrl(
                `https://tenant.example.com/api/v1/namespaces/${NS}/workflows/order-42/history?maximumPageSize=100&execution.runId=${RUN}`,
            ),
        ).toEqual({ namespace: NS, workflowId: 'order-42', runId: RUN, from: 'history' });

        expect(
            detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflows/order-42?execution.runId=${RUN}`),
        ).toEqual({ namespace: NS, workflowId: 'order-42', runId: RUN, from: 'describe' });

        expect(
            detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflows/order-42/history-reverse?execution.runId=${RUN}`)
                ?.from,
        ).toBe('history');
    });

    it('leaves the workflow LIST alone', () => {
        // The list is the other watcher's business, and it is the one that fills the
        // ledger. Overlap would mean two answers to "who read this response".
        expect(detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflows?query=`)).toBeNull();
        expect(detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflows`)).toBeNull();
    });

    it('ignores the routes that are not about one workflow', () => {
        // The count route is a sibling of `namespaces`, not a child of `workflows`,
        // so it cannot be mistaken for a workflow id — and an action route has a
        // segment after the id, which this deliberately does not match.
        expect(detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflow-count?query=`)).toBeNull();
        expect(detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflows/order-42/terminate`)).toBeNull();
        expect(detailRefFromApiUrl('/api/v1/namespaces')).toBeNull();
        expect(detailRefFromApiUrl('https://example.com/anything/else')).toBeNull();
    });

    it('reports no run id when the request did not name one', () => {
        expect(detailRefFromApiUrl(`/api/v1/namespaces/${NS}/workflows/order-42`)?.runId).toBeNull();
    });
});

describe('acceptFactsFor', () => {
    const page = { namespace: NS, workflowId: 'order-42', runId: RUN };

    it('accepts an answer about the workflow on screen', () => {
        expect(acceptFactsFor(page, { namespace: NS, workflowId: 'order-42', runId: RUN })).toBe(true);
    });

    it('refuses an answer that named no run while the page names one', () => {
        // A request without `execution.runId` asks for the LATEST run, which on a
        // retried workflow is not the run in the address bar. This test's ancestor
        // asserted the opposite and was titled "because the page did not either" —
        // while passing a page that did. Two runs' facts merged into one card, with
        // nothing on screen to say so.
        expect(acceptFactsFor(page, { namespace: NS, workflowId: 'order-42', runId: null })).toBe(false);
    });

    it('accepts an answer that named no run when the page names none either', () => {
        // The other half, so this is a rule about matching rather than a blanket
        // refusal: a workflow-scoped view asks runless questions and gets runless
        // answers, and those belong together.
        const runless = { namespace: NS, workflowId: 'order-42', runId: null };
        expect(acceptFactsFor(runless, { namespace: NS, workflowId: 'order-42', runId: null })).toBe(true);
        // …and a run-specific answer still does not belong on a runless page: it may
        // be any run of that workflow, not the one the page would have shown.
        expect(acceptFactsFor(runless, { namespace: NS, workflowId: 'order-42', runId: RUN })).toBe(false);
    });

    it('refuses another run, another workflow and another namespace', () => {
        // A single-page app keeps fetching after you navigate. Drawing another
        // workflow's activities onto this one is the failure this rule prevents.
        expect(acceptFactsFor(page, { namespace: NS, workflowId: 'order-42', runId: OTHER_RUN })).toBe(false);
        expect(acceptFactsFor(page, { namespace: NS, workflowId: 'order-43', runId: RUN })).toBe(false);
        expect(acceptFactsFor(page, { namespace: 'other', workflowId: 'order-42', runId: RUN })).toBe(false);
    });
});

// ── The history fold ─────────────────────────────────────────────────────────

function event(eventId: number, eventTime: string, attributes: Record<string, unknown>): Record<string, unknown> {
    return { eventId: String(eventId), eventTime, ...attributes };
}

const STARTED = event(1, '2026-01-01T10:00:00Z', {
    eventType: 'WorkflowExecutionStarted',
    workflowExecutionStartedEventAttributes: {
        workflowType: { name: 'ProcessOrder' },
        taskQueue: { name: 'orders' },
        // Present in the real event and deliberately not read.
        input: { payloads: [{ metadata: { encoding: 'YmluYXJ5L2VuY3J5cHRlZA==' }, data: 'c2VjcmV0' }] },
    },
});

const SCHEDULED = event(5, '2026-01-01T10:00:05Z', {
    eventType: 'ActivityTaskScheduled',
    activityTaskScheduledEventAttributes: {
        activityId: 'charge-1',
        activityType: { name: 'ChargeCard' },
        input: { payloads: [{ data: 'c2VjcmV0' }] },
    },
});

describe('readHistoryFacts', () => {
    it('folds the workflow facts and the activities, and reads no payload', () => {
        const facts = readHistoryFacts({
            history: {
                events: [
                    STARTED,
                    SCHEDULED,
                    event(6, '2026-01-01T10:00:06Z', {
                        eventType: 'ActivityTaskStarted',
                        activityTaskStartedEventAttributes: { scheduledEventId: '5', attempt: 3 },
                    }),
                    event(7, '2026-01-01T10:00:07Z', {
                        eventType: 'ActivityTaskCompleted',
                        activityTaskCompletedEventAttributes: {
                            scheduledEventId: '5',
                            result: { payloads: [{ data: 'c2VjcmV0' }] },
                        },
                    }),
                ],
            },
        });

        expect(facts.workflowType).toBe('ProcessOrder');
        expect(facts.taskQueue).toBe('orders');
        expect(facts.startTimeMs).toBe(Date.parse('2026-01-01T10:00:00Z'));
        expect(facts.status).toBeNull(); // no terminal event in this page
        expect(facts.eventsSeen).toBe(4);
        expect(facts.activities).toEqual([
            {
                scheduledEventId: '5',
                activityId: 'charge-1',
                activityType: 'ChargeCard',
                attempt: 3,
                scheduledAtMs: Date.parse('2026-01-01T10:00:05Z'),
                // The pair (scheduledAtMs, closedAtMs) is this ONE execution's window,
                // read off the scheduling event and the terminal event. It is what lets
                // a link about an activity be a link about an activity rather than
                // about every execution of its type — see the note on closedAtMs in
                // src/detail.ts.
                closedAtMs: Date.parse('2026-01-01T10:00:07Z'),
                outcome: 'completed',
                pending: false,
            },
        ]);
        // The proof of the rule at the top of detail.ts: whatever else is in the
        // fold, no payload is. Anything that carried one would show up as a string
        // of base64 in here.
        expect(JSON.stringify(facts)).not.toContain('c2VjcmV0');
    });

    it('reads the attribute key, not the event-type string', () => {
        // Both spellings are real, from two Temporal versions. The fold keys off
        // `activityTaskScheduledEventAttributes`, which is identical in both, so a
        // server that sends the enum form is not a server this feature is blind to.
        const facts = readHistoryFacts({
            events: [
                { ...STARTED, eventType: 'EVENT_TYPE_WORKFLOW_EXECUTION_STARTED' },
                { ...SCHEDULED, eventType: 'EVENT_TYPE_ACTIVITY_TASK_SCHEDULED' },
            ],
        });
        expect(facts.workflowType).toBe('ProcessOrder');
        expect(facts.activities[0]?.activityType).toBe('ChargeCard');
    });

    it('records how a workflow closed, in the list page’s own status vocabulary', () => {
        const facts = readHistoryFacts({
            events: [
                STARTED,
                event(9, '2026-01-01T10:05:00Z', {
                    eventType: 'WorkflowExecutionTimedOut',
                    workflowExecutionTimedOutEventAttributes: { retryState: 'RETRY_STATE_TIMEOUT' },
                }),
            ],
        });
        // "TimedOut", the same string simplifyStatus() produces for the table, so
        // {status} means one thing across both scopes.
        expect(facts.status).toBe('TimedOut');
        expect(facts.endTimeMs).toBe(Date.parse('2026-01-01T10:05:00Z'));
    });

    it('keeps an activity whose scheduling event is on another page', () => {
        // A history page that starts mid-workflow carries an ActivityTaskStarted
        // with no ActivityTaskScheduled before it. Dropping that entry would throw
        // away the attempt count, which is the whole point of reading it; it is kept
        // without identity and filtered out of the rendered list instead.
        const facts = readHistoryFacts({
            events: [
                event(6, '2026-01-01T10:00:06Z', {
                    activityTaskStartedEventAttributes: { scheduledEventId: '5', attempt: 4 },
                }),
            ],
        });
        expect(facts.activities).toHaveLength(1);
        expect(facts.activities[0]).toMatchObject({ scheduledEventId: '5', attempt: 4, activityType: '' });
        expect(linkableActivities(facts)).toEqual([]);
    });

    it('has nothing to say about a body that is not a history', () => {
        for (const body of [null, undefined, {}, { history: {} }, { events: 'no' }, 42]) {
            expect(readHistoryFacts(body)).toEqual(NO_FACTS);
        }
    });

    it('caps the activities it reports', () => {
        const events = [];
        for (let i = 1; i <= MAX_ACTIVITIES + 10; i++) {
            events.push(
                event(i, '2026-01-01T10:00:00Z', {
                    activityTaskScheduledEventAttributes: { activityId: `a-${i}`, activityType: { name: 'Step' } },
                }),
            );
        }
        const facts = readHistoryFacts({ events });
        expect(facts.activities).toHaveLength(MAX_ACTIVITIES);
        // The NEWEST are the ones kept: a card on a long workflow is about what is
        // happening now.
        expect(facts.activities.map((a) => a.scheduledEventId)).toContain(String(MAX_ACTIVITIES + 10));
        expect(facts.activities.map((a) => a.scheduledEventId)).not.toContain('1');
    });
});

// ── The describe fold ────────────────────────────────────────────────────────

describe('readDescribeFacts', () => {
    const body = {
        workflowExecutionInfo: {
            execution: { workflowId: 'order-42', runId: RUN },
            type: { name: 'ProcessOrder' },
            status: 'WORKFLOW_EXECUTION_STATUS_RUNNING',
            startTime: '2026-01-01T10:00:00Z',
            closeTime: null,
        },
        executionConfig: { taskQueue: { name: 'orders' } },
        pendingActivities: [
            {
                activityId: 'charge-1',
                activityType: { name: 'ChargeCard' },
                state: 'PENDING_ACTIVITY_STATE_BACKOFF',
                attempt: 900,
                scheduledEventId: '5',
                scheduledTime: '2026-01-01T11:00:00Z',
                // The reason this feature exists next to a rule about not reading
                // it. See the note at the top of src/rowInfo.ts.
                lastFailure: { message: 'card ending 4321 declined for customer 55123' },
            },
        ],
    };

    it('takes the exact workflow facts and the LIVE attempt count', () => {
        const facts = readDescribeFacts(body);
        expect(facts.status).toBe('Running');
        expect(facts.workflowType).toBe('ProcessOrder');
        expect(facts.taskQueue).toBe('orders');
        expect(facts.startTimeMs).toBe(Date.parse('2026-01-01T10:00:00Z'));
        expect(facts.endTimeMs).toBeNull();
        expect(facts.activities).toEqual([
            {
                scheduledEventId: '5',
                activityId: 'charge-1',
                activityType: 'ChargeCard',
                attempt: 900,
                scheduledAtMs: Date.parse('2026-01-01T11:00:00Z'),
                // A pending activity has not closed, and this stays null rather than
                // becoming "now": a window that ends at the moment the link was drawn
                // would quietly exclude everything the activity does next.
                closedAtMs: null,
                outcome: 'open',
                pending: true,
            },
        ]);
    });

    it('does not read the failure message', () => {
        // The one assertion in this file that is about a decision rather than a
        // shape, and the one worth failing loudly: a mutation that reads
        // `lastFailure` puts customer data in a card, in a title attribute, and on
        // the page's message bus.
        const serialised = JSON.stringify(readDescribeFacts(body));
        expect(serialised).not.toContain('declined');
        expect(serialised).not.toContain('4321');
        expect(serialised).not.toContain('55123');
    });

    it('finds the task queue in either nesting', () => {
        const facts = readDescribeFacts({
            workflowExecutionInfo: { startTime: '2026-01-01T10:00:00Z', taskQueue: { name: 'orders' } },
        });
        expect(facts.taskQueue).toBe('orders');
    });

    it('has nothing to say about a body that is not a description', () => {
        expect(readDescribeFacts(null)).toEqual(NO_FACTS);
        expect(readDescribeFacts({ pendingActivities: 'no' })).toEqual(NO_FACTS);
    });
});

// ── Putting the two together ─────────────────────────────────────────────────

describe('mergeFacts', () => {
    it('lets a known value win over an unknown one, in both directions', () => {
        const history: DetailFacts = { ...NO_FACTS, workflowType: 'ProcessOrder', startTimeMs: 100, eventsSeen: 40 };
        const describe: DetailFacts = { ...NO_FACTS, status: 'Running', taskQueue: 'orders' };
        // The order the two responses arrive in is not ours to choose, so the merge
        // has to be the same either way round.
        for (const merged of [mergeFacts(history, describe), mergeFacts(describe, history)]) {
            expect(merged.workflowType).toBe('ProcessOrder');
            expect(merged.status).toBe('Running');
            expect(merged.taskQueue).toBe('orders');
            expect(merged.startTimeMs).toBe(100);
        }
    });

    it('joins an activity’s identity to an attempt count that arrived separately', () => {
        // The real sequence: page 1 of the history names the activity, and page 2
        // (or a describe) carries the attempt. Neither answer is complete alone.
        const named: DetailFacts = {
            ...NO_FACTS,
            activities: [
                {
                    scheduledEventId: '5',
                    activityId: 'charge-1',
                    activityType: 'ChargeCard',
                    attempt: null,
                    scheduledAtMs: 5,
                    closedAtMs: 9,
                    outcome: 'open',
                    pending: false,
                },
            ],
        };
        const counted: DetailFacts = {
            ...NO_FACTS,
            activities: [
                {
                    scheduledEventId: '5',
                    activityId: '',
                    activityType: '',
                    attempt: 900,
                    scheduledAtMs: null,
                    closedAtMs: null,
                    outcome: 'open',
                    pending: true,
                },
            ],
        };
        const merged = mergeFacts(named, counted);
        expect(merged.activities).toHaveLength(1);
        expect(merged.activities[0]).toMatchObject({
            activityType: 'ChargeCard',
            attempt: 900,
            scheduledAtMs: 5,
            // Both ends of the window survive an answer that knows neither. A describe
            // carries no close time at all, so a merge that let the newer answer win
            // outright would drop the end of the window every time one arrived — and a
            // link with a start and no end is a link to "from then until whenever".
            closedAtMs: 9,
            pending: true,
        });
    });

    it('never lets a finished activity go back to pending', () => {
        const finished: DetailFacts = {
            ...NO_FACTS,
            activities: [
                {
                    scheduledEventId: '5',
                    activityId: 'charge-1',
                    activityType: 'ChargeCard',
                    attempt: 3,
                    scheduledAtMs: 5,
                    closedAtMs: 9,
                    outcome: 'failed',
                    pending: false,
                },
            ],
        };
        const stale: DetailFacts = {
            ...NO_FACTS,
            activities: [{ ...finished.activities[0]!, outcome: 'open', pending: true }],
        };
        // A describe fetched before the activity failed can answer after the history
        // page that saw it fail.
        expect(mergeFacts(finished, stale).activities[0]).toMatchObject({ outcome: 'failed', pending: false });
    });

    it('takes the larger event count, not the sum', () => {
        // The UI re-fetches the same first page whenever the view re-mounts, and
        // adding those up would report a history several times the workflow's size.
        const first: DetailFacts = { ...NO_FACTS, eventsSeen: 40 };
        expect(mergeFacts(first, { ...NO_FACTS, eventsSeen: 40 }).eventsSeen).toBe(40);
        expect(mergeFacts(first, { ...NO_FACTS, eventsSeen: 120 }).eventsSeen).toBe(120);
        expect(mergeFacts({ ...NO_FACTS, eventsSeen: 120 }, first).eventsSeen).toBe(120);
    });
});

// One activity, with only the fields a spec cares about spelled out. Written as a
// helper here rather than inline, because the whole point of the two specs below is
// which FIELD a lookup keys on, and eight-field literals hide that.
function activity(overrides: Partial<DetailActivity> = {}): DetailActivity {
    return {
        scheduledEventId: '5',
        activityId: 'charge-1',
        activityType: 'ChargeCard',
        attempt: null,
        scheduledAtMs: null,
        closedAtMs: null,
        outcome: 'open',
        pending: false,
        ...overrides,
    };
}

describe('linkableActivities', () => {
    it('is newest first, and drops the ones with no identity to link', () => {
        const facts: DetailFacts = {
            ...NO_FACTS,
            activities: [
                activity({ scheduledEventId: '9', activityId: 'a', activityType: 'A' }),
                activity({ scheduledEventId: '10', activityId: 'b', activityType: 'B' }),
                activity({ scheduledEventId: '113', activityId: '', activityType: '', attempt: 2 }),
            ],
        };
        // Numeric, not lexicographic — and these three ids are chosen so the two
        // orderings disagree. An event id is an int64 sent as a string, so '10'
        // sorts BEFORE '9' as text, and on any workflow with more than nine
        // activities the newest-first order would look arbitrary. An earlier
        // fixture here used '5'/'90'/'12', where both orderings happen to agree, and
        // a mutation audit showed the spec passing against a lexicographic sort.
        expect(linkableActivities(facts).map((a) => a.scheduledEventId)).toEqual(['10', '9']);
    });
});

// ── Resolving one panel on the page to one activity ──────────────────────────
//
// The lookup behind every per-activity link. What it is for is stated at its
// definition in src/detail.ts; these specs pin the two decisions that a reader of
// the call site cannot see: which key wins, and what happens when the key is not
// unique after all.
describe('activityByPanelId', () => {
    it('matches on the activity id — the field the panel is showing', () => {
        const facts: DetailFacts = {
            ...NO_FACTS,
            activities: [
                activity({ scheduledEventId: '5', activityId: 'charge-1' }),
                activity({ scheduledEventId: '9', activityId: 'ship-1', activityType: 'ShipOrder' }),
            ],
        };
        const match = activityByPanelId(facts, 'ship-1')!;
        expect(match.by).toBe('activityId');
        expect(match.activity.scheduledEventId).toBe('9');
        expect(match.ambiguous).toBe(false);
    });

    it('ignores surrounding whitespace, because a DOM node has plenty', () => {
        const facts: DetailFacts = { ...NO_FACTS, activities: [activity()] };
        expect(activityByPanelId(facts, '\n  charge-1  ')?.activity.scheduledEventId).toBe('5');
    });

    it('says so when a run used one id twice, and takes the newest', () => {
        // An activityId is chosen by the workflow author, so nothing stops a loop from
        // reusing one. The UI's panel shows only the id, so a reader cannot tell —
        // which is precisely why `ambiguous` exists and is put on the link's title
        // rather than left as a detail of the lookup.
        const facts: DetailFacts = {
            ...NO_FACTS,
            activities: [
                activity({ scheduledEventId: '5', activityId: 'charge-1' }),
                activity({ scheduledEventId: '12', activityId: 'charge-1' }),
            ],
        };
        const match = activityByPanelId(facts, 'charge-1')!;
        expect(match.ambiguous).toBe(true);
        // Newest first, as linkableActivities orders them: on a retrying workflow the
        // one somebody has a panel open on is the latest.
        expect(match.activity.scheduledEventId).toBe('12');
    });

    it('falls back to the scheduled event id, which cannot repeat', () => {
        // A history page that begins mid-workflow carries an ActivityTaskStarted with
        // no activityId. The panel then shows the event id, and this is the only key
        // left — one Temporal assigns, so it is unique by construction.
        const facts: DetailFacts = {
            ...NO_FACTS,
            activities: [activity({ scheduledEventId: '5', activityId: '', activityType: '' })],
        };
        const match = activityByPanelId(facts, '5')!;
        expect(match.by).toBe('scheduledEventId');
        expect(match.ambiguous).toBe(false);
    });

    it('prefers the activity id when a run has one of each', () => {
        // The ambiguity that decides the ORDER of the two keys: '9' is one activity's
        // author-chosen id and another's event id. The panel is showing the field the
        // UI labelled "Activity Id", so the activity id is the reading that matches
        // what is on screen.
        const facts: DetailFacts = {
            ...NO_FACTS,
            activities: [
                activity({ scheduledEventId: '9', activityId: 'ship-1' }),
                activity({ scheduledEventId: '40', activityId: '9' }),
            ],
        };
        expect(activityByPanelId(facts, '9')?.activity.scheduledEventId).toBe('40');
    });

    it('is null for an id this run does not have, and for no id at all', () => {
        // The alternative — falling back to the newest activity — is what turns a
        // stale panel into a link that looks right and is about something else.
        const facts: DetailFacts = { ...NO_FACTS, activities: [activity()] };
        expect(activityByPanelId(facts, 'charge-2')).toBeNull();
        expect(activityByPanelId(facts, '')).toBeNull();
        expect(activityByPanelId(facts, '   ')).toBeNull();
    });
});

describe('rowFromFacts', () => {
    const ref = { namespace: NS, workflowId: 'order-42', runId: RUN };

    it('resolves the workflow tokens exactly as a table row would', () => {
        const facts: DetailFacts = {
            ...NO_FACTS,
            workflowType: 'ProcessOrder',
            taskQueue: 'orders',
            status: 'Running',
            startTimeMs: Date.parse('2026-01-01T10:00:00Z'),
        };
        const row = rowFromFacts(ref, facts)!;
        const { url } = expandTemplate('{workflowId}|{runId}|{workflowType}|{taskQueue}|{status}|{startTimeIso}', {
            namespace: NS,
            row,
            nowMs: Date.parse('2026-01-01T12:00:00Z'),
        });
        expect(url).toBe(
            ['order-42', RUN, 'ProcessOrder', 'orders', 'Running', encodeURIComponent('2026-01-01T10:00:00.000Z')].join(
                '|',
            ),
        );
    });

    it('is null until the start time is known', () => {
        // The alternative is a 1970 window in a log link: a URL that looks like it
        // works and returns nothing.
        expect(rowFromFacts(ref, NO_FACTS)).toBeNull();
        expect(rowFromFacts(ref, { ...NO_FACTS, workflowType: 'ProcessOrder' })).toBeNull();
    });

    it('calls a workflow with no terminal event Running', () => {
        const row = rowFromFacts(ref, { ...NO_FACTS, startTimeMs: 100 })!;
        expect(row.status).toBe('Running');
    });
});

// ── The message ──────────────────────────────────────────────────────────────

describe('isDetailFactsMessage', () => {
    const good = {
        source: MESSAGE_SOURCE,
        type: 'detail-facts',
        from: 'history',
        namespace: NS,
        workflowId: 'order-42',
        runId: RUN,
        facts: NO_FACTS,
    };

    it('accepts a well-formed message', () => {
        expect(isDetailFactsMessage(good)).toBe(true);
        expect(isDetailFactsMessage({ ...good, from: 'describe', runId: null })).toBe(true);
    });

    it('rejects everything else, including an unbounded activity list', () => {
        const many = Array.from({ length: MAX_ACTIVITIES + 1 }, (_, i) => ({ scheduledEventId: String(i) }));
        for (const bad of [
            null,
            'string',
            { ...good, source: 'someone-else' },
            { ...good, type: 'workflows' },
            { ...good, from: 'guess' },
            { ...good, namespace: '' },
            { ...good, workflowId: 42 },
            { ...good, runId: 7 },
            { ...good, facts: null },
            { ...good, facts: { activities: 'no' } },
            { ...good, facts: { ...NO_FACTS, activities: [{ noId: true }] } },
            { ...good, facts: { ...NO_FACTS, activities: many } },
        ]) {
            expect(isDetailFactsMessage(bad), JSON.stringify(bad)?.slice(0, 60)).toBe(false);
        }
    });
});
