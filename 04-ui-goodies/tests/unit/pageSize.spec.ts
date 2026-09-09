// @vitest-environment jsdom
//
// src/list/pageSize.ts: finding Temporal's own page-size <select> with no id to
// anchor on, and adding the one option to it without ever choosing it.

import { beforeEach, describe, expect, it } from 'vitest';

import { PAGE_SIZE_OPTION_CLASS } from '../../src/decoration';
import { findPageSizeSelect, syncPageSizeOption } from '../../src/list/pageSize';

function selectWithValues(values: string[]): HTMLSelectElement {
    const select = document.createElement('select');
    for (const value of values) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value;
        select.appendChild(option);
    }
    document.body.appendChild(select);
    return select;
}

beforeEach(() => {
    document.body.textContent = '';
});

describe('findPageSizeSelect', () => {
    it('finds the <select> offering both native values, among others that do not', () => {
        selectWithValues(['asc', 'desc']); // a sort-order control, same tag, wrong values
        const pageSize = selectWithValues(['100', '250', '500']);
        expect(findPageSizeSelect(document)).toBe(pageSize);
    });

    it('does not match a <select> offering only one of the two', () => {
        selectWithValues(['100', '250']);
        expect(findPageSizeSelect(document)).toBeNull();
    });

    it('returns null when the page has no <select> at all', () => {
        expect(findPageSizeSelect(document)).toBeNull();
    });
});

describe('syncPageSizeOption', () => {
    it('adds exactly one 1000 option', () => {
        const select = selectWithValues(['100', '250', '500']);
        syncPageSizeOption(select);
        const added = select.querySelectorAll(`option.${PAGE_SIZE_OPTION_CLASS}`);
        expect(added).toHaveLength(1);
        expect(added[0]!.getAttribute('value')).toBe('1000');
    });

    // The `*` is the label only. Sending it as the value would put `per-page=1000*`
    // in the URL Temporal builds from the selection.
    it('labels the option 1000* and keeps the value a bare number', () => {
        const select = selectWithValues(['100', '250', '500']);
        syncPageSizeOption(select);
        const added = select.querySelector<HTMLOptionElement>(`option.${PAGE_SIZE_OPTION_CLASS}`)!;
        expect(added.textContent).toBe('1000*');
        expect(added.value).toBe('1000');
        select.value = '1000';
        expect(select.value).toBe('1000');
    });

    it('never selects the option it adds', () => {
        const select = selectWithValues(['100', '250', '500']);
        const before = select.value;
        syncPageSizeOption(select);
        expect(select.value).toBe(before);
    });

    it('is idempotent: a second pass adds nothing more', () => {
        const select = selectWithValues(['100', '250', '500']);
        syncPageSizeOption(select);
        syncPageSizeOption(select);
        expect(select.querySelectorAll(`option.${PAGE_SIZE_OPTION_CLASS}`)).toHaveLength(1);
    });
});
