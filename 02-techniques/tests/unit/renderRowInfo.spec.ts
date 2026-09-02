// @vitest-environment jsdom
//
// The two columns that cost a request: the “Last event” cell and the
// retrying-activity badge.
//
// Both render an answer that arrives LATER than the row does, which is the part
// that is easy to get wrong: an empty cell has four different meanings here, and
// three of them look like a broken extension. The answers are supplied by the
// harness rather than fetched — what asks for them is src/rowInfo/rowInfoClient.ts, and its
// own specs are in tests/unit/rowInfo.spec.ts.

import { beforeEach, describe, expect, it } from 'vitest';

import {
    applyToTable,
    COLUMN_HEAD_CLASS,
    COLUMN_LABEL_CLASS,
    LAST_EVENT_CLASS,
    RETRY_CLASS,
    type RowInfoLookup,
} from '../../src/render';
import { FRESH_FLOOR_MS } from '../../src/rowInfo/rowInfo';
import { buildWorkflowTable } from '../helpers';
import {
    A_RETRY,
    DONE_RUN,
    LIVE_RUN,
    MIXED,
    OPTIONS,
    answers,
    cellCounts,
    headerLabels,
    lookupFor,
    mutationsDuring,
    nextHour,
    pressRefreshAt,
    refreshButton,
    refreshPresses,
    resetRenderHarness,
    withHeader,
} from '../renderHarness';

beforeEach(resetRenderHarness);

describe('the “Last event” column', () => {
    it('puts a header and one cell per row immediately after the workflow id, and stays rectangular', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'done', runId: DONE_RUN },
        ]);
        const headRow = withHeader(tbody, ['Workflow ID', 'Status']);

        applyToTable(tbody, lookupFor(MIXED), {
            ...OPTIONS,
            lastEventEnabled: true,
            info: answers({
                live: { lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: OPTIONS.nowMs - 180_000 } },
            }),
        });

        // Beside the id, not at the end of the row: the question this column answers
        // is asked while reading the id, and at the right-hand edge of a table the UI
        // already fills, the answer is behind a horizontal scroll.
        const head = document.querySelector<HTMLTableCellElement>(`.${COLUMN_HEAD_CLASS}`)!;
        expect(head.querySelector(`.${COLUMN_LABEL_CLASS}`)!.textContent).toBe('Last event');
        expect(headerLabels(headRow)).toEqual(['Workflow ID', 'Last event', 'Status']);
        // A render pass draws the control; it must never act as though it were pressed.
        expect(refreshPresses()).toBe(0);
        // Immediately after the id column, and nothing a later stage adds to that
        // cell comes between them: 03-payloads' `{ }` button is a CHILD of the id
        // cell, not a sibling of it.
        for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
            const idCell = tr.querySelector('a[href*="/workflows/"]')!.closest('td');
            expect(tr.querySelector(`.${LAST_EVENT_CLASS}`)!.previousElementSibling).toBe(idCell);
        }
        // Every row got one, including the closed one whose cell stays empty.
        expect(tbody.querySelectorAll(`.${LAST_EVENT_CLASS}`)).toHaveLength(2);
        expect(new Set(cellCounts(tbody))).toEqual(new Set([3]));

        const [live, done] = Array.from(tbody.querySelectorAll(`.${LAST_EVENT_CLASS}`));
        // Seconds, not "3m": the age of the newest event is the number this column
        // exists for, and rounding it to the minute hides the first minute of a stall.
        expect(live!.textContent).toBe('3m 00s · ActivityTaskStarted');
        expect(live!.getAttribute('title')).toContain('Last event #42');
        // A closed workflow's last event cannot change, so it is never asked about
        // and must not read as "asking…" forever.
        expect(done!.textContent).toBe('');
    });

    it('follows the id column when the id is not the first column', () => {
        // Cloud's list draws a select-all checkbox before the id, and the UI lets the
        // user reorder and hide columns. "After the id" therefore has to mean the id's
        // ACTUAL position, read from the row on every pass — a hard-coded index is the
        // version of this that looks right until someone moves a column.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        const tr = tbody.querySelector('tr')!;
        tr.insertBefore(document.createElement('td'), tr.firstChild).textContent = '☐';
        const headRow = withHeader(tbody, ['', 'Workflow ID', 'Status']);

        applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true });

        expect(headerLabels(headRow)).toEqual(['', 'Workflow ID', 'Last event', 'Status']);
        expect(tr.querySelector(`.${LAST_EVENT_CLASS}`)!.previousElementSibling).toBe(
            tr.querySelector('a[href*="/workflows/"]')!.closest('td'),
        );
    });

    it('appends the cell on a row with no workflow link, so the table stays rectangular', () => {
        // A "Loading…" row, or any row the UI draws that is not a workflow, has no id
        // cell to sit beside. It still gets a cell: one in the wrong column is
        // cosmetic, whereas a row with no cell at all puts every header one column out
        // from the data underneath it.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const spacer = tbody.insertBefore(document.createElement('tr'), tbody.firstChild);
        spacer.appendChild(document.createElement('td')).textContent = 'Loading…';
        spacer.appendChild(document.createElement('td'));

        applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true });

        expect(new Set(cellCounts(tbody))).toEqual(new Set([3]));
        expect(spacer.lastElementChild!.className).toBe(LAST_EVENT_CLASS);
    });

    it('tells the four empty-looking states apart', () => {
        // "not asked yet", "it failed", "answered with nothing" and "answered" all
        // render as an empty cell if they are allowed to, and the first three are
        // the ones that get reported as the extension being broken.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor(MIXED);
        const cell = () => tbody.querySelector<HTMLTableCellElement>(`.${LAST_EVENT_CLASS}`)!;
        const render = (info: RowInfoLookup) =>
            applyToTable(tbody, lookup, { ...OPTIONS, lastEventEnabled: true, info });

        render(() => undefined);
        expect(cell().textContent).toBe('…');
        expect(cell().title).toContain('Asking Temporal');

        render(answers({ live: { error: 'HTTP 403' } }));
        expect(cell().textContent).toBe('!');
        expect(cell().title).toBe('HTTP 403');

        render(answers({ live: {} }));
        expect(cell().textContent).toBe('—');

        render(answers({ live: { lastEvent: { eventId: '7', eventType: 'TimerStarted', timeMs: OPTIONS.nowMs } } }));
        expect(cell().textContent).toBe('now · TimerStarted');
    });

    it('writes nothing on a second pass with the same answer', async () => {
        // Rule 2, on the newest write path. This one is the most exposed to it: the
        // cell is re-rendered on every DOM mutation, and there are dozens a second
        // while the Temporal UI re-renders, so the unchanged case really must touch
        // nothing. Freezing the age is what makes that reachable at all — see the spec
        // below.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const options = {
            ...OPTIONS,
            lastEventEnabled: true,
            retryEnabled: true,
            info: answers({
                live: {
                    lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: OPTIONS.nowMs - 180_000 },
                    retry: A_RETRY,
                },
            }),
        };
        const lookup = lookupFor(MIXED);

        applyToTable(tbody, lookup, options);
        const mutations = await mutationsDuring(() => {
            applyToTable(tbody, lookup, options);
        });

        expect(mutations.map((m) => `${m.type} ${m.attributeName ?? ''}`.trim())).toEqual([]);
    });

    it('holds the age still while the clock moves, because nothing was re-read', async () => {
        // THE spec that makes "frozen" a guarantee instead of a claim, and it exists
        // because the first version of this column was wrong in a way that looked
        // right: a redraw once a second animated `now - event.timeMs`, so a workflow
        // whose newest event was read 30 seconds ago displayed an age climbing to the
        // second — a live measurement of something nobody had measured.
        //
        // The age is now taken against observedAtMs, the instant Temporal was read. So
        // ninety seconds of wall clock with no new answer moves nothing, and the number
        // on screen keeps meaning what it says.
        const readAtMs = nextHour();
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor(MIXED);
        const info = answers({
            live: {
                lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: readAtMs - 180_000 },
                retry: A_RETRY,
                observedAtMs: readAtMs,
            },
        });
        const render = (nowMs: number) =>
            applyToTable(tbody, lookup, { ...OPTIONS, lastEventEnabled: true, retryEnabled: true, info, nowMs });

        render(readAtMs);
        const cell = tbody.querySelector<HTMLTableCellElement>(`.${LAST_EVENT_CLASS}`)!;
        expect(cell.textContent).toBe('3m 00s · ActivityTaskStarted');
        // And it says so, since the cell has no room to. An age with no as-of is the
        // part that misleads; this is where the extension owns up to it.
        expect(cell.title).toContain('old when this was read, at ');
        expect(cell.title).toContain('Frozen at that reading');

        // Ninety seconds later, same answers. 3m 00s, NOT 4m 30s.
        const mutations = await mutationsDuring(() => {
            render(readAtMs + 90_000);
        });
        expect(cell.textContent).toBe('3m 00s · ActivityTaskStarted');
        // Which is also rule 2, for free: with the clock out of the text, a pass over
        // unchanged answers is a pass that writes nothing, however long it has been.
        expect(mutations.map((m) => `${m.type} ${m.attributeName ?? ''}`.trim())).toEqual([]);
    });

    it('takes both halves away when the setting is switched off', () => {
        // Both, together. A <th> left behind after the cells are gone shifts every
        // header label one column left of its data.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor(MIXED);
        applyToTable(tbody, lookup, { ...OPTIONS, lastEventEnabled: true });
        expect(cellCounts(tbody)).toEqual([3, 3]);

        applyToTable(tbody, lookup, { ...OPTIONS, lastEventEnabled: false });

        expect(document.querySelectorAll(`.${COLUMN_HEAD_CLASS}, .${LAST_EVENT_CLASS}`)).toHaveLength(0);
        expect(cellCounts(tbody)).toEqual([2, 2]);
        // The control goes with the column it belongs to. A button left in the header
        // after the column is gone would still fire requests when pressed.
        expect(refreshButton()).toBeNull();
    });

    it('carries a refresh control that says what it does before it is pressed', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);

        applyToTable(tbody, lookupFor(MIXED), { ...OPTIONS, lastEventEnabled: true, nowMs: nextHour() });

        const button = refreshButton()!;
        // `submit` is the default, and there is no form in a Temporal UI table today —
        // which is exactly why the day somebody wraps one around it must not be the day
        // this button starts navigating the page.
        expect(button.type).toBe('button');
        // A glyph is not an accessible name, and the cost of pressing it is something a
        // user is entitled to know beforehand.
        expect(button.getAttribute('aria-label')).toBe('Refresh the last-event column');
        expect(button.title).toContain('Ask Temporal again');
        expect(button.disabled).toBe(false);
    });

    it('calls back once per press, and does not stack a handler per render pass', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor(MIXED);
        const options = { ...OPTIONS, lastEventEnabled: true, nowMs: nextHour() };

        applyToTable(tbody, lookup, options);
        const button = refreshButton()!;
        applyToTable(tbody, lookup, options);
        applyToTable(tbody, lookup, options);

        // The same node throughout: a header rebuilt every pass would lose the disabled
        // state below, and would be a DOM write on every mutation for the life of the
        // page (rule 2 at the top of render.ts).
        expect(refreshButton()).toBe(button);

        pressRefreshAt(options.nowMs);

        // Once, not three times. render.ts ASSIGNS onclick rather than adding a
        // listener, which is what makes a pass unable to accumulate handlers.
        expect(refreshPresses()).toBe(1);
    });

    it('disables itself for as long as the receiver would refuse to re-fetch', () => {
        // The button is the visible half of FRESH_FLOOR_MS in rowInfoServe.ts. It is not
        // the enforcement — anything in the page can post the message — but a control
        // that accepted a press the other side would ignore is one that reads as broken.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor(MIXED);
        const pressedAtMs = nextHour();
        const render = (nowMs: number) => applyToTable(tbody, lookup, { ...OPTIONS, lastEventEnabled: true, nowMs });

        render(pressedAtMs);
        pressRefreshAt(pressedAtMs);
        // In the same frame as the click, not at whatever the next render pass turns out
        // to be: a second press before then would be one the receiver refuses in silence.
        expect(refreshButton()!.disabled).toBe(true);

        render(pressedAtMs + FRESH_FLOOR_MS - 1);
        expect(refreshButton()!.disabled).toBe(true);

        // Re-enabled by an ordinary pass. This is the ONE thing in the feature measured
        // against the real clock — it describes how long ago the USER pressed something,
        // not how old any data is — and it is why content.ts schedules a single pass
        // FRESH_FLOOR_MS after a press. Without that one-shot, a quiet page would leave
        // the button greyed out until the next DOM mutation, whenever that came.
        render(pressedAtMs + FRESH_FLOOR_MS);
        expect(refreshButton()!.disabled).toBe(false);
        expect(refreshPresses()).toBe(1);
    });

    it('measures the cooldown from the click, not from the render that installed the handler', () => {
        // THE QUIET PAGE. Every spec above renders and clicks at the same instant, so
        // all of them passed while the press was stamped with the render's clock. A real
        // table renders when it changes and then sits there: the handler is still the one
        // installed an hour ago, and stamping the press with that pass's nowMs made the
        // floor start an hour before the button was touched. The next pass then found it
        // long elapsed and re-enabled the button on the spot.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor(MIXED);
        const render = (nowMs: number) => applyToTable(tbody, lookup, { ...OPTIONS, lastEventEnabled: true, nowMs });
        const renderedAtMs = nextHour();
        const pressedAtMs = nextHour(); // an hour later, with NO render in between

        render(renderedAtMs);
        // Enabled first, so the assertion after the press is about the press. Without
        // this the spec would pass on a button that was already disabled.
        expect(refreshButton()!.disabled).toBe(false);

        pressRefreshAt(pressedAtMs);
        render(pressedAtMs + FRESH_FLOOR_MS - 1);

        // Stamped with renderedAtMs this reads as an hour ago and the button comes back
        // straight away, one millisecond into a five-second floor.
        expect(refreshButton()!.disabled).toBe(true);
    });
});

describe('the retrying-activity badge', () => {
    it('shows the attempt count, and says what it deliberately does not read', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);

        const stats = applyToTable(tbody, lookupFor(MIXED), {
            ...OPTIONS,
            retryEnabled: true,
            info: answers({ live: { retry: A_RETRY } }),
        });

        const badge = tbody.querySelector<HTMLSpanElement>(`.${RETRY_CLASS}`)!;
        // The number is the whole point: it is what separates "failed once" from
        // "stuck since yesterday", and the status column says "Running" either way.
        expect(badge.textContent).toBe('↻ 1518');
        expect(badge.title).toContain('ChargeCard is retrying');
        expect(badge.title).toContain('attempt 1518 of unlimited'); // maximumAttempts 0 → unlimited
        expect(badge.title).toContain('failure message is deliberately not read');
        // Reported outward, because a feature whose effect cannot be seen from
        // outside the page is hard to review — the popup shows this number.
        expect(stats.retryBadges).toBe(1);
    });

    it('badges nothing when there is no retry to report', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'done', runId: DONE_RUN },
        ]);

        const stats = applyToTable(tbody, lookupFor(MIXED), {
            ...OPTIONS,
            retryEnabled: true,
            info: answers({ live: {} }),
        });

        expect(tbody.querySelectorAll(`.${RETRY_CLASS}`)).toHaveLength(0);
        expect(stats.retryBadges).toBe(0);
    });

    it('takes the badge away when the activity stops retrying, and when the setting goes off', () => {
        // The first half is the one that matters in use: an activity that finally
        // succeeds leaves `pendingActivities` empty, and a badge that stayed behind
        // would mark a healthy workflow as stuck indefinitely.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'live', runId: LIVE_RUN }]);
        const lookup = lookupFor(MIXED);
        const withRetry = { ...OPTIONS, retryEnabled: true, info: answers({ live: { retry: A_RETRY } }) };

        applyToTable(tbody, lookup, withRetry);
        expect(tbody.querySelectorAll(`.${RETRY_CLASS}`)).toHaveLength(1);

        applyToTable(tbody, lookup, { ...OPTIONS, retryEnabled: true, info: answers({ live: {} }) });
        expect(tbody.querySelectorAll(`.${RETRY_CLASS}`)).toHaveLength(0);

        applyToTable(tbody, lookup, withRetry);
        applyToTable(tbody, lookup, { ...withRetry, retryEnabled: false });
        expect(tbody.querySelectorAll(`.${RETRY_CLASS}`)).toHaveLength(0);
    });
});
