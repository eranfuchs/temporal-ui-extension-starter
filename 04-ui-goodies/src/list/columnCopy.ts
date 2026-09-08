// The Copy button on every "real" column header — one per native or extension
// column, none on a structural cell (the leading checkbox, a spacer): there is no
// column of values there worth putting on a clipboard.
//
// RESPONSIBILITY: draw the button, idempotently, and on click read that column's
// values back OUT OF THE LIVE TABLE — never anything captured when the button was
// drawn. A click can land any number of render passes later, after Temporal has
// reordered the header or recycled a row underneath it, so the column's live index
// is recomputed at the moment of the click and nowhere earlier.
//
// SECURITY NOTE (see this project's Security card in README.md): this moves text
// from the page to the system clipboard. It is gated on a user click, reads only
// what is already rendered on screen — nothing this extension decodes or
// decrypts — and goes nowhere but the clipboard.

import { HEADER_COPY_CLASS } from '../decoration';
import { inlineHostOf, readColumns, visibleText, type ColumnInfo } from './columns';

const COPY_GLYPH = '⧉';
const DONE_GLYPH = '✓';
const FAILED_GLYPH = '✕';
const FEEDBACK_MS = 1200;

// Per-button, so copying one column's feedback never cuts off another's — several
// of these buttons can be mid-feedback at once.
const feedbackTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

// One pass over the header row: every native or extension column gets exactly one
// button, added if missing. Taking them off again is the master switch's job
// (removeAllDecoration, by class), not this function's — see HEADER_COPY_CLASS in
// decoration.ts. Otherwise idempotent — a cell that already has its button is
// left untouched, so a settled table causes no write — per render.ts Rule 2.
export function syncHeaderCopyButtons(tbody: HTMLTableSectionElement): void {
    const headRow = tbody.closest('table')?.querySelector<HTMLTableRowElement>('thead tr');
    if (!headRow) return;

    for (const column of readColumns(headRow)) {
        if (column.origin === 'structural') continue;
        if (column.th.querySelector(`.${HEADER_COPY_CLASS}`)) continue;
        // Beside the label, inside Temporal's own flex wrapper — see inlineHostOf().
        inlineHostOf(column.th).appendChild(buildCopyButton(column, tbody));
    }
}

function buildCopyButton(column: ColumnInfo, tbody: HTMLTableSectionElement): HTMLButtonElement {
    const doc = column.th.ownerDocument;
    const button = doc.createElement('button');
    button.type = 'button'; // see rowInfoRender.ts's buildColumnHead() for why this is explicit
    button.className = HEADER_COPY_CLASS;
    button.textContent = COPY_GLYPH;
    button.setAttribute('aria-label', `Copy the ${column.label} column`);
    button.title = `Copy every visible row’s ${column.label} value, one per line.`;

    // This button sits inside a header cell Temporal's own click-to-sort handler
    // listens on (an ancestor of everything in the cell, in every build this has
    // been checked against). Stopping propagation here, on both the pointer press
    // and the click, is what keeps a copy from also re-sorting the table.
    const stopHere = (event: Event) => event.stopPropagation();
    button.addEventListener('pointerdown', stopHere);
    button.addEventListener('mousedown', stopHere);
    button.addEventListener('click', (event) => {
        stopHere(event);
        void copyColumn(button, tbody);
    });
    return button;
}

async function copyColumn(button: HTMLButtonElement, tbody: HTMLTableSectionElement): Promise<void> {
    const headRow = tbody.closest('table')?.querySelector<HTMLTableRowElement>('thead tr');
    // RE-READ, not the column this button was built for: recomputed fresh in case
    // the header has been reordered or rebuilt since.
    const th = button.closest('th, td');
    const column = headRow ? readColumns(headRow).find((c) => c.th === th) : undefined;
    if (!column) {
        showFeedback(button, false, 0);
        return;
    }

    const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>(':scope > tr'));
    const lines = rows.map((tr) => visibleText(tr.children[column.index] ?? tr));
    // Every line blank (including no rows at all) reads as nothing happened unless
    // it says so — a clipboard full of empty lines looks identical to a click that
    // silently failed.
    const text = lines.every((line) => line === '') ? 'Empty' : lines.join('\n');

    try {
        await navigator.clipboard.writeText(text);
        showFeedback(button, true, lines.length);
    } catch {
        showFeedback(button, false, 0);
    }
}

function showFeedback(button: HTMLButtonElement, ok: boolean, count: number): void {
    const originalTitle = button.title;
    button.textContent = ok ? DONE_GLYPH : FAILED_GLYPH;
    button.title = ok ? `Copied ${count} line${count === 1 ? '' : 's'}.` : 'Could not copy — try again.';
    clearTimeout(feedbackTimers.get(button));
    feedbackTimers.set(
        button,
        setTimeout(() => {
            button.textContent = COPY_GLYPH;
            button.title = originalTitle;
        }, FEEDBACK_MS),
    );
}
