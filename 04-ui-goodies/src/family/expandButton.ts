// "Expand to families" — the filter-bar button that turns the pure verdict in
// family/expand.ts into a click: what roots are on THIS page right now, and what a
// click does about it (widen the query, or explain why not).
//
// ONE BUTTON, ONE MESSAGE, BOTH SHARED RATHER THAN REBUILT — same "one relocatable
// node still needs its own root class" convention as list/filters.ts's "≠" button:
// a toggle flip or a navigation to a page with no filter bar has to be able to take
// both off the page on the very next pass, so each has a class in decoration.ts's
// REMOVABLE_ROOT_CLASSES even though a click normally clears the message itself.
//
// FILTER-BAR ANCHOR, LIVE-VERIFIED against a local `temporal server start-dev` UI
// (2.50.1): `[data-testid="toggle-manual-query"]` is the "</>" code-view toggle in
// the filter bar's right-hand control group. It sits inside a narrow tooltip
// wrapper — a block-level div — so a node inserted right beside it lands INSIDE
// that wrapper, on a second line under the icon, and Temporal's whole filter bar
// grows a line to fit it (measured: 48px to 67px). insertionPoint() below climbs
// to the nearest flex-ROW ancestor instead — the control group itself, which never
// wraps — and puts the button there, ahead of whichever top-level child holds the
// anchor, so the bar reads "Expand to families  </>" on one line and the toggle
// stays the group's last item. Not yet checked against Temporal Cloud's own DOM,
// which can differ from self-hosted.
//
// RE-COLLECTED AT CLICK TIME, NEVER FROM WHEN THE BUTTON WAS DRAWN — same rule
// list/filters.ts states for its own button: `deps.rows()` and `deps.currentQuery()`
// are read the moment the button is pressed, not memoized across render passes.
//
// NAVIGATION IS A REAL PAGE LOAD, same reasoning and the same injected `navigate`
// as list/filters.ts — this extension has no reach into the SPA's own router state,
// and a real navigation clears whatever page of results was scrolled to under the
// OLD query as a side effect.

import { EXPAND_BUTTON_CLASS, EXPAND_MESSAGE_CLASS } from '../decoration';
import { buildExpandVerdict, collectFamilyRoots, type ExpandVerdict } from './expand';
import type { WorkflowRow } from '../types';

export interface ExpandDeps {
    // Read live, not captured once — combines the master switch and this feature's
    // own toggle. See content.ts.
    enabled: () => boolean;
    currentQuery: () => string;
    rows: () => readonly WorkflowRow[];
    navigate: (url: string) => void;
}

const FILTER_BAR_ANCHOR_SELECTORS = ['[data-testid="toggle-manual-query"]', '[data-testid="add-filter-button"]'];

function findFilterBarAnchor(doc: Document): Element | null {
    for (const selector of FILTER_BAR_ANCHOR_SELECTORS) {
        const found = doc.querySelector(selector);
        if (found) return found;
    }
    return null;
}

let sharedButton: HTMLButtonElement | null = null;
let sharedMessage: HTMLSpanElement | null = null;

function ensureNodes(doc: Document, deps: ExpandDeps): { button: HTMLButtonElement; message: HTMLSpanElement } {
    if (!sharedButton) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = EXPAND_BUTTON_CLASS;
        button.textContent = 'Expand to families';
        button.title =
            'Widen the current filter to include every workflow on this page’s family trees, even the ones that did not themselves match.';
        button.addEventListener('click', (event) => {
            event.preventDefault();
            if (!deps.enabled()) return;
            const roots = collectFamilyRoots(deps.rows());
            applyVerdict(buildExpandVerdict(deps.currentQuery(), roots), deps);
        });
        sharedButton = button;
    }
    if (!sharedMessage) {
        sharedMessage = doc.createElement('span');
        sharedMessage.className = EXPAND_MESSAGE_CLASS;
    }
    return { button: sharedButton, message: sharedMessage };
}

// The three ways a click can fail to produce a query, named for the reader rather
// than the verdict's own discriminant — buildExpandVerdict() declines silently by
// design (see its own header), so this is the only place any of the three reasons
// becomes a sentence.
function applyVerdict(verdict: ExpandVerdict, deps: ExpandDeps): void {
    if (verdict.kind === 'query') {
        if (sharedMessage) sharedMessage.textContent = '';
        const url = new URL(location.href);
        url.searchParams.set('query', verdict.query);
        deps.navigate(url.toString());
        return;
    }
    if (!sharedMessage) return;
    sharedMessage.textContent =
        verdict.kind === 'no-roots'
            ? 'No family roots found on this page.'
            : verdict.kind === 'too-many'
              ? `Narrow the filter first — ${verdict.rootCount} distinct family roots on this page.`
              : "Can't build that query — a root id on this page needs both quote characters to write safely.";
}

function detach(): void {
    sharedButton?.remove();
    sharedMessage?.remove();
}

interface InsertionPoint {
    parent: Element;
    // The child both nodes go in front of; null appends at the end.
    before: Element | null;
}

// See the file header. Walks up from the anchor to the first ancestor laid out as
// a flex row and inserts ahead of the branch that holds the anchor. With no such
// ancestor (jsdom, an unknown future layout) the nodes go right after the anchor
// itself, so a changed page degrades to a misplaced button rather than none.
function insertionPoint(anchor: Element): InsertionPoint | null {
    const parent = anchor.parentElement;
    if (!parent) return null;
    const view = anchor.ownerDocument.defaultView;
    if (view) {
        let child: Element = anchor;
        for (let up: Element | null = parent; up; child = up, up = up.parentElement) {
            const style = view.getComputedStyle(up);
            const isFlex = style.display === 'flex' || style.display === 'inline-flex';
            // jsdom reports '' for an unset property; the CSS initial value is row.
            if (isFlex && (style.flexDirection || 'row').startsWith('row')) return { parent: up, before: child };
        }
    }
    // Past our own two nodes, or a second pass would find "the anchor's next
    // sibling" is the button itself and re-insert it in front of itself.
    let before = anchor.nextElementSibling;
    while (before && (before === sharedButton || before === sharedMessage)) before = before.nextElementSibling;
    return { parent, before };
}

// Called on every render pass, like syncPageSizeOption — idempotent, so a pass that
// finds everything already in place writes nothing at all.
export function syncExpandButton(doc: Document, deps: ExpandDeps): void {
    if (!deps.enabled()) {
        detach();
        return;
    }
    const anchor = findFilterBarAnchor(doc);
    const point = anchor ? insertionPoint(anchor) : null;
    if (!point) {
        detach();
        return;
    }
    const { button, message } = ensureNodes(doc, deps);
    const settled =
        button.parentElement === point.parent &&
        button.nextElementSibling === message &&
        message.nextElementSibling === point.before;
    if (settled) return;
    point.parent.insertBefore(button, point.before);
    point.parent.insertBefore(message, point.before);
}
