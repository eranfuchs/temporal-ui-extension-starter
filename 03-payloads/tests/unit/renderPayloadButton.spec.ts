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

import { LINK_CLASS, PAYLOAD_CLASS, RETRY_CLASS } from '../../src/decoration';
import { applyToTable, syncControlOrder } from '../../src/render';
import { buildWorkflowTable } from '../helpers';
import {
    A_RETRY,
    CHILD_A_RUN,
    FAMILY,
    OPTIONS,
    PARENT_RUN,
    answers,
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

    it('puts the badge, then the button, then the links, whichever toggle was used first', () => {
        // The order on screen must not depend on the order the toggles were used in.
        // All three controls are created with appendChild, so this spec fails the
        // moment syncControlOrder stops running — and it fails only in the second
        // half, which is the half no screenshot of a fresh install would ever show.
        //
        // All three, not two: every control that shares the cell has to be in here,
        // because a control left out of the ranking is exactly the bug — it keeps
        // whatever position its append gave it, and the spec still passes.
        const links = [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }];
        const withBadge = { ...OPTIONS, retryEnabled: true, info: answers({ 'child-a': { retry: A_RETRY } }) };
        const named: ReadonlyArray<readonly [string, string]> = [
            [RETRY_CLASS, 'retry'],
            [PAYLOAD_CLASS, 'payload'],
            [LINK_CLASS, 'link'],
        ];
        const order = (tbody: HTMLTableSectionElement): string[] => {
            const cell = tbody.querySelector<HTMLTableCellElement>('td')!;
            return Array.from(cell.children)
                .map((node) => named.find(([className]) => node.classList.contains(className))?.[1])
                .filter((name): name is string => name !== undefined);
        };
        // Spelled out rather than derived from CELL_CONTROL_ORDER: a spec that reads
        // the answer out of the source it is checking passes on every order.
        const wanted = ['retry', 'payload', 'link'];

        const all = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        applyToTable(all, lookupFor(FAMILY), { ...withBadge, linksEnabled: true, links, payloadsEnabled: true });
        expect(order(all)).toHaveLength(named.length);
        expect(order(all)).toEqual(wanted);

        const later = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        // Switched on one at a time, in the exact reverse of the wanted order — the
        // append history that used to decide it, and the one that produced the wrong
        // row.
        applyToTable(later, lookup, { ...OPTIONS, linksEnabled: true, links });
        applyToTable(later, lookup, { ...OPTIONS, linksEnabled: true, links, payloadsEnabled: true });
        applyToTable(later, lookup, { ...withBadge, linksEnabled: true, links, payloadsEnabled: true });
        expect(order(later)).toEqual(wanted);
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

describe('the order of the controls in the id cell', () => {
    it('moves nothing, and says so, when the cell is already in order', () => {
        // Rule 2 applies to moving a node as much as to writing one: appendChild on a
        // node that is already last is still a mutation the observer wakes up for, and
        // this runs on every row of every pass. An unconditional reorder is an infinite
        // render loop that presents as a slow page.
        //
        // Asserted on the return value because that is the only way to tell "in order
        // already" from "put in order just now" from outside — and an implementation
        // that always returns true still passes every order assertion above.
        const links = [{ label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' }];
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        applyToTable(tbody, lookupFor(FAMILY), {
            ...OPTIONS,
            retryEnabled: true,
            linksEnabled: true,
            links,
            payloadsEnabled: true,
            info: answers({ 'child-a': { retry: A_RETRY } }),
        });

        const cell = tbody.querySelector<HTMLTableCellElement>('td')!;
        expect(syncControlOrder(cell)).toBe(false);

        // Now put it back the way an append-ordered cell would have looked, which is
        // also the only way to reach the true branch without a toggle.
        cell.appendChild(cell.querySelector(`.${RETRY_CLASS}`)!);
        expect(syncControlOrder(cell)).toBe(true);
        expect(syncControlOrder(cell)).toBe(false);
    });
});
