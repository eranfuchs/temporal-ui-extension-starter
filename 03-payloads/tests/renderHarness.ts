// The jsdom fixtures every render spec is written against: a family of workflows,
// a placement lookup over it, a RenderOptions with every feature off, and the
// helpers that give a table a <thead> and press the column's refresh control.
//
// WHY IT IS SHARED RATHER THAN COPIED. Four spec files drive applyToTable() —
// render.spec.ts (the table and the tree), renderLinks.spec.ts (the deep-link
// buttons), renderPayloadButton.spec.ts and renderRowInfo.spec.ts (the two features
// that cost a request) — and they must drive it against the SAME fixtures. A render
// pass writes the whole row: the tree prefix, the link buttons, the payload button
// and the two request-backed cells all land in one call, and several of the
// assertions below are about one of them not disturbing another. Per-file fixtures
// that drifted would each keep passing while the interaction between them stopped
// being tested.
//
// WHY IT IS NOT IN tests/helpers.ts. That file is lineage-SHARED across all three
// projects (see scripts/lineage.json) and is byte-identical in each, so it cannot
// hold a RenderOptions — the shape of that type is exactly what differs between the
// stages. tests/helpers.ts stays the table-and-row builder every project needs;
// this file is the render-specific layer on top of it.
//
// This file is a declared FORK rather than shared, and by one line: OPTIONS carries
// `payloadsEnabled`, which 02-techniques has no field for.

import { vi } from 'vitest';

import {
    COLUMN_LABEL_CLASS,
    COLUMN_REFRESH_CLASS,
    type Placement,
    type PlacementLookup,
    type RenderOptions,
    type RowInfoLookup,
} from '../src/decoration';
import type { RowInfo } from '../src/rowInfo/rowInfoClient';
import { buildTree } from '../src/family/tree';
import { normalizeExecutions, runKey } from '../src/family/rows';
import { apiWorkflow, fakeRunId, rowOrder } from './helpers';
import type { TemporalApiWorkflow } from '../src/types';

// How many times the header's refresh control has called back. Counted rather than
// mocked so that every spec — not only the ones about the button — would fail if a
// render pass pressed it on its own. Exposed as a function because an imported
// binding cannot be reassigned by the module that reads it.
let presses = 0;
export function refreshPresses(): number {
    return presses;
}

export const OPTIONS: RenderOptions = {
    treeEnabled: true,
    linksEnabled: false,
    payloadsEnabled: false,
    lastEventEnabled: false,
    retryEnabled: false,
    links: [],
    namespace: 'sample-namespace',
    nowMs: Date.parse('2026-01-01T12:00:00Z'),
    // Nothing answered. The specs that care supply their own.
    info: () => undefined,
    onRefresh: () => {
        presses += 1;
    },
};

export function lookupFor(executions: TemporalApiWorkflow[]): PlacementLookup {
    const ordered = buildTree(normalizeExecutions(executions));
    const byRun = new Map<string, Placement>();
    const byWorkflowId = new Map<string, Placement>();
    ordered.forEach((row, index) => {
        const placement: Placement = { sequence: index, depth: row.depth, segments: row.segments, row };
        byRun.set(runKey(row.workflowId, row.runId), placement);
        byWorkflowId.set(row.workflowId, placement);
    });
    return (workflowId, runId) =>
        (runId ? byRun.get(runKey(workflowId, runId)) : undefined) ?? byWorkflowId.get(workflowId);
}

// A family: parent + two children, with the children deliberately adjacent in
// the table but NOT next to their parent, the way a time-sorted list shows them.
export const PARENT_RUN = fakeRunId(101);
export const CHILD_A_RUN = fakeRunId(102);
export const CHILD_B_RUN = fakeRunId(103);
export const FAMILY: TemporalApiWorkflow[] = [
    apiWorkflow({ workflowId: 'parent', runId: PARENT_RUN, startTime: '2026-01-01T00:00:00Z' }),
    apiWorkflow({
        workflowId: 'child-a',
        runId: CHILD_A_RUN,
        startTime: '2026-01-01T00:01:00Z',
        parent: { workflowId: 'parent', runId: PARENT_RUN },
    }),
    apiWorkflow({
        workflowId: 'child-b',
        runId: CHILD_B_RUN,
        startTime: '2026-01-01T00:02:00Z',
        parent: { workflowId: 'parent', runId: PARENT_RUN },
    }),
    apiWorkflow({ workflowId: 'unrelated', startTime: '2026-01-01T00:03:00Z' }),
];

// Once per test, in every file that uses these fixtures.
export function resetRenderHarness(): void {
    document.body.textContent = '';
    presses = 0;
}

// jsdom delivers MutationObserver records in a microtask; a macrotask hop is the
// simplest way to be sure we have all of them.
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function mutationsDuring(action: () => void): Promise<MutationRecord[]> {
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((records) => seen.push(...records));
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
    });
    action();
    await flush();
    observer.disconnect();
    return seen;
}

// ── The two features that cost a request ─────────────────────────────────────
//
// Both render an answer that arrives LATER than the row does, which is the part
// that is easy to get wrong: an empty cell has four different meanings here, and
// three of them look like a broken extension.

// A running workflow (the only kind either feature asks about) and a closed one
// beside it, so "we deliberately do not ask" is asserted rather than assumed.
export const LIVE_RUN = fakeRunId(201);
export const DONE_RUN = fakeRunId(202);
export const MIXED: TemporalApiWorkflow[] = [
    apiWorkflow({ workflowId: 'live', runId: LIVE_RUN, status: 'RUNNING', closeTime: null }),
    apiWorkflow({ workflowId: 'done', runId: DONE_RUN, status: 'COMPLETED' }),
];

// The real table has a <thead>; the shared fixture does not build one, because
// nothing else in this repository reads it. The “Last event” column does — it has to
// put its header somewhere — so the specs for it add one. (tests/helpers.ts is
// byte-identical across the projects, per scripts/lineage.json, so it is not the
// place to grow a fixture only the stages with that column need.)
export function withHeader(tbody: HTMLTableSectionElement, labels: string[]): HTMLTableRowElement {
    const table = tbody.closest('table')!;
    const thead = table.ownerDocument.createElement('thead');
    const tr = thead.appendChild(table.ownerDocument.createElement('tr'));
    for (const label of labels) {
        tr.appendChild(table.ownerDocument.createElement('th')).textContent = label;
    }
    table.insertBefore(thead, tbody);
    return tr;
}

// The header labels as a reader sees them, ours included. Our <th> holds a label
// node AND a button, so its textContent is 'Last event⟳' — reading the label node
// where there is one is what keeps a column-ORDER assertion about order rather than
// about the glyph that happens to sit in the cell.
export function headerLabels(headRow: HTMLTableRowElement): (string | null)[] {
    return Array.from(headRow.children).map(
        (th) => th.querySelector(`.${COLUMN_LABEL_CLASS}`)?.textContent ?? th.textContent,
    );
}

export function refreshButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(`.${COLUMN_REFRESH_CLASS}`);
}

// A press at a stated instant. rowInfo/rowInfoRender.ts stamps the press with
// Date.now() — read at the CLICK and not at the render pass that installed the
// handler — so a spec about the cooldown has to be able to say when the click
// happened. jsdom offers no way to do that, which is why fake timers appear here and
// nowhere else in these files; only `Date` is faked, and only for the duration of the
// click, so nothing else in the suite runs on a simulated clock.
export function pressRefreshAt(atMs: number): void {
    vi.useFakeTimers({ toFake: ['Date'], now: atMs });
    try {
        refreshButton()!.click();
    } finally {
        vi.useRealTimers();
    }
}

// A time base for the specs that press refresh. rowInfo/rowInfoRender.ts remembers
// the last press in MODULE state — deliberately, because the UI can replace its own
// header row at any moment and a floor that reset with the node would not be a floor
// — so no spec reuses a clock reading: each starts an hour after the last, which is
// outside FRESH_FLOOR_MS whatever order the files run in.
let clockMs = OPTIONS.nowMs;
export function nextHour(): number {
    clockMs += 3_600_000;
    return clockMs;
}

// `observedAtMs` defaults to the same instant OPTIONS.nowMs names — "asked just
// now" — so the ages the specs assert read the way they would on a first pass. The
// spec that matters most about this field overrides it, because the interesting case
// is an answer that was read a while ago and has not moved.
export function answers(byWorkflowId: Record<string, Partial<RowInfo>>): RowInfoLookup {
    return (workflowId) => {
        const answer = byWorkflowId[workflowId];
        return answer
            ? { lastEvent: null, retry: null, error: null, observedAtMs: OPTIONS.nowMs, ...answer }
            : undefined;
    };
}

export const A_RETRY = {
    activityType: 'ChargeCard',
    attempt: 1518,
    maximumAttempts: null,
    nextRetryAtMs: Date.parse('2026-01-01T12:00:30Z'),
    scheduledAtMs: Date.parse('2026-01-01T11:58:00Z'),
};

// Cell counts per row, header included. A table where one row has the extra cell
// and another does not is visibly broken in a way no other assertion here catches.
export function cellCounts(tbody: HTMLTableSectionElement): number[] {
    const table = tbody.closest('table')!;
    return Array.from(table.querySelectorAll('tr')).map((tr) => tr.children.length);
}

// The page sorting its own table: the SAME <tr> elements, in a new order, which is
// what clicking a column header in the Temporal UI produces. Reversal rather than a
// named order because the point is only that the order changed underneath us —
// which rows moved where is the page's business, not this extension's.
//
// Returns the resulting order so a spec can assert against it without restating it,
// and so the reorder itself can be asserted before the behaviour under test runs.
export function hostResorts(tbody: HTMLTableSectionElement): string[] {
    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr')).reverse();
    for (const tr of rows) tbody.appendChild(tr);
    return rowOrder(tbody);
}
