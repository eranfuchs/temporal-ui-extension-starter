// @vitest-environment jsdom
//
// The ISOLATED-world half of the two per-row questions: WHICH rows get asked
// about. This is the file that decides what the feature costs, so every spec here
// is a spec about a request that does NOT happen.
//
// The saving is not incidental. On a list of closed workflows this feature makes
// no requests at all, and on a settled table showing running ones it makes one
// round per TTL rather than one per render pass — and there are dozens of render
// passes a second while the Temporal UI re-renders.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isRowInfoRequest, MAX_RUNS_PER_REQUEST, type RowInfoRequest, type RowInfoResult } from '../../src/rowInfo';
import {
    clearRowInfo,
    installRowInfo,
    MAX_REMEMBERED_RUNS,
    requestRowInfo,
    rowInfoFor,
} from '../../src/rowInfoClient';
import { normalizeExecutions } from '../../src/rows';
import { apiWorkflow, fakeRunId } from '../helpers';
import { MESSAGE_SOURCE, type WorkflowRow } from '../../src/types';

const NAMESPACE = 'sample-namespace';
const NOW = Date.parse('2026-01-01T12:00:00Z');

const LIVE_RUN = fakeRunId(301);
const DONE_RUN = fakeRunId(302);

function rows(specs: Array<{ workflowId: string; runId: string; running: boolean }>): WorkflowRow[] {
    return normalizeExecutions(
        specs.map((spec) =>
            apiWorkflow({
                workflowId: spec.workflowId,
                runId: spec.runId,
                status: spec.running ? 'RUNNING' : 'COMPLETED',
                closeTime: spec.running ? null : '2026-01-01T00:01:00Z',
            }),
        ),
    );
}

const LIVE_AND_DONE = rows([
    { workflowId: 'live', runId: LIVE_RUN, running: true },
    { workflowId: 'done', runId: DONE_RUN, running: false },
]);

// Every row-info request that was posted, and where it was addressed.
let posted: Array<{ request: RowInfoRequest; targetOrigin: string }> = [];

beforeEach(() => {
    posted = [];
    clearRowInfo();
    vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown, targetOrigin?: string) => {
        // The type guard, not a cast: a message the receiver would refuse is a
        // message that was never sent, and this spec should fail in that case.
        if (isRowInfoRequest(message)) posted.push({ request: message, targetOrigin: String(targetOrigin) });
    }) as typeof window.postMessage);
});

describe('choosing what to ask about', () => {
    it('asks about running rows and leaves the closed ones alone', () => {
        // The single filter that does most of the saving: every non-Running status
        // is final, so the answer could never change and the request could never
        // tell anyone anything.
        const asked = requestRowInfo(NAMESPACE, ['lastEvent', 'retry'], LIVE_AND_DONE, NOW);

        expect(asked).toBe(1);
        expect(posted).toHaveLength(1);
        expect(posted[0]!.request.runs).toEqual([{ workflowId: 'live', runId: LIVE_RUN }]);
        expect(posted[0]!.request.want).toEqual(['lastEvent', 'retry']);
        // An automatic pass never asks the MAIN world to skip its cache. Defaulting
        // this the other way would turn every DOM mutation into a round of requests.
        expect(posted[0]!.request.fresh).toBe(false);
    });

    it('sends nothing at all when nothing on screen is running', () => {
        // A list filtered to "Completed" — the common case for someone reading
        // yesterday's failures — costs zero requests and zero messages.
        const closed = rows([{ workflowId: 'done', runId: DONE_RUN, running: false }]);

        expect(requestRowInfo(NAMESPACE, ['lastEvent'], closed, NOW)).toBe(0);
        expect(posted).toHaveLength(0);
    });

    it('sends nothing when both features are off, or the namespace is unknown', () => {
        expect(requestRowInfo(NAMESPACE, [], LIVE_AND_DONE, NOW)).toBe(0);
        // No namespace means this is not a workflow-list page, and a request would
        // have nowhere to go.
        expect(requestRowInfo('', ['lastEvent'], LIVE_AND_DONE, NOW)).toBe(0);
        expect(posted).toHaveLength(0);
    });

    it('does not ask again about a run it asked about a moment ago', () => {
        // THE assertion about cost. A render pass happens on every DOM mutation;
        // without this, a settled table would post a message per row per pass, and
        // the MAIN world answering them all from cache would still be doing work.
        requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW);
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 1_000)).toBe(0);
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 29_000)).toBe(0);
        expect(posted).toHaveLength(1);

        // …and does ask again once the answer could have changed. The interval is
        // deliberately longer than the MAIN world's cache TTL, so this is the ask
        // that actually becomes a request.
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 40_000)).toBe(1);
        expect(posted).toHaveLength(2);
    });

    it('asks again straight away when the user presses refresh', () => {
        // The one path that does not wait for the ask interval, and the only caller of
        // it is the control in the column header. Everything else about the request is
        // unchanged — same rows, same fields — so what a press buys is exactly two
        // things: this side skips `askedAt`, and the MAIN world is told to skip its
        // cached answer.
        requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW);
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 1_000)).toBe(0);

        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 1_000, 'fresh')).toBe(1);

        expect(posted).toHaveLength(2);
        expect(posted[1]!.request.fresh).toBe(true);
        expect(posted[1]!.request.runs).toEqual([{ workflowId: 'live', runId: LIVE_RUN }]);
        // A press is not an override of the filters. A closed workflow's last event
        // still cannot change, so refresh does not turn it into a request either.
        expect(posted[1]!.request.runs).toHaveLength(1);
    });

    it('does not let a press become a licence to ask forever', () => {
        // A press records askedAt like any other ask, so the render passes that follow
        // it — and a press schedules one immediately and one when the floor lifts — are
        // throttled normally. The bound on repeated PRESSES is FRESH_FLOOR_MS, and it is
        // enforced by the receiver rather than here; see rowInfoServe.ts.
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW, 'fresh')).toBe(1);
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 1_000)).toBe(0);
        expect(posted).toHaveLength(1);
    });

    it('keeps the answers it already has while a refresh drains', () => {
        // clearRowInfo() is deliberately NOT part of pressing refresh. Emptying the
        // answers would blank the column for as long as the round takes, and a column
        // that goes blank when you ask it to update reads as a feature that broke.
        installRowInfo(() => {});
        requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW);
        window.dispatchEvent(
            new MessageEvent('message', {
                source: window,
                data: {
                    source: MESSAGE_SOURCE,
                    type: 'row-info-result',
                    namespace: NAMESPACE,
                    workflowId: 'live',
                    runId: LIVE_RUN,
                    lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: NOW },
                    retry: null,
                    observedAtMs: NOW,
                    error: null,
                } satisfies RowInfoResult,
            }),
        );

        requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW + 1_000, 'fresh');

        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)?.lastEvent?.eventType).toBe('ActivityTaskStarted');
    });

    it('asks about a row that appears later, without re-asking about the others', () => {
        requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW);
        const scrolledIn = [
            ...LIVE_AND_DONE,
            ...rows([{ workflowId: 'live-2', runId: fakeRunId(303), running: true }]),
        ];

        expect(requestRowInfo(NAMESPACE, ['lastEvent'], scrolledIn, NOW + 1_000)).toBe(1);
        expect(posted[1]!.request.runs.map((run) => run.workflowId)).toEqual(['live-2']);
    });

    it('addresses the message to this origin and not to every frame', () => {
        // '*' would hand an iframe on the page a list of the runs the user is
        // looking at, for nothing in return.
        requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW);
        expect(posted[0]!.targetOrigin).toBe(location.origin);
    });

    it('splits a table larger than the receiver’s cap instead of being dropped', () => {
        // The cap exists because anyone in the page can send this message. It is
        // enforced by refusing the WHOLE message, so an over-long one produces no
        // answers and no error — the exact silent failure this repository keeps a
        // list of. Chunking here keeps the cap meaningful.
        const many = rows(
            Array.from({ length: MAX_RUNS_PER_REQUEST + 3 }, (_, index) => ({
                workflowId: `live-${index}`,
                runId: fakeRunId(1_000 + index),
                running: true,
            })),
        );

        expect(requestRowInfo(NAMESPACE, ['lastEvent'], many, NOW)).toBe(MAX_RUNS_PER_REQUEST + 3);
        expect(posted).toHaveLength(2);
        expect(posted[0]!.request.runs).toHaveLength(MAX_RUNS_PER_REQUEST);
        expect(posted[1]!.request.runs).toHaveLength(3);
        // Every run appears exactly once across the chunks.
        const sent = new Set(posted.flatMap((entry) => entry.request.runs.map((run) => run.runId)));
        expect(sent.size).toBe(MAX_RUNS_PER_REQUEST + 3);
    });
});

describe('receiving answers', () => {
    function answer(overrides: Partial<RowInfoResult> = {}): RowInfoResult {
        return {
            source: MESSAGE_SOURCE,
            type: 'row-info-result',
            namespace: NAMESPACE,
            workflowId: 'live',
            runId: LIVE_RUN,
            lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: NOW },
            retry: null,
            observedAtMs: NOW,
            error: null,
            ...overrides,
        };
    }

    function deliver(data: unknown, source: Window | null = window): void {
        window.dispatchEvent(new MessageEvent('message', { data, source }));
    }

    // An answer is only kept for a question this side asked, so every spec that
    // expects an answer to LAND has to ask first. That is the correlation check
    // under test, not scaffolding — the specs below that skip this call are the
    // ones asserting a message gets dropped.
    function ask(namespace = NAMESPACE): void {
        requestRowInfo(namespace, ['lastEvent'], LIVE_AND_DONE, NOW);
    }

    it('stores an answer per run and re-renders once per answer', () => {
        const onUpdate = vi.fn();
        installRowInfo(onUpdate);
        ask();

        deliver(answer());

        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)?.lastEvent?.eventType).toBe('ActivityTaskStarted');
        // Keyed by RUN, not by workflow id: a retried or continued-as-new workflow
        // keeps its id and gets a new run, and both appear in the same list.
        expect(rowInfoFor(NAMESPACE, 'live', DONE_RUN)).toBeUndefined();
    });

    it('keeps the instant the answer was READ, not the instant it arrived', () => {
        // The column subtracts against this number, so where it comes from is the whole
        // honesty of the feature. The MAIN world may serve a cached answer up to its TTL
        // old; storing the arrival time here — or calling Date.now() at render — would
        // date stale data to now and print an age that is short by the cache's age.
        installRowInfo(() => {});
        ask();

        const readAtMs = NOW - 28_000;
        deliver(answer({ observedAtMs: readAtMs }));

        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)?.observedAtMs).toBe(readAtMs);
    });

    it('ignores the page’s own traffic and anything from an iframe', () => {
        const onUpdate = vi.fn();
        installRowInfo(onUpdate);
        // Asked, so the correlation check is OPEN and each refusal below is
        // attributable to the shape or the sender rather than to the gate.
        ask();

        deliver({ source: MESSAGE_SOURCE, type: 'workflows', executions: [] });
        deliver('hello');
        // Well-formed envelope, junk inside: `lastEvent` is declared an object and
        // the renderer reads a property off it. isRowInfoResult validates to the
        // leaves precisely so this cannot reach a cell.
        deliver(answer({ lastEvent: 42 as unknown as RowInfoResult['lastEvent'] }));
        deliver(answer(), null); // event.source !== window

        expect(onUpdate).not.toHaveBeenCalled();
        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)).toBeUndefined();
    });

    it('drops an answer to a question this side never asked', () => {
        // Anything running in the page can post one of these, and the ISOLATED
        // world is the side that renders. This does NOT authenticate the sender —
        // postMessage cannot — but an answer now has to name a question that was
        // actually asked, which is what rules out another extension's traffic and a
        // forgery about a run the user is not even looking at.
        const onUpdate = vi.fn();
        installRowInfo(onUpdate);

        deliver(answer());

        expect(onUpdate).not.toHaveBeenCalled();
        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)).toBeUndefined();
    });

    it('drops an answer that names a namespace this page did not ask about', () => {
        // The same workflow id exists in more than one namespace, and one tab
        // reaches several. Without the namespace in the key this answer would be
        // rendered on the row that happens to share its id.
        const onUpdate = vi.fn();
        installRowInfo(onUpdate);
        ask();

        deliver(answer({ namespace: 'another-namespace' }));

        expect(onUpdate).not.toHaveBeenCalled();
        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)).toBeUndefined();
        expect(rowInfoFor('another-namespace', 'live', LIVE_RUN)).toBeUndefined();
    });

    it('keeps two namespaces’ answers about the same run apart', () => {
        installRowInfo(() => {});
        ask();
        ask('another-namespace');

        deliver(answer());
        deliver(
            answer({
                namespace: 'another-namespace',
                lastEvent: { eventId: '7', eventType: 'WorkflowTaskTimedOut', timeMs: NOW },
            }),
        );

        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)?.lastEvent?.eventType).toBe('ActivityTaskStarted');
        expect(rowInfoFor('another-namespace', 'live', LIVE_RUN)?.lastEvent?.eventType).toBe('WorkflowTaskTimedOut');
    });

    it('evicts before recording a pass, so the answers to that pass still land', () => {
        // Eviction is whole-map, and askedAt is now what lets an answer in — so
        // evicting AFTER recording throws away the questions in the message that
        // was just posted, and every row in the table stays blank for a full ask
        // interval. Ordering is the whole content of this spec.
        installRowInfo(() => {});
        const crowd = rows(
            Array.from({ length: MAX_REMEMBERED_RUNS + 1 }, (_, index) => ({
                workflowId: `live-${index}`,
                runId: fakeRunId(20_000 + index),
                running: true,
            })),
        );

        expect(requestRowInfo(NAMESPACE, ['lastEvent'], crowd, NOW)).toBe(MAX_REMEMBERED_RUNS + 1);
        deliver(answer({ workflowId: 'live-0', runId: fakeRunId(20_000) }));
        expect(rowInfoFor(NAMESPACE, 'live-0', fakeRunId(20_000))?.lastEvent?.eventType).toBe('ActivityTaskStarted');

        // And the maps really were bounded: the next pass finds nothing remembered,
        // so it re-asks about the whole table instead of throttling it away.
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], crowd, NOW + 1_000)).toBe(MAX_REMEMBERED_RUNS + 1);
    });

    it('forgets everything when a setting changes what an answer would have been', () => {
        // Turning a feature back on has to ask again immediately, or the ask
        // interval keeps the column empty for half a minute and the toggle looks
        // like it did nothing.
        installRowInfo(() => {});
        ask();
        deliver(answer());
        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)).toBeDefined();

        clearRowInfo();

        expect(rowInfoFor(NAMESPACE, 'live', LIVE_RUN)).toBeUndefined();
        expect(requestRowInfo(NAMESPACE, ['lastEvent'], LIVE_AND_DONE, NOW)).toBe(1);
    });
});
