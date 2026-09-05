// The two per-row affordances that open a payload panel — one for the input, one
// for the result. THIS FILE ONLY DRAWS THEM: no row identity on either button and
// no request behind either — the hovering, the fetching and the panel are all
// payloads/tooltip.ts, which finds a button by its class at hover time. See rule 1
// at the top of that file.
//
// Stage 03 drew one `{ }` button that opened a panel with both an input section
// and a result section, fetching both on every hover (skipping the result only
// for a running workflow). Splitting it into two independent buttons is a real
// request-cost change, not just a label change: hovering "In" now costs at most
// one request, and a reader who only wants the result never pays for the input
// history read at all.

import { PAYLOAD_INPUT_CLASS, PAYLOAD_OUTPUT_CLASS, type Placement, type RenderOptions } from '../decoration';

export function syncPayloadButtons(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    syncOne(cell, PAYLOAD_INPUT_CLASS, 'In', "Show this workflow's input", placement, options);
    syncOne(cell, PAYLOAD_OUTPUT_CLASS, 'Out', "Show this workflow's result", placement, options);
}

function syncOne(
    cell: HTMLTableCellElement,
    className: string,
    glyph: string,
    label: string,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    const existing = cell.querySelector<HTMLButtonElement>(`:scope > .${className}`);
    if (!options.payloadsEnabled || !placement) {
        existing?.remove();
        return;
    }
    if (existing) return;

    const button = cell.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    cell.appendChild(button);
}
