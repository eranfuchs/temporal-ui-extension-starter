// Pure column-ORDER math: given the live columns and a stored key order, decide
// where each column belongs. No DOM here — src/list/columnReorder.ts is the
// layer that actually moves <th> and <td> nodes; this file is what it asks.
//
// RESPONSIBILITY: turn a `columnOrder: string[]` setting — a list of native and
// extension column KEYS, in the order a human dragged them into — into a full
// permutation of the CURRENT columns. Structural columns (the checkbox) never
// move; a key the order does not mention (a column added after the order was
// saved, or simply never dragged) keeps its current position relative to every
// other unmentioned column, and sorts after every column the order DOES mention
// — the same "unknown, keep relative order, sort last" rule render.ts's
// reorderIntoFamilies() uses for a row this extension has no placement for.
//
// An EMPTY order is therefore a no-op: every column is "unmentioned", so the
// sort is stable over the current order and nothing moves. That is what makes
// "no preference saved yet" and "feature switched off" the same input rather
// than two branches — see syncColumnOrder() in columnReorder.ts.

import type { ColumnInfo } from './columns';

// Every reorderable column's key (native or extension — never structural), in
// the order `order` puts them: unknown keys keep their current relative order
// and sort after every key `order` DOES mention.
function sortedKeys(columns: readonly ColumnInfo[], order: readonly string[]): string[] {
    const rank = new Map(order.map((key, index) => [key, index]));
    // Above every real rank, however many of `order`'s entries actually match a
    // current column — see the file header. `order.length` is a safe ceiling: a
    // real match's rank is always an index INTO order, so always < its length.
    let unknownRank = order.length;
    return columns
        .filter((c) => c.origin !== 'structural')
        .map((c) => ({ key: c.key, rank: rank.get(c.key) ?? unknownRank++ }))
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => entry.key);
}

// The full column list, reordered: structural columns stay exactly where they
// are; every other column is placed by `order`, via sortedKeys() above.
export function reorderColumns(columns: readonly ColumnInfo[], order: readonly string[]): ColumnInfo[] {
    const byKey = new Map(columns.filter((c) => c.origin !== 'structural').map((c) => [c.key, c] as const));
    const queue = sortedKeys(columns, order).map((key) => byKey.get(key)!);
    let next = 0;
    return columns.map((c) => (c.origin === 'structural' ? c : queue[next++]!));
}

// The reorderable keys alone, in the order reorderColumns() would place them —
// what a drag or a keyboard move actually edits, and what gets saved back to
// settings.columnOrder. Never the raw stored value: that can be stale (a
// deleted column, a column never seen yet), and this is always exactly the
// keys on screen right now, in their current effective order.
export function effectiveKeyOrder(columns: readonly ColumnInfo[], order: readonly string[]): string[] {
    return sortedKeys(columns, order);
}

// One keyboard step. Declines — returns the SAME array, so `moveKey(...) ===
// order` tells a caller nothing happened — when `key` is not in `order` at all,
// or the step would run off either end. `order` must already be a FULL
// effective order (effectiveKeyOrder()'s output), never the raw setting: this
// function only swaps two entries, it does not know how to place an unknown one.
export function moveKey(order: readonly string[], key: string, delta: -1 | 1): readonly string[] {
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return order;
    const next = [...order];
    [next[index], next[target]] = [next[target]!, next[index]!];
    return next;
}

// One drop. Moves `key` to sit immediately before or after `targetKey` — the
// "insert" semantics a drag gesture expects, not a swap. Declines, returning
// the SAME array, when the two keys are the same or either is missing from
// `order`. Same full-effective-order contract as moveKey() above.
export function moveKeyBeside(
    order: readonly string[],
    key: string,
    targetKey: string,
    before: boolean,
): readonly string[] {
    if (key === targetKey || !order.includes(key) || !order.includes(targetKey)) return order;
    const withoutKey = order.filter((k) => k !== key);
    const targetIndex = withoutKey.indexOf(targetKey);
    const insertAt = before ? targetIndex : targetIndex + 1;
    return [...withoutKey.slice(0, insertAt), key, ...withoutKey.slice(insertAt)];
}
