// The `{ }` button in the workflow-id cell.
//
// RESPONSIBILITY: draw the affordance, and nothing else. It does not hover, fetch,
// decode or open anything — payloads/tooltip.ts does all of that, and finds these
// buttons by PAYLOAD_CLASS.

import { PAYLOAD_CLASS, type Placement, type RenderOptions } from '../decoration';

// INVARIANT: the button carries NO row identity — no workflow id, no run id, not even
// a title that names one — so nothing on it can go stale when the UI recycles a <tr>.
// payloads/tooltip.ts resolves the row from the cell's own href at hover time.
// Breaking it: a panel showing the decoded payloads of a row that scrolled away.
// See docs/design-notes.md#the-button-that-knows-nothing.
//
// Appended, and the third thing to share this cell with the deep links and the retry
// badge: syncControlOrder() in render.ts is what keeps the order from depending on
// which feature the user switched on first.
export function syncPayloadButton(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    const existing = cell.querySelector<HTMLButtonElement>(`:scope > .${PAYLOAD_CLASS}`);
    // No placement means we have no run id for this row, and the history request
    // needs one. A button that could only ever fail is worse than no button.
    if (!options.payloadsEnabled || !placement) {
        existing?.remove();
        return;
    }
    if (existing) return;

    const button = cell.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = PAYLOAD_CLASS;
    button.textContent = '{ }';
    button.title = 'Show this workflow’s input and result';
    button.setAttribute('aria-label', 'Show this workflow’s input and result');
    cell.appendChild(button);
}
