// @vitest-environment jsdom
//
// These specs exist because the two worst bugs this feature ever had were both
// invisible to a reading of the code and obvious to a DOM assertion:
//   • a non-idempotent write, which turned the MutationObserver into an infinite
//     render loop and 100% of a CPU core;
//   • trusting a cached attribute for row identity, which after the UI recycled a
//     <tr> reported the previous row's workflow id and made the tree render flat.
// Both are asserted below.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ACTIVITY_LINKS_CLASS,
    applyToTable,
    COLUMN_HEAD_CLASS,
    COLUMN_LABEL_CLASS,
    COLUMN_REFRESH_CLASS,
    findWorkflowTbody,
    idsFromRow,
    LAST_EVENT_CLASS,
    LINK_BAR_CLASS,
    LINK_BLOCKED_CLASS,
    LINK_CLASS,
    namespaceFromLocation,
    PANEL_CLASS,
    PAYLOAD_CLASS,
    PREFIX_CLASS,
    removeAllDecoration,
    RETRY_CLASS,
    SEGMENT_WIDTH_PX,
    visibleRows,
    type Placement,
    type PlacementLookup,
    type RenderOptions,
    type RowInfoLookup,
} from '../../src/render';
import type { RowInfo } from '../../src/rowInfoClient';
import { FRESH_FLOOR_MS } from '../../src/rowInfo';
import { buildTree } from '../../src/tree';
import { normalizeExecutions, runKey } from '../../src/rows';
import { apiWorkflow, buildWorkflowTable, fakeRunId, rowOrder, workflowLink } from '../helpers';
import type { TemporalApiWorkflow } from '../../src/types';

// How many times the header's refresh control has called back. Counted rather than
// mocked so that every spec below — not only the ones about the button — would fail
// if a render pass pressed it on its own.
let refreshPresses = 0;

const OPTIONS: RenderOptions = {
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
        refreshPresses += 1;
    },
};

function lookupFor(executions: TemporalApiWorkflow[]): PlacementLookup {
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
const PARENT_RUN = fakeRunId(101);
const CHILD_A_RUN = fakeRunId(102);
const CHILD_B_RUN = fakeRunId(103);
const FAMILY: TemporalApiWorkflow[] = [
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

beforeEach(() => {
    document.body.textContent = '';
    refreshPresses = 0;
});

// jsdom delivers MutationObserver records in a microtask; a macrotask hop is the
// simplest way to be sure we have all of them.
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function mutationsDuring(action: () => void): Promise<MutationRecord[]> {
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

describe('finding the table', () => {
    it('picks the tbody that holds workflow links, not the first tbody on the page', () => {
        const decoy = document.createElement('table');
        decoy.appendChild(document.createElement('tbody')).appendChild(document.createElement('tr'));
        document.body.appendChild(decoy);
        const real = buildWorkflowTable(document, [{ workflowId: 'a', runId: fakeRunId(1) }]);
        expect(findWorkflowTbody(document)).toBe(real);
    });

    it('returns null on a page with no workflow table', () => {
        expect(findWorkflowTbody(document)).toBeNull();
    });
});

describe('reading a row', () => {
    it('reads ids out of the href, both UI shapes', () => {
        const runId = fakeRunId(2);
        const withRun = document.createElement('tr');
        withRun.appendChild(document.createElement('td')).appendChild(
            workflowLink(document, { workflowId: 'order|42', runId }),
        );
        expect(idsFromRow(withRun)).toEqual({ workflowId: 'order|42', runId });

        // Cloud's own link is /workflows/{id}/timeline — "timeline" is not a run.
        const withoutRun = document.createElement('tr');
        withoutRun.appendChild(document.createElement('td')).appendChild(
            workflowLink(document, { workflowId: 'order|42', runId: null }),
        );
        expect(idsFromRow(withoutRun)).toEqual({ workflowId: 'order|42', runId: null });
    });

    it('returns null for a row with no workflow link', () => {
        const tr = document.createElement('tr');
        tr.appendChild(document.createElement('td')).textContent = 'Loading…';
        expect(idsFromRow(tr)).toBeNull();
    });
});

describe('applyToTable', () => {
    it('groups children under their parent and indents them', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'unrelated' },
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);

        const stats = applyToTable(tbody, lookupFor(FAMILY), OPTIONS);

        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'child-b', 'unrelated']);
        expect(stats).toMatchObject({ rowsSeen: 4, rowsMatched: 4, rowsIndented: 2, reordered: true });

        const childRow = Array.from(tbody.querySelectorAll('tr'))[1]!;
        const prefix = childRow.querySelector(`.${PREFIX_CLASS}`)!;
        expect(prefix.getAttribute('data-tuis-segments')).toBe('branch');
        expect(prefix.children).toHaveLength(1);
        expect(childRow.querySelector('a')!.style.marginLeft).toBe(`${SEGMENT_WIDTH_PX}px`);

        // A root keeps its natural indent — no overlay, no margin.
        const parentRow = Array.from(tbody.querySelectorAll('tr'))[0]!;
        expect(parentRow.querySelector(`.${PREFIX_CLASS}`)).toBeNull();
        expect(parentRow.querySelector('a')!.style.marginLeft).toBe('');
    });

    it('writes nothing at all on a second pass', async () => {
        // THE most important assertion in this repository. A single unconditional
        // write here becomes an infinite loop in the browser, because the
        // MutationObserver that drives this function sees its own output.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
            // A RUNNING row as well. The two request-backed features draw nothing
            // on a closed workflow, so a family of closed ones would leave their
            // write paths — the newest ones — out of the one assertion that has to
            // cover all of them. (MIXED, withHeader, answers and A_RETRY are
            // declared with the specs for those features, further down this file.)
            { workflowId: 'live', runId: LIVE_RUN },
        ]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        const lookup = lookupFor([...FAMILY, ...MIXED]);
        // Everything on at once, so the assertion covers every write path in the
        // file rather than the tree alone.
        const options = {
            ...OPTIONS,
            linksEnabled: true,
            payloadsEnabled: true,
            lastEventEnabled: true,
            retryEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }],
            info: answers({
                live: {
                    lastEvent: { eventId: '42', eventType: 'ActivityTaskStarted', timeMs: OPTIONS.nowMs - 180_000 },
                    retry: A_RETRY,
                },
            }),
        };

        applyToTable(tbody, lookup, options);
        // Every write path really did write on the first pass. Without this the test
        // would still pass if a feature drew nothing at all — an assertion about
        // idempotency is trivially satisfied by doing nothing twice.
        expect(tbody.querySelectorAll(`.${PREFIX_CLASS}`).length).toBeGreaterThan(0);
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`).length).toBeGreaterThan(0);
        expect(tbody.querySelectorAll(`.${LAST_EVENT_CLASS}`).length).toBeGreaterThan(0);
        expect(document.querySelectorAll(`.${COLUMN_HEAD_CLASS}`)).toHaveLength(1);
        expect(tbody.querySelectorAll(`.${RETRY_CLASS}`)).toHaveLength(1);

        const mutations = await mutationsDuring(() => {
            applyToTable(tbody, lookup, options);
        });

        expect(mutations.map((m) => `${m.type} ${m.attributeName ?? ''}`.trim())).toEqual([]);
    });

    it('follows a recycled <tr> to its new workflow', async () => {
        // The UI reuses the same <tr> element for a different workflow and only
        // updates the link. Anything that caches identity on the element is wrong
        // from this moment on.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, OPTIONS);

        const recycled = Array.from(tbody.querySelectorAll('tr'))[1]!;
        expect(recycled.getAttribute('data-tuis-workflow-id')).toBe('child-a');

        // The page now shows a root in that same element.
        recycled.querySelector('a')!.replaceWith(workflowLink(document, { workflowId: 'unrelated' }));
        applyToTable(tbody, lookup, OPTIONS);

        expect(recycled.getAttribute('data-tuis-workflow-id')).toBe('unrelated');
        expect(recycled.querySelector(`.${PREFIX_CLASS}`)).toBeNull();
        expect(recycled.querySelector('a')!.style.marginLeft).toBe('');
    });

    it('leaves rows it has no data for in place, after the ones it knows', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'mystery-1' },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
            { workflowId: 'mystery-2' },
            { workflowId: 'parent', runId: PARENT_RUN },
        ]);

        const stats = applyToTable(tbody, lookupFor(FAMILY), OPTIONS);

        // Unknown rows are neither hidden nor dropped: a row we cannot explain is
        // still a row the user asked to see.
        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'mystery-1', 'mystery-2']);
        expect(stats.rowsSeen).toBe(4);
        expect(stats.rowsMatched).toBe(2);
    });

    it('restores the original order when the tree is switched off', () => {
        const original = [
            { workflowId: 'child-b', runId: CHILD_B_RUN },
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ];
        const tbody = buildWorkflowTable(document, original);
        const lookup = lookupFor(FAMILY);

        applyToTable(tbody, lookup, OPTIONS);
        expect(rowOrder(tbody)).toEqual(['parent', 'child-a', 'child-b']);

        applyToTable(tbody, lookup, { ...OPTIONS, treeEnabled: false });
        expect(rowOrder(tbody)).toEqual(['child-b', 'parent', 'child-a']);
        expect(tbody.querySelectorAll(`.${PREFIX_CLASS}`)).toHaveLength(0);
        expect(Array.from(tbody.querySelectorAll('a')).every((a) => a.style.marginLeft === '')).toBe(true);
    });
});

describe('deep links', () => {
    const links = [
        { label: 'Logs', urlTemplate: 'https://example.com/search?q={workflowId}&ns={namespace}' },
        { label: 'Traces', urlTemplate: 'https://example.com/traces?run={runId}' },
    ];

    it('adds one button per configured link, expanded for that row', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, linksEnabled: true, links });

        const anchors = Array.from(tbody.querySelectorAll<HTMLAnchorElement>(`.${LINK_CLASS}`));
        expect(anchors.map((a) => a.textContent)).toEqual(['Logs', 'Traces']);
        expect(anchors[0]!.getAttribute('href')).toBe(
            'https://example.com/search?q=child-a&ns=sample-namespace',
        );
        expect(anchors[1]!.getAttribute('href')).toBe(`https://example.com/traces?run=${CHILD_A_RUN}`);
        // Both matter: window.opener would hand the third-party tool a handle on
        // the Temporal tab, and the Referer would hand it the namespace and
        // workflow id on every click.
        expect(anchors[0]!.rel).toBe('noopener noreferrer');
        expect(anchors[0]!.referrerPolicy).toBe('no-referrer');
        expect(anchors[0]!.target).toBe('_blank');
    });

    it('removes buttons when a link is deleted from settings', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links });
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links: links.slice(0, 1) });
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`)).toHaveLength(1);

        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: false, links });
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`)).toHaveLength(0);
    });

    it('renders a button with NO href when the template is not an http(s) URL', async () => {
        // The template is a settings string, and the expanded URL can take its
        // scheme from the workflow data, so this is the last line before a
        // `javascript:` href sits in the Temporal page waiting to be clicked.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const options = {
            ...OPTIONS,
            linksEnabled: true,
            links: [{ label: 'Bad', urlTemplate: 'javascript:alert(1)' }],
        };
        applyToTable(tbody, lookupFor(FAMILY), options);

        // The blocked path is a render path too, so it obeys rule 2 as well: a
        // class written unconditionally is the same infinite loop.
        const mutations = await mutationsDuring(() => {
            applyToTable(tbody, lookupFor(FAMILY), options);
        });
        expect(mutations).toEqual([]);

        const anchor = tbody.querySelector<HTMLAnchorElement>(`.${LINK_CLASS}`)!;
        // Still rendered — a button that silently disappears reads as a broken
        // extension and has nowhere to explain itself.
        expect(anchor.textContent).toBe('Bad');
        expect(anchor.hasAttribute('href')).toBe(false);
        expect(anchor.classList.contains(LINK_BLOCKED_CLASS)).toBe(true);
        expect(anchor.title).toContain('http');
    });

    it('takes the href back when a template is edited into something unsafe', () => {
        // Same anchor, re-rendered: the attribute has to be REMOVED, not merely
        // left unwritten, or the previous safe URL stays clickable forever.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links: links.slice(0, 1) });
        const anchor = tbody.querySelector<HTMLAnchorElement>(`.${LINK_CLASS}`)!;
        expect(anchor.hasAttribute('href')).toBe(true);

        applyToTable(tbody, lookup, {
            ...OPTIONS,
            linksEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'javascript:alert(1)' }],
        });
        expect(tbody.querySelector(`.${LINK_CLASS}`)).toBe(anchor); // the same node
        expect(anchor.hasAttribute('href')).toBe(false);

        // …and gives it back when the template is fixed.
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links: links.slice(0, 1) });
        expect(anchor.classList.contains(LINK_BLOCKED_CLASS)).toBe(false);
        expect(anchor.getAttribute('href')).toContain('https://example.com/search');
    });

    it('does not add a button to a row it has no data for', () => {
        // Without a row there is nothing to put in the template, and a button
        // that searches for "{workflowId}" is worse than no button.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'not-in-the-api-response' }]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, linksEnabled: true, links });
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`)).toHaveLength(0);
    });
});

describe('the payload button', () => {
    it('adds one per row and carries no row identity on it', () => {
        // THE ABSENCE IS THE ASSERTION, and it is checked over every attribute
        // rather than over the ones this file happens to set — a title, a data-*,
        // an aria-label added later would each look harmless. A button holding a
        // workflow id would be wrong the moment the UI recycles the <tr> under it,
        // so the panel reads the row from the cell's href at hover time instead.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, payloadsEnabled: true });

        const buttons = Array.from(tbody.querySelectorAll<HTMLButtonElement>(`.${PAYLOAD_CLASS}`));
        expect(buttons).toHaveLength(2);
        // type=button: inside a form, a button with no type submits it.
        expect(buttons[0]!.type).toBe('button');
        expect(buttons[0]!.getAttribute('aria-label')).toBeTruthy();
        for (const button of buttons) {
            for (const attribute of Array.from(button.attributes)) {
                expect(attribute.value).not.toContain('parent');
                expect(attribute.value).not.toContain(PARENT_RUN);
            }
        }
    });

    it('omits the button on a row it has no run id for', () => {
        // The history request needs a run id. A button that could only ever fail is
        // worse than no button.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'not-in-the-api-response' }]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, payloadsEnabled: true });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(0);
    });

    it('removes the buttons when the setting is switched off, and puts them back', () => {
        // Both directions. A remove-only implementation passes the first half and
        // leaves the toggle dead in the one direction a user notices.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: true });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(1);

        applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: false });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(0);

        applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: true });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(1);
    });

    it('puts the links before the button whichever feature was switched on first', () => {
        // The order on screen must not depend on the order the toggles were used in.
        // Both controls are created with appendChild, so this spec fails the moment
        // syncControlOrder stops running — and it fails only in the second half,
        // which is the half no screenshot of a fresh install would ever show.
        const links = [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }];
        const order = (tbody: HTMLTableSectionElement): string[] => {
            const cell = tbody.querySelector<HTMLTableCellElement>('td')!;
            return Array.from(cell.children)
                .filter((node) => node.classList.contains(LINK_CLASS) || node.classList.contains(PAYLOAD_CLASS))
                .map((node) => (node.classList.contains(LINK_CLASS) ? 'link' : 'payload'));
        };

        const both = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        applyToTable(both, lookupFor(FAMILY), { ...OPTIONS, linksEnabled: true, links, payloadsEnabled: true });
        expect(order(both)).toEqual(['link', 'payload']);

        const later = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        // Payload button first, deep links only afterwards — the append order that
        // used to decide it, and the one that produced the wrong order.
        applyToTable(later, lookup, { ...OPTIONS, payloadsEnabled: true });
        applyToTable(later, lookup, { ...OPTIONS, payloadsEnabled: true, linksEnabled: true, links });
        expect(order(later)).toEqual(['link', 'payload']);
    });

    it('adds exactly one button however many passes run', () => {
        // A second button per pass would be invisible in a screenshot and obvious in
        // the DOM, which is the combination this whole spec file exists for.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        for (let pass = 0; pass < 3; pass++) {
            applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: true });
        }
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(1);
    });
});

// ── The two features that cost a request ─────────────────────────────────────
//
// Both render an answer that arrives LATER than the row does, which is the part
// that is easy to get wrong: an empty cell has four different meanings here, and
// three of them look like a broken extension.

// A running workflow (the only kind either feature asks about) and a closed one
// beside it, so "we deliberately do not ask" is asserted rather than assumed.
const LIVE_RUN = fakeRunId(201);
const DONE_RUN = fakeRunId(202);
const MIXED: TemporalApiWorkflow[] = [
    apiWorkflow({ workflowId: 'live', runId: LIVE_RUN, status: 'RUNNING', closeTime: null }),
    apiWorkflow({ workflowId: 'done', runId: DONE_RUN, status: 'COMPLETED' }),
];

// The real table has a <thead>; the shared fixture does not build one, because
// nothing else in this repository reads it. The column does — it has to put its
// header somewhere — so these specs add one. (tests/helpers.ts is byte-identical
// across the projects, per scripts/lineage.json, so it is not the place to grow a
// fixture only 02 needs.)
function withHeader(tbody: HTMLTableSectionElement, labels: string[]): HTMLTableRowElement {
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
function headerLabels(headRow: HTMLTableRowElement): (string | null)[] {
    return Array.from(headRow.children).map(
        (th) => th.querySelector(`.${COLUMN_LABEL_CLASS}`)?.textContent ?? th.textContent,
    );
}

function refreshButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(`.${COLUMN_REFRESH_CLASS}`);
}

// A press at a stated instant. render.ts stamps the press with Date.now() — read at
// the CLICK and not at the render pass that installed the handler — so a spec about
// the cooldown has to be able to say when the click happened. jsdom offers no way to
// do that, which is why fake timers appear here and nowhere else in this file; only
// `Date` is faked, and only for the duration of the click, so nothing else in the
// suite runs on a simulated clock.
function pressRefreshAt(atMs: number): void {
    vi.useFakeTimers({ toFake: ['Date'], now: atMs });
    try {
        refreshButton()!.click();
    } finally {
        vi.useRealTimers();
    }
}

// A time base for the specs that press refresh. render.ts remembers the last press
// in MODULE state — deliberately, because the UI can replace its own header row at
// any moment and a floor that reset with the node would not be a floor — so no spec
// here reuses a clock reading: each starts an hour after the last, which is outside
// FRESH_FLOOR_MS whatever order the file runs in.
let clockMs = OPTIONS.nowMs;
function nextHour(): number {
    clockMs += 3_600_000;
    return clockMs;
}

// `observedAtMs` defaults to the same instant OPTIONS.nowMs names — "asked just
// now" — so the ages the specs below assert read the way they would on a first
// pass. The spec that matters most about this field overrides it, because the
// interesting case is an answer that was read a while ago and has not moved.
function answers(byWorkflowId: Record<string, Partial<RowInfo>>): RowInfoLookup {
    return (workflowId) => {
        const answer = byWorkflowId[workflowId];
        return answer
            ? { lastEvent: null, retry: null, error: null, observedAtMs: OPTIONS.nowMs, ...answer }
            : undefined;
    };
}

const A_RETRY = {
    activityType: 'ChargeCard',
    attempt: 1518,
    maximumAttempts: null,
    nextRetryAtMs: Date.parse('2026-01-01T12:00:30Z'),
    scheduledAtMs: Date.parse('2026-01-01T11:58:00Z'),
};

// Cell counts per row, header included. A table where one row has the extra cell
// and another does not is visibly broken in a way no other assertion here catches.
function cellCounts(tbody: HTMLTableSectionElement): number[] {
    const table = tbody.closest('table')!;
    return Array.from(table.querySelectorAll('tr')).map((tr) => tr.children.length);
}

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
        expect(refreshPresses).toBe(0);
        // The payload button is a child of the id cell, not a sibling of it, so it
        // does not come between the id and this column.
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
        expect(refreshPresses).toBe(1);
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
        expect(refreshPresses).toBe(1);
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

describe('visibleRows', () => {
    it('reports the rows the table is showing, in table order', () => {
        // This list is what becomes requests, one per running row, so it must be
        // the rows on SCREEN and not the rows in the last list response — the page
        // fetches more than it draws.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'done', runId: DONE_RUN },
            { workflowId: 'live', runId: LIVE_RUN },
            { workflowId: 'not-in-the-api-response' },
        ]);
        const lookup = lookupFor(MIXED);

        expect(visibleRows(tbody, lookup).map((row) => row.workflowId)).toEqual(['done', 'live']);

        // …and in the order the tree put them, once the rows have been reordered.
        applyToTable(tbody, lookup, OPTIONS);
        expect(visibleRows(tbody, lookup).map((row) => row.workflowId)).toEqual(['live', 'done']);
    });
});

describe('removeAllDecoration', () => {
    it('leaves the table as it found it', () => {
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        withHeader(tbody, ['Workflow ID', 'Status']);
        applyToTable(tbody, lookupFor(FAMILY), {
            ...OPTIONS,
            linksEnabled: true,
            payloadsEnabled: true,
            lastEventEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }],
        });
        // None of the three is in the table: the panel floats over one, the link bar
        // sits in a workflow page's own layout and an activity group sits inside a
        // panel of the UI's. The master switch has to take all three away, or "off"
        // does not mean off — and this function is the only place that knows the full
        // list. The payload panel is the one that matters most: it is the only node
        // this extension draws that has decoded payload text in it.
        const panel = document.createElement('div');
        panel.className = PANEL_CLASS;
        const bar = document.createElement('div');
        bar.className = LINK_BAR_CLASS;
        const activityLinks = document.createElement('span');
        activityLinks.className = ACTIVITY_LINKS_CLASS;
        document.body.append(panel, bar, activityLinks);

        removeAllDecoration(document);

        expect(
            document.querySelectorAll(
                `.${PREFIX_CLASS}, .${LINK_CLASS}, .${PAYLOAD_CLASS}, .${PANEL_CLASS}, .${RETRY_CLASS}, .${LINK_BAR_CLASS}, .${ACTIVITY_LINKS_CLASS}, .${LAST_EVENT_CLASS}, .${COLUMN_HEAD_CLASS}`,
            ),
        ).toHaveLength(0);
        expect(Array.from(tbody.querySelectorAll('a')).every((a) => a.style.marginLeft === '')).toBe(true);
    });
});

describe('namespaceFromLocation', () => {
    it('reads the namespace out of both UIs’ paths', () => {
        expect(namespaceFromLocation('/namespaces/sample-namespace/workflows')).toBe('sample-namespace');
        expect(namespaceFromLocation('/namespaces/with%20space/workflows/x/y/history')).toBe('with space');
        expect(namespaceFromLocation('/settings')).toBeNull();
    });
});
