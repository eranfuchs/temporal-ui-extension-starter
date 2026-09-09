// One more option on Temporal's own page-size <select>: 1000, which is the
// workflow-list API's own per-call ceiling — a request for more than that
// truncates to it, so there is no reason to offer more.
//
// RESPONSIBILITY: find that <select> and add the option. Nothing here selects it,
// re-fetches anything, or wraps the request the native change handler makes when
// the user picks it — Temporal's own <select> already does all of that.
//
// Confirmed against the shipped Temporal UI, not assumed: there is no fixed id on
// this control, and its native options are 100/250/500 — so it is found by which
// <select> on the page offers BOTH 100 and 500, the two values true of every build
// this has been checked against.

import { PAGE_SIZE_OPTION_CLASS } from '../decoration';

const PAGE_SIZE_OPTION_VALUE = '1000';
// The label carries a trailing `*`; the value must not. The `*` marks the option as
// one this extension added rather than one Temporal ships — a reader of the dropdown
// can see which entries are not the site's own, and a bug report says `1000*` and
// points at the right code. The value is what Temporal's own change handler puts in
// `?per-page=`, so it stays a bare number.
const PAGE_SIZE_OPTION_LABEL = `${PAGE_SIZE_OPTION_VALUE}*`;
const NATIVE_PAGE_SIZE_VALUES = ['100', '500'];

export function findPageSizeSelect(root: ParentNode): HTMLSelectElement | null {
    for (const select of Array.from(root.querySelectorAll('select'))) {
        const values = Array.from(select.options).map((option) => option.value);
        if (NATIVE_PAGE_SIZE_VALUES.every((value) => values.includes(value))) return select;
    }
    return null;
}

// Idempotent: does nothing on a pass that finds the option already there. Taking
// it off again is the master switch's job (removeAllDecoration, by class), not
// this function's — see PAGE_SIZE_OPTION_CLASS in decoration.ts.
export function syncPageSizeOption(select: HTMLSelectElement): void {
    if (select.querySelector(`option.${PAGE_SIZE_OPTION_CLASS}`)) return;
    const option = select.ownerDocument.createElement('option');
    option.className = PAGE_SIZE_OPTION_CLASS;
    option.value = PAGE_SIZE_OPTION_VALUE;
    option.textContent = PAGE_SIZE_OPTION_LABEL;
    // Appended, never selected: which page size is in effect is the user's choice,
    // made through the native control exactly as it always was.
    select.appendChild(option);
}
