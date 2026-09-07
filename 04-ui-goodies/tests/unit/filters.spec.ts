// @vitest-environment jsdom
//
// src/list/filters.ts: the NOT filter's delegated "≠" button, and Ctrl/Cmd
// augmentation of Temporal's own native filter button. What matters here is not
// the button's look but three properties a reader cannot see from the code
// alone — it never shows on a column or value it cannot build a real clause for,
// it never lets a click reach an ancestor row-click handler, and it re-reads the
// cell's value at the moment of the click rather than trusting whatever was true
// when it was drawn.
//
// installNotFilter/installFilterAugment are called ONCE at module scope below —
// exactly how content.ts calls them once from start() — and `enabled`/`navigate`
// are read through mutable closures so each test can reconfigure them without
// re-registering listeners.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HEADER_TESTID_PREFIX } from '../../src/list/columns';
import { installFilterAugment, installNotFilter, syncNotFilterHosts } from '../../src/list/filters';
import { NOT_FILTER_BUTTON_CLASS, NOT_FILTER_HOST_CLASS, NOT_FILTER_HOST_NATIVE_CLASS } from '../../src/decoration';

let enabled = true;
const navigate = vi.fn();

installNotFilter({ enabled: () => enabled, navigate });
installFilterAugment({ enabled: () => enabled, navigate });

beforeEach(() => {
    document.body.textContent = '';
    enabled = true;
    navigate.mockClear();
    window.history.pushState({}, '', '/namespaces/ns/workflows');
});

function dispatch(type: string, target: Element, opts: { relatedTarget?: EventTarget | null } = {}): void {
    const event = new Event(type, { bubbles: true });
    if ('relatedTarget' in opts) Object.defineProperty(event, 'relatedTarget', { value: opts.relatedTarget });
    target.dispatchEvent(event);
}

function click(target: Element, opts: { ctrlKey?: boolean; metaKey?: boolean } = {}): boolean {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...opts });
    return target.dispatchEvent(event);
}

function ourButton(): HTMLButtonElement | null {
    return document.querySelector(`.${NOT_FILTER_BUTTON_CLASS}`);
}

function queryParam(): string | null {
    expect(navigate).toHaveBeenCalledTimes(1);
    return new URL(navigate.mock.calls[0]![0] as string).searchParams.get('query');
}

function pushExistingQuery(query: string): void {
    const url = new URL('/namespaces/ns/workflows', location.origin);
    url.searchParams.set('query', query);
    window.history.pushState({}, '', url);
}

// One checkbox (structural), Workflow ID + Status (native, mapped), Start Time
// (native, but NOT in query.ts's mapping — every column Temporal has that this
// extension does not claim to support).
function buildFixture(): { tbody: HTMLTableSectionElement; headRow: HTMLTableRowElement } {
    const table = document.createElement('table');
    const thead = table.appendChild(document.createElement('thead'));
    const headRow = thead.appendChild(document.createElement('tr'));
    headRow.appendChild(document.createElement('th'));
    for (const label of ['Workflow ID', 'Status', 'Start Time']) {
        const th = headRow.appendChild(document.createElement('th'));
        th.setAttribute('data-testid', `${HEADER_TESTID_PREFIX}${label}`);
        th.textContent = label;
    }
    const tbody = table.appendChild(document.createElement('tbody'));
    document.body.appendChild(table);
    return { tbody, headRow };
}

function addRow(
    tbody: HTMLTableSectionElement,
    values: { id: string; status: string; start: string },
): { tr: HTMLTableRowElement; idTd: HTMLTableCellElement; statusTd: HTMLTableCellElement } {
    const tr = tbody.appendChild(document.createElement('tr'));
    tr.appendChild(document.createElement('td'));
    const idTd = tr.appendChild(document.createElement('td'));
    idTd.textContent = values.id;
    const statusTd = tr.appendChild(document.createElement('td'));
    statusTd.textContent = values.status;
    const startTd = tr.appendChild(document.createElement('td'));
    startTd.textContent = values.start;
    return { tr, idTd, statusTd };
}

describe('installNotFilter — showing the button', () => {
    it('attaches to a mapped native column with a value', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        expect(ourButton()?.parentElement).toBe(statusTd);
    });

    it('is the same shared node when relocated to a different eligible cell', () => {
        const { tbody } = buildFixture();
        const { idTd, statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        const first = ourButton();
        dispatch('pointerover', idTd);
        expect(ourButton()).toBe(first);
        expect(ourButton()?.parentElement).toBe(idTd);
        expect(document.querySelectorAll(`.${NOT_FILTER_BUTTON_CLASS}`)).toHaveLength(1);
    });

    it('does not attach to the leading structural checkbox cell', () => {
        const { tbody } = buildFixture();
        const { tr } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', tr.children[0]!);
        expect(ourButton()).toBeNull();
    });

    it('does not attach to a native column this extension does not map', () => {
        const { tbody } = buildFixture();
        const { tr } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', tr.children[3]!); // Start Time
        expect(ourButton()).toBeNull();
    });

    it('does not attach to a cell with no value', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: '', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        expect(ourButton()).toBeNull();
    });

    it('declines a value this file cannot safely quote, rather than show a broken control', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: `both ' and " here`, start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        expect(ourButton()).toBeNull();
    });

    it('never attaches while disabled, and detaches if the toggle turns off mid-hover', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        expect(ourButton()).not.toBeNull();

        enabled = false;
        dispatch('pointerover', statusTd);
        expect(ourButton()).toBeNull();
    });

    // Temporal's real Status cell wraps its badge in a `display: flex` div
    // (`data-testid="workflow-status"`), confirmed live. The button goes on the
    // CELL regardless: content.css anchors it to the cell's edge, out of the flow,
    // so the wrapper's block-level layout cannot push it onto a line of its own.
    it('attaches to the cell itself even when the value sits in a flex wrapper', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: '', start: '2026-01-01' });
        const badge = statusTd.ownerDocument.createElement('div');
        badge.setAttribute('data-testid', 'workflow-status');
        badge.style.display = 'flex';
        badge.textContent = 'Running';
        statusTd.appendChild(badge);

        dispatch('pointerover', statusTd);
        expect(ourButton()?.parentElement).toBe(statusTd);
    });

    it('attaches to the cell itself when the sole child is a link, never inside it', () => {
        const { tbody } = buildFixture();
        const { idTd } = addRow(tbody, { id: '', status: 'Running', start: '2026-01-01' });
        const link = idTd.ownerDocument.createElement('a');
        link.href = '/namespaces/ns/workflows/wf-1';
        link.style.display = 'flex';
        link.textContent = 'wf-1';
        idTd.appendChild(link);

        dispatch('pointerover', idTd);
        expect(ourButton()?.parentElement).toBe(idTd);
    });

    it('detaches when the pointer leaves the window entirely', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        expect(ourButton()).not.toBeNull();

        dispatch('pointerout', statusTd, { relatedTarget: null });
        expect(ourButton()).toBeNull();
    });
});

describe('syncNotFilterHosts — reserving the button\'s room', () => {
    it('marks every cell of a mapped native column, and no other cell', () => {
        const { tbody } = buildFixture();
        const { tr } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        syncNotFilterHosts(tbody, true);
        const marked = Array.from(tr.children).map((td) => td.classList.contains(NOT_FILTER_HOST_CLASS));
        // checkbox (structural), Workflow ID, Status, Start Time (native but unmapped)
        expect(marked).toEqual([false, true, true, false]);
    });

    it('marks a cell that already holds room for the UI\'s own filter cluster as such', () => {
        const { tbody } = buildFixture();
        const { idTd, statusTd, tr } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        idTd.classList.add('filterable'); // the shipped UI's own permanent signal
        const cluster = document.createElement('div'); // the hover-only fallback signal
        cluster.className = 'copy-or-filter';
        statusTd.appendChild(cluster);
        syncNotFilterHosts(tbody, true);
        expect(idTd.classList.contains(NOT_FILTER_HOST_NATIVE_CLASS)).toBe(true);
        expect(statusTd.classList.contains(NOT_FILTER_HOST_NATIVE_CLASS)).toBe(true);
        expect(tr.children[3]!.classList.contains(NOT_FILTER_HOST_NATIVE_CLASS)).toBe(false);
    });

    it('strips both marks when the feature is off', () => {
        const { tbody } = buildFixture();
        const { idTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        idTd.classList.add('filterable');
        syncNotFilterHosts(tbody, true);
        syncNotFilterHosts(tbody, false);
        expect(tbody.querySelectorAll(`.${NOT_FILTER_HOST_CLASS}, .${NOT_FILTER_HOST_NATIVE_CLASS}`)).toHaveLength(0);
    });

    it('writes nothing on a second pass that changes nothing', () => {
        const { tbody } = buildFixture();
        const { idTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        idTd.classList.add('filterable');
        syncNotFilterHosts(tbody, true);

        const observer = new MutationObserver(() => {});
        observer.observe(tbody, { attributes: true, childList: true, subtree: true });
        syncNotFilterHosts(tbody, true);
        const seen = observer.takeRecords();
        observer.disconnect();
        expect(seen).toEqual([]);
    });
});

describe('installNotFilter — clicking the button', () => {
    it('replaces the query on a plain click', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        pushExistingQuery('WorkflowType = "Old"');
        dispatch('pointerover', statusTd);
        click(ourButton()!);
        expect(queryParam()).toBe('ExecutionStatus != "Running"');
    });

    it('ANDs onto the existing query on a Ctrl-click', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        pushExistingQuery('WorkflowType = "Old"');
        dispatch('pointerover', statusTd);
        click(ourButton()!, { ctrlKey: true });
        expect(queryParam()).toBe('(WorkflowType = "Old") AND (ExecutionStatus != "Running")');
    });

    it('ANDs onto the existing query on a Cmd-click too', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        pushExistingQuery('WorkflowType = "Old"');
        dispatch('pointerover', statusTd);
        click(ourButton()!, { metaKey: true });
        expect(queryParam()).toBe('(WorkflowType = "Old") AND (ExecutionStatus != "Running")');
    });

    it('never lets the click reach an ancestor row-click handler', () => {
        const { tbody } = buildFixture();
        const { tr, statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const rowHandler = vi.fn();
        tr.addEventListener('click', rowHandler);
        dispatch('pointerover', statusTd);
        click(ourButton()!);
        expect(rowHandler).not.toHaveBeenCalled();
    });

    it('re-reads the cell value at click time rather than the value shown at hover time', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        const button = ourButton()!;

        // Mutate the TEXT NODE in place, the way an in-place DOM update would —
        // never touching statusTd.textContent, which would remove the button.
        statusTd.firstChild!.textContent = 'Failed';
        expect(button.parentElement).toBe(statusTd); // still attached, unmoved

        click(button);
        expect(queryParam()).toBe('ExecutionStatus != "Failed"');
    });

    it('declines the click if the value became unquotable between hover and click', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        const button = ourButton()!;

        statusTd.firstChild!.textContent = `both ' and " here`;
        click(button);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('does nothing while disabled, even if a click somehow reaches the button', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        dispatch('pointerover', statusTd);
        const button = ourButton()!;
        enabled = false;
        click(button);
        expect(navigate).not.toHaveBeenCalled();
    });
});

// A `.copy-or-filter` cluster the way Temporal's own list draws it: a filter
// button first, a copy button second, each identified by aria-label.
function buildNativeCluster(cell: HTMLTableCellElement): { filterButton: HTMLButtonElement; copyButton: HTMLButtonElement } {
    const wrapper = cell.ownerDocument.createElement('span');
    wrapper.className = 'copy-or-filter';
    const filterButton = wrapper.appendChild(cell.ownerDocument.createElement('button'));
    filterButton.className = 'copy-or-filter-button';
    filterButton.setAttribute('aria-label', 'Filter by this value');
    const copyButton = wrapper.appendChild(cell.ownerDocument.createElement('button'));
    copyButton.className = 'copy-or-filter-button';
    copyButton.setAttribute('aria-label', 'Copy this value');
    cell.appendChild(wrapper);
    return { filterButton, copyButton };
}

describe('installFilterAugment', () => {
    it('does not intercept a plain click on the native filter button', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const { filterButton } = buildNativeCluster(statusTd);
        const nativeHandler = vi.fn();
        filterButton.addEventListener('click', nativeHandler);

        click(filterButton);
        expect(navigate).not.toHaveBeenCalled();
        expect(nativeHandler).toHaveBeenCalledTimes(1);
    });

    it('intercepts a Ctrl-click on the native filter button and combines additively', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const { filterButton } = buildNativeCluster(statusTd);
        const nativeHandler = vi.fn();
        filterButton.addEventListener('click', nativeHandler);
        pushExistingQuery('WorkflowType = "Old"');

        click(filterButton, { ctrlKey: true });
        expect(queryParam()).toBe('(WorkflowType = "Old") AND (ExecutionStatus = "Running")');
        expect(nativeHandler).not.toHaveBeenCalled();
    });

    it('intercepts a Cmd-click the same way', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const { filterButton } = buildNativeCluster(statusTd);

        click(filterButton, { metaKey: true });
        expect(queryParam()).toBe('ExecutionStatus = "Running"');
    });

    it('never intercepts the copy button in the same cluster — the mandatory negative control', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const { copyButton } = buildNativeCluster(statusTd);
        const nativeHandler = vi.fn();
        copyButton.addEventListener('click', nativeHandler);

        click(copyButton, { ctrlKey: true });
        expect(navigate).not.toHaveBeenCalled();
        expect(nativeHandler).toHaveBeenCalledTimes(1);
    });

    it('falls back to cluster position when neither button has a recognisable label', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const wrapper = statusTd.ownerDocument.createElement('span');
        wrapper.className = 'copy-or-filter';
        const first = wrapper.appendChild(document.createElement('button'));
        first.className = 'copy-or-filter-button';
        const second = wrapper.appendChild(document.createElement('button'));
        second.className = 'copy-or-filter-button';
        statusTd.appendChild(wrapper);

        click(first, { ctrlKey: true });
        expect(queryParam()).toBe('ExecutionStatus = "Running"');

        navigate.mockClear();
        click(second, { ctrlKey: true });
        expect(navigate).not.toHaveBeenCalled();
    });

    it('never intercepts while disabled', () => {
        const { tbody } = buildFixture();
        const { statusTd } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const { filterButton } = buildNativeCluster(statusTd);
        enabled = false;

        click(filterButton, { ctrlKey: true });
        expect(navigate).not.toHaveBeenCalled();
    });

    it('declines when the column is not one this extension maps', () => {
        const { tbody } = buildFixture();
        const { tr } = addRow(tbody, { id: 'wf-1', status: 'Running', start: '2026-01-01' });
        const startTd = tr.children[3] as HTMLTableCellElement;
        const { filterButton } = buildNativeCluster(startTd);

        click(filterButton, { ctrlKey: true });
        expect(navigate).not.toHaveBeenCalled();
    });
});
