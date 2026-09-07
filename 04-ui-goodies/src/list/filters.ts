// The NOT filter, and Ctrl/Cmd-additive combination for both it and Temporal's own
// native "filter" button.
//
// TWO SEPARATE CONTROLS, ONE TOGGLE (settings.notFilterEnabled — wired in
// content.ts):
//   1. Our own "≠" button. DELEGATED, not pre-allocated: page size can now be
//      1,000 (pageSize.ts), so a button per eligible cell in every row would mean
//      thousands of idle nodes for a control most cells never use. Instead there
//      is exactly ONE button, relocated into whichever eligible cell currently has
//      the pointer or keyboard focus — the same document-level pointerover/focusin
//      delegation payloads/tooltip.ts already uses for its own hover panel. It
//      sits at the cell's right edge beside the UI's own filter/copy cluster, and
//      the room it takes there is reserved on every eligible cell in advance —
//      see syncNotFilterHosts().
//   2. A capture-phase click listener that, ONLY when Ctrl/Cmd is held, intercepts
//      a click on Temporal's own native "filter" button (part of the
//      `.copy-or-filter` cluster columns.ts already knows about) and combines
//      instead of replacing. A click on the cluster's OTHER button — copy — must
//      pass through untouched; see isFilterButton()'s negative control.
//
// Both share the same clause vocabulary: a cell's column has to be one
// query.ts's FIELD_BY_COLUMN_LABEL maps, and the cell's current value has to be
// quotable — see query.ts's file header for why quoting can fail. Neither ever
// guesses; both decline silently rather than build a clause that might be wrong.
//
// RE-DERIVED AT CLICK TIME, NEVER TRUSTED FROM WHEN THE BUTTON WAS SHOWN: the same
// rule render.ts states for rows and columnCopy.ts applies for a column's index —
// a click can land render passes after the hover that drew the button.
//
// NAVIGATION IS A REAL PAGE LOAD, NOT history.pushState: this extension cannot
// reach into the page's own router state to clear whatever page of results it had
// scrolled to under the OLD query. A real navigation starts the SPA over from page
// one, clearing that as a side effect, without this file needing to know the name
// of a pagination parameter it has never confirmed exists. `navigate` is injected
// (content.ts wires it to `location.href = `) so a test can watch the URL a click
// produces without asking jsdom to perform a real navigation.

import { NOT_FILTER_BUTTON_CLASS, NOT_FILTER_HOST_CLASS, NOT_FILTER_HOST_NATIVE_CLASS } from '../decoration';
import { readColumns, visibleText, type ColumnInfo } from './columns';
import { buildComparisonClause, combineQuery, FIELD_BY_COLUMN_LABEL } from './query';

export interface NotFilterDeps {
    // Read live, not captured once: a toggle flip must take effect on the very
    // next hover or click, not the next page load. Combines the master switch and
    // this feature's own — see content.ts.
    enabled: () => boolean;
    navigate: (url: string) => void;
}

interface EligibleCell {
    column: ColumnInfo;
    field: string;
    value: string;
}

function headRowFor(cell: Element): HTMLTableRowElement | null {
    return cell.closest('table')?.querySelector<HTMLTableRowElement>('thead tr') ?? null;
}

// A cell this file can build a clause for right now: a NATIVE column (an extension
// column like "Last event" is not a real Temporal field, and a structural one has
// no field at all) that query.ts maps, holding a non-empty value. Declines — never
// guesses — whenever any of those is not true.
function eligibleCell(cell: Element, headRow: HTMLTableRowElement): EligibleCell | undefined {
    const index = Array.from(cell.parentElement?.children ?? []).indexOf(cell);
    const column = readColumns(headRow)[index];
    if (!column || column.origin !== 'native') return undefined;
    const field = FIELD_BY_COLUMN_LABEL[column.label];
    if (!field) return undefined;
    const value = visibleText(cell);
    if (value === '') return undefined;
    return { column, field, value };
}

function navigateWithClause(clause: string, additive: boolean, navigate: (url: string) => void): void {
    const url = new URL(location.href);
    const existing = url.searchParams.get('query') ?? '';
    url.searchParams.set('query', combineQuery(existing, clause, additive));
    navigate(url.toString());
}

// ── Our own "≠" button ────────────────────────────────────────────────────────

let sharedButton: HTMLButtonElement | null = null;

// The click handler lives HERE, attached directly to the button at creation —
// not delegated through a document-level bubble listener. The row this sits in
// commonly wraps its workflow-id cell in a link, or listens for a click of its
// own to open the run; a document-level listener only ever reaches document
// AFTER bubbling through that ancestor; stopPropagation() called that late is
// already too late to stop it. Attached on the button itself, this listener runs
// BEFORE the event bubbles any further, which is what actually stops it.
function ensureButton(doc: Document, deps: NotFilterDeps): HTMLButtonElement {
    if (sharedButton) return sharedButton;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = NOT_FILTER_BUTTON_CLASS;
    button.textContent = '≠';
    const stopHere = (event: Event) => event.stopPropagation();
    button.addEventListener('pointerdown', stopHere);
    button.addEventListener('mousedown', stopHere);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!deps.enabled()) return;

        // RE-RESOLVE, not the clause shown a render pass ago.
        const cell = button.closest<HTMLTableCellElement>('td');
        const headRow = cell ? headRowFor(cell) : null;
        const eligible = cell && headRow ? eligibleCell(cell, headRow) : undefined;
        if (!eligible) return;
        const clause = buildComparisonClause(eligible.field, '!=', eligible.value);
        if (clause === null) return;

        navigateWithClause(clause, event.ctrlKey || event.metaKey, deps.navigate);
    });
    sharedButton = button;
    return button;
}

function detachButton(): void {
    sharedButton?.remove();
}

// Installed ONCE, from content.ts's start() — same convention as
// installPayloadTooltip. Every dependency is read live through `deps`.
export function installNotFilter(deps: NotFilterDeps): void {
    const relocate = (event: Event): void => {
        if (!deps.enabled()) {
            detachButton();
            return;
        }
        const target = event.target as Element | null;
        const cell = target?.closest<HTMLTableCellElement>('tbody td') ?? null;
        const headRow = cell ? headRowFor(cell) : null;
        const eligible = cell && headRow ? eligibleCell(cell, headRow) : undefined;
        if (!cell || !eligible) {
            detachButton();
            return;
        }
        const clause = buildComparisonClause(eligible.field, '!=', eligible.value);
        if (clause === null) {
            detachButton();
            return;
        }

        const button = ensureButton(cell.ownerDocument, deps);
        // Onto the cell itself, whatever it holds — a badge in its flex wrapper, a
        // link, plain text: content.css anchors the button to the cell's edge, out of
        // the cell's own flow, so the content never decides where it lands.
        if (button.parentElement !== cell) cell.appendChild(button);
        button.setAttribute('aria-label', `Exclude rows where ${eligible.column.label} is ${eligible.value}`);
        button.title = `Filter OUT rows where ${eligible.column.label} = ${eligible.value}. Ctrl/Cmd-click to add this to the current filter instead of replacing it.`;
    };
    document.addEventListener('pointerover', relocate);
    document.addEventListener('focusin', relocate);

    // The one case a "recompute on entering any new element" delegate cannot see:
    // the pointer leaving the browser window entirely, so no further element is
    // ever entered to trigger `relocate` again. relatedTarget is null exactly then.
    document.addEventListener('pointerout', (event) => {
        if ((event as PointerEvent).relatedTarget === null) detachButton();
    });
}

// ── Reserving the button's room on every eligible cell ───────────────────────

// Confirmed against the shipped UI: a cell whose right edge holds the UI's own
// filter/copy cluster carries a `filterable` class at all times, while the cluster
// itself mounts only on hover — so the class, never the cluster, is what to key off,
// or the mark would flicker with the pointer. Temporal Cloud's build reserves the
// same room with its `pr-16` / `pr-8` padding utilities instead. The cluster is the
// fallback for a build that does neither.
function hasNativeFilterCluster(cell: Element): boolean {
    return (
        ['filterable', 'pr-16', 'pr-8'].some((className) => cell.classList.contains(className)) ||
        cell.querySelector('.copy-or-filter') !== null
    );
}

function setClass(element: Element, className: string, on: boolean): void {
    if (element.classList.contains(className) !== on) element.classList.toggle(className, on);
}

// Called on every render pass, like syncHeaderCopyButtons. Every cell of every column
// the button can appear in is marked so content.css can reserve the button's room at
// the cell's edge PERMANENTLY — the UI's own pattern for its cluster — rather than on
// hover: the value stops short of the button on every row, so it is never covered,
// and the cell box never changes on hover, so the column never reflows. By column,
// not by value: room reserved on a blank cell costs nothing, and a mark that came and
// went with the value would be a write on every data change. Guarded writes, so a
// settled pass is no write at all (render.ts Rule 2); `enabled` false strips.
export function syncNotFilterHosts(tbody: HTMLTableSectionElement, enabled: boolean): void {
    const headRow = headRowFor(tbody);
    if (!headRow) return;
    const indexes = readColumns(headRow)
        .filter((column) => column.origin === 'native' && FIELD_BY_COLUMN_LABEL[column.label] !== undefined)
        .map((column) => column.index);
    for (const row of Array.from(tbody.children)) {
        for (const index of indexes) {
            const cell = row.children[index];
            if (!cell) continue;
            setClass(cell, NOT_FILTER_HOST_CLASS, enabled);
            setClass(cell, NOT_FILTER_HOST_NATIVE_CLASS, enabled && hasNativeFilterCluster(cell));
        }
    }
}

// ── Ctrl/Cmd-augmenting Temporal's own native filter button ─────────────────

// Discriminates the FILTER button from the COPY button inside the same
// `.copy-or-filter` cluster — confirmed against the shipped Temporal UI: title or
// aria-label substring first, falling back to "the first button in the cluster",
// since the filter button renders before the copy button there.
function isFilterButton(button: Element): boolean {
    const label = `${button.getAttribute('aria-label') ?? ''} ${button.getAttribute('title') ?? ''}`.toLowerCase();
    if (label.includes('filter')) return true;
    if (label.includes('copy')) return false;
    const cluster = button.closest('.copy-or-filter');
    const buttons = cluster ? Array.from(cluster.querySelectorAll('.copy-or-filter-button')) : [button];
    return buttons[0] === button;
}

// Installed ONCE, capture phase, so this runs before Temporal's own bubble-phase
// handler on the same button. A plain click is never touched here — only
// Ctrl/Cmd, and only on the filter half of the cluster.
export function installFilterAugment(deps: NotFilterDeps): void {
    document.addEventListener(
        'click',
        (event) => {
            if (!deps.enabled()) return;
            if (!(event.ctrlKey || event.metaKey)) return;
            const target = event.target as Element | null;
            const button = target?.closest<HTMLElement>('.copy-or-filter-button');
            if (!button || !isFilterButton(button)) return;

            const cell = button.closest('td, th');
            const headRow = cell ? headRowFor(cell) : null;
            const eligible = cell && headRow ? eligibleCell(cell, headRow) : undefined;
            if (!eligible) return;
            const clause = buildComparisonClause(eligible.field, '=', eligible.value);
            if (clause === null) return;

            event.preventDefault();
            event.stopImmediatePropagation();
            navigateWithClause(clause, true, deps.navigate);
        },
        { capture: true },
    );
}
