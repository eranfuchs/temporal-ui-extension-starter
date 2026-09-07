// @vitest-environment jsdom
//
// src/list/columns.ts: the shared column-identity model. Three questions, three
// groups of specs below — what is this column (native / ours / structural), which
// one column does a key mean right now, and what is a cell's text once every
// button and badge this extension or Temporal's own list draws inside it is gone.

import { beforeEach, describe, expect, it } from 'vitest';

import {
    LINK_CLASS,
    PAYLOAD_INPUT_CLASS,
    PAYLOAD_OUTPUT_CLASS,
    PREFIX_CLASS,
    RETRY_CLASS,
} from '../../src/decoration';
import {
    EXTENSION_COLUMN_ATTR,
    findByKey,
    HEADER_TESTID_PREFIX,
    LAST_EVENT_COLUMN_KEY,
    readColumns,
    visibleText,
} from '../../src/list/columns';

function headerRow(doc: Document, cells: Array<{ testid?: string; ext?: string; text?: string }>): HTMLTableRowElement {
    const table = doc.createElement('table');
    const thead = table.appendChild(doc.createElement('thead'));
    const tr = thead.appendChild(doc.createElement('tr'));
    for (const cell of cells) {
        const th = tr.appendChild(doc.createElement('th'));
        if (cell.testid) th.setAttribute('data-testid', cell.testid);
        if (cell.ext) th.setAttribute(EXTENSION_COLUMN_ATTR, cell.ext);
        th.textContent = cell.text ?? '';
    }
    doc.body.appendChild(table);
    return tr;
}

beforeEach(() => {
    document.body.textContent = '';
});

describe('readColumns', () => {
    it('identifies a native column by the testid suffix, not by its text', () => {
        const tr = headerRow(document, [{ testid: `${HEADER_TESTID_PREFIX}Status`, text: 'Status ▾' }]);
        const [column] = readColumns(tr);
        expect(column).toMatchObject({ key: 'Status', label: 'Status', origin: 'native', index: 0 });
    });

    it('identifies an extension column by its marker, with its label read from the DOM', () => {
        const tr = headerRow(document, [{ ext: LAST_EVENT_COLUMN_KEY, text: 'Last event' }]);
        const [column] = readColumns(tr);
        expect(column).toMatchObject({ key: LAST_EVENT_COLUMN_KEY, label: 'Last event', origin: 'extension' });
    });

    it('calls a cell with neither marker structural, never native', () => {
        // The leading select-all checkbox and a spacer: Temporal's own header row
        // has cells with no testid of their own.
        const tr = headerRow(document, [{ text: '' }, { testid: `${HEADER_TESTID_PREFIX}Workflow ID`, text: 'Workflow ID' }]);
        const [checkbox, workflowId] = readColumns(tr);
        expect(checkbox?.origin).toBe('structural');
        expect(workflowId?.origin).toBe('native');
    });

    it('reflects the header row’s live order, including after Temporal reorders it', () => {
        const tr = headerRow(document, [
            { testid: `${HEADER_TESTID_PREFIX}Status`, text: 'Status' },
            { testid: `${HEADER_TESTID_PREFIX}Workflow ID`, text: 'Workflow ID' },
        ]);
        expect(readColumns(tr).map((c) => c.key)).toEqual(['Status', 'Workflow ID']);

        // The same two <th> elements, swapped — the DOM operation a drag-drop
        // reorder performs, and the one a "live index" claim has to survive.
        tr.insertBefore(tr.children[1]!, tr.children[0]!);
        expect(readColumns(tr).map((c) => c.key)).toEqual(['Workflow ID', 'Status']);
    });
});

describe('findByKey', () => {
    it('finds the one column claiming a key', () => {
        const tr = headerRow(document, [{ testid: `${HEADER_TESTID_PREFIX}Status`, text: 'Status' }]);
        expect(findByKey(readColumns(tr), 'Status')?.origin).toBe('native');
    });

    it('fails open on a missing key: no column, not a guess', () => {
        const tr = headerRow(document, [{ testid: `${HEADER_TESTID_PREFIX}Status`, text: 'Status' }]);
        expect(findByKey(readColumns(tr), 'Nonexistent')).toBeUndefined();
    });

    it('fails open on a duplicate key: neither claimant is returned', () => {
        // Two columns cannot both legitimately claim one key — an extension bug, a
        // Temporal build with a repeated label — and the point of failing open is
        // that this returns nothing rather than the first or the last match.
        const tr = headerRow(document, [
            { testid: `${HEADER_TESTID_PREFIX}Status`, text: 'Status (1)' },
            { testid: `${HEADER_TESTID_PREFIX}Status`, text: 'Status (2)' },
        ]);
        expect(findByKey(readColumns(tr), 'Status')).toBeUndefined();
    });

    it('never resolves a structural column, even by its own generated key', () => {
        const tr = headerRow(document, [{ text: '' }]);
        const [structural] = readColumns(tr);
        expect(findByKey(readColumns(tr), structural!.key)).toBeUndefined();
    });
});

describe('visibleText', () => {
    it('reads plain text unchanged', () => {
        const td = document.createElement('td');
        td.textContent = 'Completed';
        expect(visibleText(td)).toBe('Completed');
    });

    it('strips this extension’s own controls out of a workflow-id cell with every decoration on', () => {
        const td = document.createElement('td');
        td.append(
            span(PREFIX_CLASS, ''),
            document.createTextNode('order-42'),
            anchor(LINK_CLASS, 'Logs'),
            button(PAYLOAD_INPUT_CLASS, '{ }'),
            button(PAYLOAD_OUTPUT_CLASS, '{ }'),
            span(RETRY_CLASS, '↻ 3'),
        );
        expect(visibleText(td)).toBe('order-42');
    });

    it('strips Temporal’s own filter-or-copy button', () => {
        const td = document.createElement('td');
        const wrapper = document.createElement('span');
        wrapper.className = 'copy-or-filter';
        const filterButton = document.createElement('button');
        filterButton.className = 'copy-or-filter-button';
        filterButton.textContent = '⋯';
        wrapper.appendChild(filterButton);
        td.append(document.createTextNode('sample-task-queue'), wrapper);
        expect(visibleText(td)).toBe('sample-task-queue');
    });

    it('strips the Last-event column’s own refresh button out of its header label', () => {
        const th = document.createElement('th');
        th.append(span('tuis-col-label', 'Last event'), button('tuis-col-refresh', '⟳'));
        expect(visibleText(th)).toBe('Last event');
    });

    it('collapses internal whitespace left behind by removed nodes', () => {
        const td = document.createElement('td');
        td.append(document.createTextNode('a  '), span(RETRY_CLASS, '↻'), document.createTextNode('  b'));
        expect(visibleText(td)).toBe('a b');
    });

    it('renders an all-decoration, no-visible-text cell as empty, not as whitespace', () => {
        const td = document.createElement('td');
        td.append(span(RETRY_CLASS, '↻ 3'));
        expect(visibleText(td)).toBe('');
    });
});

function span(className: string, text: string): HTMLSpanElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
}

function button(className: string, text: string): HTMLButtonElement {
    const el = document.createElement('button');
    el.className = className;
    el.textContent = text;
    return el;
}

function anchor(className: string, text: string): HTMLAnchorElement {
    const el = document.createElement('a');
    el.className = className;
    el.textContent = text;
    return el;
}
