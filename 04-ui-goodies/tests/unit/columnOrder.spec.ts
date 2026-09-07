// @vitest-environment jsdom
//
// src/list/columnOrder.ts: the pure permutation math behind column reordering.
// No DOM assertions here — columnReorder.spec.ts covers the layer that actually
// moves nodes — only whether a stored order, a keyboard step and a drop are
// translated into the right full order.

import { beforeEach, describe, expect, it } from 'vitest';

import type { ColumnInfo, ColumnOrigin } from '../../src/list/columns';
import { effectiveKeyOrder, moveKey, moveKeyBeside, reorderColumns } from '../../src/list/columnOrder';

function col(key: string, origin: ColumnOrigin, index: number): ColumnInfo {
    // Only key/origin/index drive this file's logic; `th` and `label` are never
    // read by it, so a bare placeholder element is enough.
    return { key, label: key, origin, index, th: document.createElement(origin === 'structural' ? 'th' : 'th') };
}

beforeEach(() => {
    document.body.textContent = '';
});

const COLUMNS: ColumnInfo[] = [
    col('structural-0', 'structural', 0),
    col('Workflow ID', 'native', 1),
    col('Status', 'native', 2),
    col('Type', 'native', 3),
    col('last-event', 'extension', 4),
];

describe('reorderColumns', () => {
    it('is a no-op for an empty order: every column is "unmentioned" and keeps its place', () => {
        expect(reorderColumns(COLUMNS, []).map((c) => c.key)).toEqual(COLUMNS.map((c) => c.key));
    });

    it('places the named columns first, in the order given, structural column untouched', () => {
        const result = reorderColumns(COLUMNS, ['Type', 'Workflow ID']);
        expect(result.map((c) => c.key)).toEqual(['structural-0', 'Type', 'Workflow ID', 'Status', 'last-event']);
        // The checkbox is the exact same ColumnInfo, at the exact same slot.
        expect(result[0]).toBe(COLUMNS[0]);
    });

    it('sorts every unmentioned column after every mentioned one, keeping their own relative order', () => {
        const result = reorderColumns(COLUMNS, ['last-event']);
        expect(result.map((c) => c.key)).toEqual(['structural-0', 'last-event', 'Workflow ID', 'Status', 'Type']);
    });

    it('ignores a key in the order that no current column claims', () => {
        const result = reorderColumns(COLUMNS, ['Nonexistent', 'Status']);
        expect(result.map((c) => c.key)).toEqual(['structural-0', 'Status', 'Workflow ID', 'Type', 'last-event']);
    });
});

describe('effectiveKeyOrder', () => {
    it('is exactly the reorderable keys, in the order reorderColumns() would place them', () => {
        expect(effectiveKeyOrder(COLUMNS, ['Type'])).toEqual(['Type', 'Workflow ID', 'Status', 'last-event']);
    });

    it('never includes a structural key', () => {
        expect(effectiveKeyOrder(COLUMNS, [])).not.toContain('structural-0');
    });
});

describe('moveKey', () => {
    const order = ['Workflow ID', 'Status', 'Type'];

    it('swaps a column one step toward the front', () => {
        expect(moveKey(order, 'Status', -1)).toEqual(['Status', 'Workflow ID', 'Type']);
    });

    it('swaps a column one step toward the back', () => {
        expect(moveKey(order, 'Status', 1)).toEqual(['Workflow ID', 'Type', 'Status']);
    });

    it('declines at the front edge: returns the same array reference', () => {
        expect(moveKey(order, 'Workflow ID', -1)).toBe(order);
    });

    it('declines at the back edge: returns the same array reference', () => {
        expect(moveKey(order, 'Type', 1)).toBe(order);
    });

    it('declines a key the order does not contain', () => {
        expect(moveKey(order, 'Nonexistent', 1)).toBe(order);
    });
});

describe('moveKeyBeside', () => {
    const order = ['Workflow ID', 'Status', 'Type'];

    it('inserts the dragged key immediately before the target', () => {
        expect(moveKeyBeside(order, 'Type', 'Workflow ID', true)).toEqual(['Type', 'Workflow ID', 'Status']);
    });

    it('inserts the dragged key immediately after the target', () => {
        expect(moveKeyBeside(order, 'Workflow ID', 'Status', false)).toEqual(['Status', 'Workflow ID', 'Type']);
    });

    it('is a real move, not merely a swap: dropping past a middle column skips over it', () => {
        expect(moveKeyBeside(order, 'Type', 'Workflow ID', false)).toEqual(['Workflow ID', 'Type', 'Status']);
    });

    it('declines when the dragged key and the target are the same', () => {
        expect(moveKeyBeside(order, 'Status', 'Status', true)).toBe(order);
    });

    it('declines when either key is missing from the order', () => {
        expect(moveKeyBeside(order, 'Nonexistent', 'Status', true)).toBe(order);
        expect(moveKeyBeside(order, 'Status', 'Nonexistent', true)).toBe(order);
    });
});
