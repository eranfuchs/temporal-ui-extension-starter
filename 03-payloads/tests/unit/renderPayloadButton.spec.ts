// @vitest-environment jsdom
//
// The `{ }` button: the only thing a render pass adds for the payload panel.
//
// It is a button and nothing else — no row identity on it, no request behind it.
// Both halves of that are asserted here, because both were true by accident before
// they were true on purpose: a button carrying a workflow id is wrong the moment the
// UI recycles the <tr> under it, and a table of 100 rows must cost zero requests
// until a pointer lands on one (rule 1 at the top of src/payloads/tooltip.ts).

import { beforeEach, describe, expect, it } from 'vitest';

import {
    applyToTable,
    LINK_CLASS,
    PAYLOAD_CLASS,
} from '../../src/render';
import { buildWorkflowTable } from '../helpers';
import {
    CHILD_A_RUN,
    FAMILY,
    OPTIONS,
    PARENT_RUN,
    lookupFor,
    resetRenderHarness,
} from '../renderHarness';

beforeEach(resetRenderHarness);

describe('the payload button', () => {
    it('adds one per row and carries no row identity on it', () => {
        // THE ABSENCE IS THE ASSERTION, and it is checked over every attribute
        // rather than over the ones this file happens to set — a title, a data-*,
        // an aria-label added later would each look harmless. A button holding a
        // workflow id would be wrong the moment the UI recycles the <tr> under it,
        // so the panel reads the row from the cell's href at hover time instead.
        const tbody = buildWorkflowTable(document, [
            { workflowId: 'parent', runId: PARENT_RUN },
            { workflowId: 'child-a', runId: CHILD_A_RUN },
        ]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, payloadsEnabled: true });

        const buttons = Array.from(tbody.querySelectorAll<HTMLButtonElement>(`.${PAYLOAD_CLASS}`));
        expect(buttons).toHaveLength(2);
        // type=button: inside a form, a button with no type submits it.
        expect(buttons[0]!.type).toBe('button');
        expect(buttons[0]!.getAttribute('aria-label')).toBeTruthy();
        for (const button of buttons) {
            for (const attribute of Array.from(button.attributes)) {
                expect(attribute.value).not.toContain('parent');
                expect(attribute.value).not.toContain(PARENT_RUN);
            }
        }
    });

    it('omits the button on a row it has no run id for', () => {
        // The history request needs a run id. A button that could only ever fail is
        // worse than no button.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'not-in-the-api-response' }]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, payloadsEnabled: true });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(0);
    });

    it('removes the buttons when the setting is switched off, and puts them back', () => {
        // Both directions. A remove-only implementation passes the first half and
        // leaves the toggle dead in the one direction a user notices.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: true });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(1);

        applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: false });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(0);

        applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: true });
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(1);
    });

    it('puts the links before the button whichever feature was switched on first', () => {
        // The order on screen must not depend on the order the toggles were used in.
        // Both controls are created with appendChild, so this spec fails the moment
        // syncControlOrder stops running — and it fails only in the second half,
        // which is the half no screenshot of a fresh install would ever show.
        const links = [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }];
        const order = (tbody: HTMLTableSectionElement): string[] => {
            const cell = tbody.querySelector<HTMLTableCellElement>('td')!;
            return Array.from(cell.children)
                .filter((node) => node.classList.contains(LINK_CLASS) || node.classList.contains(PAYLOAD_CLASS))
                .map((node) => (node.classList.contains(LINK_CLASS) ? 'link' : 'payload'));
        };

        const both = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        applyToTable(both, lookupFor(FAMILY), { ...OPTIONS, linksEnabled: true, links, payloadsEnabled: true });
        expect(order(both)).toEqual(['link', 'payload']);

        const later = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        // Payload button first, deep links only afterwards — the append order that
        // used to decide it, and the one that produced the wrong order.
        applyToTable(later, lookup, { ...OPTIONS, payloadsEnabled: true });
        applyToTable(later, lookup, { ...OPTIONS, payloadsEnabled: true, linksEnabled: true, links });
        expect(order(later)).toEqual(['link', 'payload']);
    });

    it('adds exactly one button however many passes run', () => {
        // A second button per pass would be invisible in a screenshot and obvious in
        // the DOM, which is the combination this whole spec file exists for.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        for (let pass = 0; pass < 3; pass++) {
            applyToTable(tbody, lookup, { ...OPTIONS, payloadsEnabled: true });
        }
        expect(tbody.querySelectorAll(`.${PAYLOAD_CLASS}`)).toHaveLength(1);
    });
});
