// ONE MODEL OF "WHICH COLUMN IS WHICH", shared by every feature that has to name a
// column rather than just a position: the header Copy button, the NOT filter, and
// column reordering.
//
// RESPONSIBILITY: read the live header row and say, for each cell, a stable KEY, a
// display LABEL, and whether it is Temporal's own column, one this extension added,
// or structural (the leading checkbox, a spacer — nothing with a name of its own).
// It reads the DOM; it writes nothing.
//
// INVARIANT: re-derived from the live header on every call, never cached. Temporal
// reorders and replaces header cells the same way it recycles table rows (render.ts
// Rule 1), so a key or index read once and kept past the next render pass is already
// wrong the moment the user drags a column.
//
// INVARIANT: a native column's key is the exact suffix of its own
// `data-testid="workflows-summary-table-header-cell-<Label>"` — confirmed to equal
// the column's display name — never text scraped from the cell. An extension
// column's key is an explicit `data-tuis-column` marker this extension writes
// itself, for the same reason: the "Last event" header's own textContent also
// contains its refresh button's glyph, and a future column could rename its label
// without changing its identity.
//
// FAIL OPEN on an unresolvable key: findByKey() returns nothing for a key that is
// missing OR claimed by more than one column, rather than guessing. A feature that
// needs a specific column (the NOT filter, reorder-by-key) must accept that and
// decline the action — never fall back to a position that might be the wrong column.

import { COLUMN_REFRESH_CLASS, REMOVABLE_ROOT_CLASSES } from '../decoration';

// The prefix Temporal's own workflow list gives every one of its header cells,
// confirmed against the shipped Temporal UI: the text after it is the column's
// display name, exactly as "Configure Table" spells it. Cells with neither this nor
// EXTENSION_COLUMN_ATTR — the leading select-all checkbox, a spacer — carry no name
// of Temporal's own and are STRUCTURAL below.
export const HEADER_TESTID_PREFIX = 'workflows-summary-table-header-cell-';

// The marker this extension writes on a header cell it added, so that cell's
// identity survives a rename of its visible label. Set once, by the feature that
// builds the column (rowInfoRender.ts's buildColumnHead(), for "Last event").
export const EXTENSION_COLUMN_ATTR = 'data-tuis-column';

// The key rowInfoRender.ts's "Last event" column is marked with. Lives here, not
// there, so every reader of a column key looks in one place for the vocabulary —
// the same reason decoration.ts holds every class name this extension writes.
export const LAST_EVENT_COLUMN_KEY = 'last-event';

export type ColumnOrigin = 'native' | 'extension' | 'structural';

export interface ColumnInfo {
    key: string;
    label: string;
    origin: ColumnOrigin;
    // Position among the header row's own children right now. Never store this
    // past the render pass that read it — see the re-derived invariant above.
    index: number;
    th: Element;
}

// Every header cell, left to right, exactly as the DOM has them right now.
export function readColumns(headRow: HTMLTableRowElement): ColumnInfo[] {
    return Array.from(headRow.children).map((th, index) => {
        const extKey = th.getAttribute(EXTENSION_COLUMN_ATTR);
        if (extKey) return { key: extKey, label: visibleText(th), origin: 'extension', index, th };

        const testid = th.getAttribute('data-testid') ?? '';
        if (testid.startsWith(HEADER_TESTID_PREFIX)) {
            const label = testid.slice(HEADER_TESTID_PREFIX.length);
            return { key: label, label, origin: 'native', index, th };
        }

        // Structural. Keyed by its own position so two structural cells never
        // collide with each other — but that key is deliberately never looked up:
        // findByKey() below excludes 'structural' outright, since a checkbox column
        // was never a target for any feature that calls it.
        return { key: `structural-${index}`, label: visibleText(th), origin: 'structural', index, th };
    });
}

// The one column claiming `key`, or nothing if zero or more than one does. Callers
// that need a SPECIFIC column — not just "the third one" — go through this, so an
// ambiguous or missing key is a decline, never a guess at the wrong column.
export function findByKey(columns: readonly ColumnInfo[], key: string): ColumnInfo | undefined {
    const matches = columns.filter((c) => c.origin !== 'structural' && c.key === key);
    return matches.length === 1 ? matches[0] : undefined;
}

// Every element this extension puts inside a header or body cell that is UI, not
// data: the roots removeAllDecoration() sweeps (imported, so a class added there is
// excluded here for free) plus the "Last event" column's own refresh button, which
// is a CHILD of a root rather than a root itself and so is not in that list.
const OWN_NON_TEXT_SELECTOR = [...REMOVABLE_ROOT_CLASSES, COLUMN_REFRESH_CLASS].map((c) => `.${c}`).join(', ');

// Temporal's own per-cell "filter or copy" affordance, confirmed against the
// shipped Temporal UI: a `.copy-or-filter` wrapper holding one or more
// `.copy-or-filter-button` buttons. A copied cell should read the way it would if
// this extension, and that button, both did not exist.
const NATIVE_CELL_CONTROL_SELECTOR = '.copy-or-filter, .copy-or-filter-button';

const EXCLUDED_SELECTOR = `${OWN_NON_TEXT_SELECTOR}, ${NATIVE_CELL_CONTROL_SELECTOR}`;

// The text a reader would see and want to copy — a header's label, or a body cell's
// value — with every button, badge and link this extension or Temporal's own list
// draws inside it removed first. Clone-and-remove, never innerHTML: the removal has
// to see real Element nodes to match the selector above, and the clone means the
// live cell is never touched by a read.
export function visibleText(cell: Element): string {
    const clone = cell.cloneNode(true) as Element;
    clone.querySelectorAll(EXCLUDED_SELECTOR).forEach((node) => node.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

// Where an IN-FLOW control this extension adds to a cell should be appended so that
// it sits BESIDE the cell's own content rather than below it (the header Copy
// button; a control positioned out of the flow, like the "≠" button, needs none of
// this). LIVE-VERIFIED against the shipped Temporal UI: a header cell holds its
// label in a `display: flex` div, and a flex box is block-level by default, so a
// node appended after it as a sibling starts a new block — on the page, a button
// dropping onto a second line under the label. Appended INSIDE that wrapper
// instead, the node is one more flex item beside the label, which is also where
// this extension's own "Last event" header keeps its refresh control. Only a sole
// flex/grid child qualifies, and never an anchor: a button inside a link would
// become part of the link's click target. Anything else (plain text, a link,
// several children, a test fixture) takes the node directly.
export function inlineHostOf(cell: Element): Element {
    const only = cell.children.length === 1 ? cell.firstElementChild : null;
    if (!only || only.tagName === 'A') return cell;
    const display = cell.ownerDocument.defaultView?.getComputedStyle(only).display ?? '';
    return display === 'flex' || display === 'inline-flex' || display === 'grid' || display === 'inline-grid'
        ? only
        : cell;
}
