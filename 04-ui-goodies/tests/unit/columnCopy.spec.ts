// @vitest-environment jsdom
//
// src/list/columnCopy.ts: the header Copy button. What matters here is not the
// button's look but three properties a reader cannot see from the code alone —
// it never sorts the table it sits in, it always reads the CURRENT column even
// after a reorder happened between drawing the button and clicking it, and every
// decoration this extension or Temporal's own list draws inside a cell is gone
// from what lands on the clipboard.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_COPY_CLASS, RETRY_CLASS } from '../../src/decoration';
import { EXTENSION_COLUMN_ATTR, HEADER_TESTID_PREFIX } from '../../src/list/columns';
import { syncHeaderCopyButtons } from '../../src/list/columnCopy';

const FEEDBACK_MS = 1200;

async function settled(): Promise<void> {
    for (let tick = 0; tick < 24; tick++) await Promise.resolve();
}

function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return { writeText };
}

// A checkbox column (structural), Workflow ID (native), Status (native), and this
// extension's own Last-event column — the same four kinds of header the model in
// src/list/columns.ts has to tell apart, wired to a real 3-row tbody.
function buildTable(statusValues: string[]): { tbody: HTMLTableSectionElement; headRow: HTMLTableRowElement } {
    const table = document.createElement('table');
    const thead = table.appendChild(document.createElement('thead'));
    const headRow = thead.appendChild(document.createElement('tr'));
    headRow.appendChild(document.createElement('th')); // checkbox, structural
    const workflowIdTh = headRow.appendChild(document.createElement('th'));
    workflowIdTh.setAttribute('data-testid', `${HEADER_TESTID_PREFIX}Workflow ID`);
    workflowIdTh.textContent = 'Workflow ID';
    const statusTh = headRow.appendChild(document.createElement('th'));
    statusTh.setAttribute('data-testid', `${HEADER_TESTID_PREFIX}Status`);
    statusTh.textContent = 'Status';
    const lastEventTh = headRow.appendChild(document.createElement('th'));
    lastEventTh.setAttribute(EXTENSION_COLUMN_ATTR, 'last-event');
    lastEventTh.textContent = 'Last event';

    const tbody = table.appendChild(document.createElement('tbody'));
    statusValues.forEach((status, i) => {
        const tr = tbody.appendChild(document.createElement('tr'));
        tr.appendChild(document.createElement('td')); // checkbox
        const idCell = tr.appendChild(document.createElement('td'));
        idCell.textContent = `wf-${i}`;
        const statusCell = tr.appendChild(document.createElement('td'));
        statusCell.textContent = status;
        tr.appendChild(document.createElement('td')); // last event, blank in these fixtures
    });

    document.body.appendChild(table);
    return { tbody, headRow };
}

function copyButtons(headRow: HTMLTableRowElement): HTMLButtonElement[] {
    return Array.from(headRow.querySelectorAll<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`));
}

beforeEach(() => {
    document.body.textContent = '';
});

it('adds one button to every native or extension header, and none to the structural one', () => {
    const { tbody, headRow } = buildTable(['Completed', 'Running', 'Failed']);
    syncHeaderCopyButtons(tbody);

    expect(copyButtons(headRow)).toHaveLength(3); // Workflow ID, Status, Last event — not the checkbox
    expect(headRow.children[0]!.querySelector(`.${HEADER_COPY_CLASS}`)).toBeNull();
});

it('is idempotent: a second pass adds nothing more', () => {
    const { tbody, headRow } = buildTable(['Completed']);
    syncHeaderCopyButtons(tbody);
    syncHeaderCopyButtons(tbody);
    expect(copyButtons(headRow)).toHaveLength(3);
});

// LIVE-VERIFIED: Temporal keeps each header's label in a `display: flex` div, which
// is block-level — a button appended after it would sit on a second line under the
// label. It has to land inside that wrapper, beside the label (see inlineHostOf in
// src/list/columns.ts), and a later pass has to recognise it there.
it('lands inside a flex label wrapper, beside the label rather than under it, and stays idempotent', () => {
    const { tbody, headRow } = buildTable(['Completed']);
    const statusTh = headRow.children[2] as HTMLElement;
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.textContent = statusTh.textContent;
    statusTh.textContent = '';
    statusTh.appendChild(wrapper);

    syncHeaderCopyButtons(tbody);
    expect(statusTh.querySelector(`.${HEADER_COPY_CLASS}`)?.parentElement).toBe(wrapper);
    syncHeaderCopyButtons(tbody);
    expect(copyButtons(headRow)).toHaveLength(3);
});

it('is keyboard-focusable and not a submit button', () => {
    const { tbody, headRow } = buildTable(['Completed']);
    syncHeaderCopyButtons(tbody);
    const button = copyButtons(headRow)[0]!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.tabIndex).not.toBe(-1);
});

it('does not trigger a click-to-sort handler on the header cell it sits in', () => {
    const { tbody, headRow } = buildTable(['Completed']);
    syncHeaderCopyButtons(tbody);
    stubClipboard();

    const sortHandler = vi.fn();
    // The native sort handler is on an ancestor of every node in the cell, in
    // every build this has been checked against — a <th> is exactly that ancestor.
    const statusTh = headRow.children[2] as HTMLTableCellElement;
    statusTh.addEventListener('click', sortHandler);

    statusTh.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!.click();
    expect(sortHandler).not.toHaveBeenCalled();
});

it('copies exactly that column’s values, one per visible row, in row order', async () => {
    const { tbody, headRow } = buildTable(['Completed', 'Running', 'Failed']);
    syncHeaderCopyButtons(tbody);
    const { writeText } = stubClipboard();

    const statusTh = headRow.children[2] as HTMLTableCellElement;
    statusTh.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!.click();
    await settled();

    expect(writeText).toHaveBeenCalledWith('Completed\nRunning\nFailed');
});

it('copies "Empty" rather than a clipboard full of blank lines', async () => {
    const { tbody, headRow } = buildTable(['', '']);
    syncHeaderCopyButtons(tbody);
    const { writeText } = stubClipboard();

    const statusTh = headRow.children[2] as HTMLTableCellElement;
    statusTh.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!.click();
    await settled();

    expect(writeText).toHaveBeenCalledWith('Empty');
});

it('strips this extension’s own decoration out of a copied cell', async () => {
    const { tbody, headRow } = buildTable(['ignored']);
    syncHeaderCopyButtons(tbody);
    const { writeText } = stubClipboard();

    // A retry badge landing in the STATUS cell, the way it would if this row were
    // decorated: the copy must read as if the badge were never drawn.
    const statusCell = tbody.querySelector('tr')!.children[2]!;
    statusCell.textContent = 'Running';
    const badge = document.createElement('span');
    badge.className = RETRY_CLASS;
    badge.textContent = '↻ 3';
    statusCell.appendChild(badge);

    const statusTh = headRow.children[2] as HTMLTableCellElement;
    statusTh.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!.click();
    await settled();

    expect(writeText).toHaveBeenCalledWith('Running');
});

it('re-reads the column’s position at click time, after the header has been reordered', async () => {
    const { tbody, headRow } = buildTable(['Completed', 'Running']);
    syncHeaderCopyButtons(tbody);
    const { writeText } = stubClipboard();

    const button = headRow.children[2]!.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!;

    // Swap Workflow ID and Status in BOTH the header and every row — the DOM
    // operation a drag-drop column reorder performs — after the button already
    // exists, and before it is clicked.
    headRow.insertBefore(headRow.children[2]!, headRow.children[1]!);
    for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
        tr.insertBefore(tr.children[2]!, tr.children[1]!);
    }

    button.click();
    await settled();

    // The button still copies the STATUS column, which is now at index 1, not
    // whatever index 2 holds after the swap.
    expect(writeText).toHaveBeenCalledWith('Completed\nRunning');
});

it('shows "Copied N" and reverts, or "Failed" and reverts, without leaving the label stuck', async () => {
    vi.useFakeTimers();
    try {
        const { tbody, headRow } = buildTable(['Completed']);
        syncHeaderCopyButtons(tbody);
        const button = headRow.children[2]!.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!;
        const originalGlyph = button.textContent;
        stubClipboard();

        button.click();
        await settled();
        expect(button.textContent).not.toBe(originalGlyph);

        vi.advanceTimersByTime(FEEDBACK_MS * 2);
        expect(button.textContent).toBe(originalGlyph);
    } finally {
        vi.useRealTimers();
    }
});

it('says the copy failed rather than swallowing a clipboard refusal', async () => {
    const { tbody, headRow } = buildTable(['Completed']);
    syncHeaderCopyButtons(tbody);
    Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        configurable: true,
    });

    const button = headRow.children[2]!.querySelector<HTMLButtonElement>(`.${HEADER_COPY_CLASS}`)!;
    const originalGlyph = button.textContent;
    button.click();
    await settled();

    expect(button.textContent).not.toBe(originalGlyph);
    expect(button.title).toMatch(/could not copy/i);
});
