// @vitest-environment jsdom
//
// src/family/expandButton.ts: where the button and its message land relative to
// Temporal's own filter bar, that a pass which changes nothing writes nothing, and
// that a click reads rows/currentQuery live rather than from when the button was
// first drawn — the same re-read-at-click-time property filters.spec.ts pins for
// the NOT filter's own button.
//
// ONE `deps` OBJECT FOR THE WHOLE FILE, mutated through outer variables rather than
// replaced per test — same convention filters.spec.ts uses, and not optional here:
// ensureNodes() inside expandButton.ts attaches its click listener to the shared
// button node ONCE, the first time any test creates it, so a test that built its
// own fresh `deps` object would silently keep exercising the FIRST test's closure
// forever after. `syncExpandButton` is still called fresh in every test — content.ts
// calls it on every render pass, the same convention as syncPageSizeOption — only
// `deps` itself is shared.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EXPAND_BUTTON_CLASS, EXPAND_MESSAGE_CLASS } from '../../src/decoration';
import { syncExpandButton } from '../../src/family/expandButton';
import { MAX_EXPAND_ROOTS } from '../../src/family/expand';
import { normalizeExecutions } from '../../src/family/rows';
import { apiWorkflow } from '../helpers';
import type { WorkflowRow } from '../../src/types';

let enabled = true;
let currentQuery = '';
let rows: WorkflowRow[] = [];
const navigate = vi.fn();

const deps = {
    enabled: () => enabled,
    currentQuery: () => currentQuery,
    rows: () => rows,
    navigate,
};

beforeEach(() => {
    document.body.textContent = '';
    window.history.pushState({}, '', '/namespaces/ns/workflows');
    enabled = true;
    currentQuery = '';
    rows = [];
    navigate.mockClear();
});

function ourButton(): HTMLButtonElement | null {
    return document.querySelector(`.${EXPAND_BUTTON_CLASS}`);
}

function ourMessage(): HTMLSpanElement | null {
    return document.querySelector(`.${EXPAND_MESSAGE_CLASS}`);
}

function buildAnchor(testId: string): Element {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-testid', testId);
    document.body.appendChild(anchor);
    return anchor;
}

function rootsOf(ids: string[]): WorkflowRow[] {
    return normalizeExecutions(ids.map((id) => apiWorkflow({ workflowId: id, root: { workflowId: id } })));
}

describe('syncExpandButton — placement', () => {
    it('lands directly after the manual-query toggle when present', () => {
        const anchor = buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);
        expect(anchor.nextElementSibling).toBe(ourButton());
        expect(ourButton()!.nextElementSibling).toBe(ourMessage());
    });

    it('falls back to the add-filter button when the toggle is absent', () => {
        const anchor = buildAnchor('add-filter-button');
        syncExpandButton(document, deps);
        expect(anchor.nextElementSibling).toBe(ourButton());
    });

    it('prefers the manual-query toggle when both are on the page', () => {
        const toggle = buildAnchor('toggle-manual-query');
        buildAnchor('add-filter-button');
        syncExpandButton(document, deps);
        expect(toggle.nextElementSibling).toBe(ourButton());
    });

    // LIVE-VERIFIED shape of Temporal's filter bar: the toggle sits in a block-level
    // tooltip wrapper inside a flex-row control group. Inserted beside the toggle
    // the button would land inside that wrapper, on a line under the icon, and the
    // whole bar would grow to fit; it must go into the flex row instead, ahead of
    // the branch that holds the toggle, so the bar reads "Expand … </>".
    it('inserts into the nearest flex-row ancestor, ahead of the branch holding the toggle', () => {
        const group = document.createElement('div');
        group.style.display = 'flex';
        const wrapper = group.appendChild(document.createElement('div'));
        const toggle = wrapper.appendChild(document.createElement('button'));
        toggle.setAttribute('data-testid', 'toggle-manual-query');
        document.body.appendChild(group);

        syncExpandButton(document, deps);
        expect(Array.from(group.children)).toEqual([ourButton(), ourMessage(), wrapper]);
        expect(wrapper.contains(ourButton()!)).toBe(false);
    });

    it('writes nothing on a second pass that finds both nodes already in place', () => {
        const group = document.createElement('div');
        group.style.display = 'flex';
        const wrapper = group.appendChild(document.createElement('div'));
        wrapper.appendChild(document.createElement('button')).setAttribute('data-testid', 'toggle-manual-query');
        document.body.appendChild(group);
        syncExpandButton(document, deps);

        const insertBefore = vi.spyOn(group, 'insertBefore');
        syncExpandButton(document, deps);
        expect(insertBefore).not.toHaveBeenCalled();
    });

    it('draws neither node when there is no filter bar on the page at all', () => {
        syncExpandButton(document, deps);
        expect(ourButton()).toBeNull();
        expect(ourMessage()).toBeNull();
    });

    it('never draws while disabled, and detaches if the toggle turns off mid-page', () => {
        buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);
        expect(ourButton()).not.toBeNull();

        enabled = false;
        syncExpandButton(document, deps);
        expect(ourButton()).toBeNull();
        expect(ourMessage()).toBeNull();
    });

    it('detaches when the filter bar itself disappears (navigated off the list page)', () => {
        const anchor = buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);
        expect(ourButton()).not.toBeNull();

        anchor.remove();
        syncExpandButton(document, deps);
        expect(ourButton()).toBeNull();
    });

    it('writes nothing at all on a second pass that changes nothing', async () => {
        buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);

        const seen: MutationRecord[] = [];
        const observer = new MutationObserver((records) => seen.push(...records));
        observer.observe(document.body, { childList: true, subtree: true });
        syncExpandButton(document, deps);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        observer.disconnect();

        expect(seen).toEqual([]);
    });

    it('is the same shared nodes across passes, not rebuilt each time', () => {
        buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);
        const button = ourButton();
        const message = ourMessage();
        syncExpandButton(document, deps);
        expect(ourButton()).toBe(button);
        expect(ourMessage()).toBe(message);
    });
});

describe('syncExpandButton — clicking', () => {
    it('navigates with the OR-widened query when the page has family roots', () => {
        buildAnchor('toggle-manual-query');
        currentQuery = 'ExecutionStatus = "Failed"';
        rows = rootsOf(['root-1', 'root-2']);
        syncExpandButton(document, deps);
        ourButton()!.click();

        expect(navigate).toHaveBeenCalledTimes(1);
        const url = new URL(navigate.mock.calls[0]![0] as string);
        expect(url.searchParams.get('query')).toBe(
            '(ExecutionStatus = "Failed") OR (RootWorkflowId IN ("root-1", "root-2"))',
        );
        expect(ourMessage()!.textContent).toBe('');
    });

    it('shows a message and does not navigate when the page has no rows', () => {
        buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);
        ourButton()!.click();

        expect(navigate).not.toHaveBeenCalled();
        expect(ourMessage()!.textContent).toBe('No family roots found on this page.');
    });

    it('shows the count and refuses past the cap', () => {
        buildAnchor('toggle-manual-query');
        rows = rootsOf(Array.from({ length: MAX_EXPAND_ROOTS + 1 }, (_, i) => `root-${i}`));
        syncExpandButton(document, deps);
        ourButton()!.click();

        expect(navigate).not.toHaveBeenCalled();
        expect(ourMessage()!.textContent).toBe(
            `Narrow the filter first — ${MAX_EXPAND_ROOTS + 1} distinct family roots on this page.`,
        );
    });

    it('declines rather than build a clause for an unquotable root id', () => {
        buildAnchor('toggle-manual-query');
        rows = rootsOf([`both ' and " here`]);
        syncExpandButton(document, deps);
        ourButton()!.click();

        expect(navigate).not.toHaveBeenCalled();
        expect(ourMessage()!.textContent).toContain('quote');
    });

    it('re-reads rows and the current query at click time, not from when it was drawn', () => {
        buildAnchor('toggle-manual-query');
        syncExpandButton(document, deps);
        ourButton()!.click();
        expect(navigate).not.toHaveBeenCalled();

        rows = rootsOf(['root-1']);
        ourButton()!.click();
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('does nothing while disabled, even if a click somehow reaches the button', () => {
        buildAnchor('toggle-manual-query');
        rows = rootsOf(['root-1']);
        syncExpandButton(document, deps);
        const button = ourButton()!;
        enabled = false;
        button.click();
        expect(navigate).not.toHaveBeenCalled();
    });
});
