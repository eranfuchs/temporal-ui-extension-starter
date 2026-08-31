// The pure half of the two per-row questions. No DOM, no network: everything
// here is "given this JSON, what does the cell say".
//
// Most of these specs pin a Temporal API detail rather than a formatting choice,
// and each of the details cost time somewhere before it was written down:
//   • an int64 field arrives as a JSON STRING while an int32 arrives as a number;
//   • an event type has two spellings, depending on the server's version;
//   • maximumAttempts: 0 means unlimited, not "zero attempts allowed";
//   • attempt 1 is an activity running for the first time, not a retry.
// Every one of them produces a plausible-looking wrong answer rather than an
// error, which is exactly the kind of bug a unit test is for.

import { describe, expect, it } from 'vitest';

import {
    formatAge,
    isRowInfoRequest,
    isRowInfoResult,
    lastEventTitle,
    MAX_RUNS_PER_REQUEST,
    prettyEventType,
    readLastEvent,
    readPendingRetry,
    retryBadgeLabel,
    retryBadgeTitle,
    type PendingRetry,
} from '../../src/rowInfo';
import { MESSAGE_SOURCE } from '../../src/types';

const NOW = Date.parse('2026-01-01T12:00:00Z');
const RUN = { workflowId: 'order-1', runId: '00000000-0000-4000-8000-000000000001' };

const GOOD_REQUEST = {
    source: MESSAGE_SOURCE,
    type: 'row-info-request',
    namespace: 'sample-namespace',
    want: ['lastEvent', 'retry'],
    runs: [RUN],
};

describe('isRowInfoRequest', () => {
    it('accepts a well-formed request', () => {
        expect(isRowInfoRequest(GOOD_REQUEST)).toBe(true);
        expect(isRowInfoRequest({ ...GOOD_REQUEST, want: ['retry'] })).toBe(true);
        // No runs is well-formed and simply asks nothing — a render pass with
        // nothing on screen produces exactly this.
        expect(isRowInfoRequest({ ...GOOD_REQUEST, runs: [] })).toBe(true);
    });

    it('rejects anything that is not one', () => {
        expect(isRowInfoRequest(null)).toBe(false);
        expect(isRowInfoRequest('row-info-request')).toBe(false);
        expect(isRowInfoRequest({ ...GOOD_REQUEST, source: 'somebody-else' })).toBe(false);
        // A type this build does not serve. The bus carries the tree's own
        // 'workflows' messages too, and every one of them arrives here first.
        expect(isRowInfoRequest({ ...GOOD_REQUEST, type: 'workflows' })).toBe(false);
        expect(isRowInfoRequest({ ...GOOD_REQUEST, namespace: '' })).toBe(false);
        expect(isRowInfoRequest({ ...GOOD_REQUEST, want: [] })).toBe(false);
        // A field name nobody serves. Accepting it would mean carrying an unknown
        // string into a switch and hoping every branch of it stayed exhaustive.
        expect(isRowInfoRequest({ ...GOOD_REQUEST, want: ['lastEvent', 'everything'] })).toBe(false);
        expect(isRowInfoRequest({ ...GOOD_REQUEST, runs: [{ workflowId: 'order-1' }] })).toBe(false);
        expect(isRowInfoRequest({ ...GOOD_REQUEST, runs: [{ workflowId: 'order-1', runId: 7 }] })).toBe(false);
    });

    it('caps how many runs one message may ask about', () => {
        // Anyone in the page can send this message, and each run in it costs a URL
        // build and a ledger lookup. The bound is well above a Temporal list page,
        // so the real caller never meets it.
        const many = (count: number) => ({ ...GOOD_REQUEST, runs: Array.from({ length: count }, () => RUN) });
        expect(isRowInfoRequest(many(MAX_RUNS_PER_REQUEST))).toBe(true);
        expect(isRowInfoRequest(many(MAX_RUNS_PER_REQUEST + 1))).toBe(false);
    });
});

describe('isRowInfoResult', () => {
    it('accepts an answer and rejects the page’s own traffic', () => {
        const answer = {
            source: MESSAGE_SOURCE,
            type: 'row-info-result',
            ...RUN,
            lastEvent: null,
            retry: null,
            error: null,
        };
        expect(isRowInfoResult(answer)).toBe(true);
        expect(isRowInfoResult({ ...answer, type: 'workflows' })).toBe(false);
        expect(isRowInfoResult({ ...answer, source: 'temporal-ui' })).toBe(false);
        expect(isRowInfoResult(undefined)).toBe(false);
    });
});

describe('readLastEvent', () => {
    const event = {
        eventId: '42',
        eventType: 'EVENT_TYPE_ACTIVITY_TASK_STARTED',
        eventTime: '2026-01-01T11:59:00Z',
    };

    it('reads the first event of a reverse page, which is the newest one', () => {
        // history-reverse returns newest-first. (The FORWARD route with
        // maximumPageSize=1 returns the workflow's first event instead — the same
        // shape, a different fact, and no error to notice.)
        expect(readLastEvent({ history: { events: [event, { eventId: '41' }] } })).toEqual({
            eventId: '42',
            eventType: 'ActivityTaskStarted',
            timeMs: Date.parse('2026-01-01T11:59:00Z'),
        });
    });

    it('accepts the array wrapped in history and bare', () => {
        expect(readLastEvent({ events: [event] })?.eventId).toBe('42');
    });

    it('returns null rather than a blank answer when there is nothing to read', () => {
        expect(readLastEvent({ history: { events: [] } })).toBeNull();
        expect(readLastEvent({})).toBeNull();
        expect(readLastEvent(null)).toBeNull();
        expect(readLastEvent('not json')).toBeNull();
    });

    it('keeps the event id as a string and survives a missing timestamp', () => {
        // eventId is an int64, so it arrives as a string; it is displayed and
        // compared, never added up. A server that sends it as a number must not
        // produce "42" in one place and 42 in another.
        expect(readLastEvent({ events: [{ eventId: 7 }] })).toEqual({
            eventId: '7',
            eventType: 'Unknown',
            timeMs: null,
        });
    });
});

describe('prettyEventType', () => {
    it('normalises both spellings Temporal uses to one', () => {
        // A column showing EVENT_TYPE_WORKFLOW_TASK_COMPLETED on Cloud and
        // WorkflowTaskCompleted on a self-hosted server looks broken in a way
        // nobody bothers to report.
        expect(prettyEventType('EVENT_TYPE_WORKFLOW_TASK_COMPLETED')).toBe('WorkflowTaskCompleted');
        expect(prettyEventType('WorkflowTaskCompleted')).toBe('WorkflowTaskCompleted');
        expect(prettyEventType('EVENT_TYPE_TIMER_FIRED')).toBe('TimerFired');
        expect(prettyEventType('')).toBe('Unknown');
    });
});

describe('readPendingRetry', () => {
    const stuck = {
        activityType: { name: 'ChargeCard' },
        attempt: 900,
        maximumAttempts: 0,
        scheduledTime: '2026-01-01T11:58:00Z',
        nextAttemptScheduleTime: '2026-01-01T12:00:30Z',
    };

    it('reads the attempt, and turns an unlimited ceiling into null', () => {
        // maximumAttempts: 0 in the API means UNLIMITED. Reporting "attempt 900 of
        // 0" is worse than reporting nothing.
        expect(readPendingRetry({ pendingActivities: [stuck] })).toEqual({
            activityType: 'ChargeCard',
            attempt: 900,
            maximumAttempts: null,
            nextRetryAtMs: Date.parse('2026-01-01T12:00:30Z'),
            scheduledAtMs: Date.parse('2026-01-01T11:58:00Z'),
        });
        expect(readPendingRetry({ pendingActivities: [{ ...stuck, maximumAttempts: 10 }] })?.maximumAttempts).toBe(10);
    });

    it('ignores an activity on its first attempt', () => {
        // attempt 1 is an activity simply running. Badging it would mark every
        // healthy workflow in the list, which is the same as badging none.
        expect(readPendingRetry({ pendingActivities: [{ ...stuck, attempt: 1 }] })).toBeNull();
        // A response with no attempt field at all is treated the same way, rather
        // than defaulting to something that badges.
        expect(readPendingRetry({ pendingActivities: [{ activityType: { name: 'ChargeCard' } }] })).toBeNull();
    });

    it('reports the worst of several, not the first', () => {
        // The badge is a signal, not a report: a workflow with three retrying
        // activities is exactly as interesting as the worst of them.
        const worst = readPendingRetry({
            pendingActivities: [
                { ...stuck, activityType: { name: 'SendEmail' }, attempt: 3 },
                { ...stuck, activityType: { name: 'ChargeCard' }, attempt: 900 },
                { ...stuck, activityType: { name: 'Refund' }, attempt: 12 },
            ],
        });
        expect(worst).toMatchObject({ activityType: 'ChargeCard', attempt: 900 });
    });

    it('accepts a count sent as a string', () => {
        // int32 serialises as a JSON number and int64 as a JSON STRING. `attempt`
        // is an int32 today, which is precisely the kind of thing that changes
        // quietly in a proto.
        expect(readPendingRetry({ pendingActivities: [{ ...stuck, attempt: '900' }] })?.attempt).toBe(900);
    });

    it('names the activity “activity” when the type is missing', () => {
        expect(readPendingRetry({ pendingActivities: [{ attempt: 4 }] })?.activityType).toBe('activity');
    });

    it('returns null when there is nothing pending', () => {
        expect(readPendingRetry({ pendingActivities: [] })).toBeNull();
        expect(readPendingRetry({})).toBeNull();
        expect(readPendingRetry(null)).toBeNull();
    });

    it('reads none of the failure, whatever the response carries', () => {
        // The decision this project is making, asserted on the parser itself and
        // not only on the wire (see tests/unit/apiInject.spec.ts): a failure message
        // is application data, and 02 reads history WITHOUT reading anybody's data.
        // `activityId` goes the same way — unlike the type it is chosen by the
        // caller and is regularly built out of a business identifier.
        const retry = readPendingRetry({
            pendingActivities: [
                {
                    ...stuck,
                    activityId: 'customer-4711-step-2',
                    lastFailure: { message: 'account 4711 is overdrawn', stackTrace: 'at charge.ts:88' },
                    lastWorkerIdentity: '1234@worker-host',
                },
            ],
        });

        const asJson = JSON.stringify(retry);
        expect(asJson).not.toContain('4711');
        expect(asJson).not.toContain('overdrawn');
        expect(asJson).not.toContain('worker-host');
        expect(Object.keys(retry!).sort()).toEqual([
            'activityType',
            'attempt',
            'maximumAttempts',
            'nextRetryAtMs',
            'scheduledAtMs',
        ]);
    });
});

describe('formatAge', () => {
    it('says how long ago in as few characters as it can', () => {
        // The column sits at the end of a table the UI already fills, so width is a
        // feature. No "ago" either: the header says what these are.
        expect(formatAge(NOW, NOW)).toBe('now');
        expect(formatAge(NOW - 45_000, NOW)).toBe('45s');
        expect(formatAge(NOW - 3 * 60_000, NOW)).toBe('3m');
        expect(formatAge(NOW - 5 * 3_600_000, NOW)).toBe('5h');
        expect(formatAge(NOW - 5 * 86_400_000, NOW)).toBe('5d');
        expect(formatAge(null, NOW)).toBe('—');
    });

    it('does not report a negative age when the clocks disagree', () => {
        // The server's clock and the browser's differ by a second or two routinely,
        // and "-1s" reads as a bug in the extension rather than in the clocks.
        expect(formatAge(NOW + 2_000, NOW)).toBe('now');
    });
});

describe('what the tooltips say', () => {
    const retry: PendingRetry = {
        activityType: 'ChargeCard',
        attempt: 900,
        maximumAttempts: null,
        nextRetryAtMs: NOW + 90_000,
        scheduledAtMs: NOW - 120_000,
    };

    it('puts the attempt count in the badge and the rest in its title', () => {
        expect(retryBadgeLabel(retry)).toBe('↻ 900');

        const title = retryBadgeTitle(retry, NOW);
        expect(title).toContain('ChargeCard is retrying');
        expect(title).toContain('attempt 900 of unlimited');
        expect(title).toContain('next attempt in 1m');
        expect(title).toContain('this attempt scheduled 2m ago');
        // The title is the natural place for a failure message and the reason there
        // is a line saying why there is not one.
        expect(title).toContain('the failure message is deliberately not read');
    });

    it('gives the ceiling when there is one, and drops the lines it has no data for', () => {
        expect(retryBadgeTitle({ ...retry, maximumAttempts: 1000 }, NOW)).toContain('attempt 900 of 1000');
        const sparse = retryBadgeTitle(
            { ...retry, nextRetryAtMs: null, scheduledAtMs: null },
            NOW,
        );
        expect(sparse).not.toContain('next attempt');
        expect(sparse).not.toContain('scheduled');
    });

    it('gives the exact time in the last-event title, since the cell only has room for an age', () => {
        const title = lastEventTitle({ eventId: '42', eventType: 'ActivityTaskStarted', timeMs: NOW - 180_000 }, NOW);
        expect(title).toContain('Last event #42: ActivityTaskStarted');
        expect(title).toContain('2026-01-01T11:57:00.000Z');
        expect(title).toContain('(3m ago)');

        expect(lastEventTitle({ eventId: '42', eventType: 'Unknown', timeMs: null }, NOW)).toContain('no timestamp');
    });
});
