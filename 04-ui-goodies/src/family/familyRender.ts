// The per-row "Family" anchor: one real <a href>, one per matched row, that
// navigates to every workflow sharing this row's rootWorkflowId — including ones
// this page never loaded, which is exactly what family/tree.ts's own tree cannot
// do (it only ever connects rows already on the page).
//
// A REAL ANCHOR, DELIBERATELY, not a button with a click handler like the ≠ filter
// button in list/filters.ts. "Family" is a plain navigation to a plain URL with
// nothing to intercept — Ctrl/Cmd-click for a new tab, middle-click, "copy link
// address" all have to keep working exactly as they do on Temporal's own row link,
// and the only way to get that for free is to let the browser do it.
//
// NOT LINK_CLASS'S HARDENING. links/linkRender.ts's anchors point at third-party
// templates the user configured, so they carry target="_blank", rel="noopener
// noreferrer" and referrerPolicy="no-referrer" — leaving window.opener and the
// Referer header on this tab would hand a workflow id to a site the user chose,
// not Temporal. This anchor never leaves Temporal's own origin, so none of that
// applies: it opens in the SAME tab, same as every row's own workflow-id link.

import { FAMILY_LINK_CLASS, LINK_BLOCKED_CLASS, type Placement, type RenderOptions } from '../decoration';

export function syncFamilyLink(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    const existing = cell.querySelector<HTMLAnchorElement>(`:scope > .${FAMILY_LINK_CLASS}`);

    if (!options.familyEnabled || !placement) {
        existing?.remove();
        return;
    }

    const href = options.buildFamilyHref(placement.row.rootWorkflowId);

    let anchor = existing;
    if (!anchor) {
        anchor = cell.ownerDocument.createElement('a');
        anchor.className = FAMILY_LINK_CLASS;
        anchor.textContent = 'Family';
        cell.appendChild(anchor);
    }

    // Same pattern as syncLinkAnchors() in links/linkRender.ts: no href at all
    // rather than a disabled-looking one, because an anchor without one is
    // unclickable, unfocusable and cannot be middle-clicked either.
    if (href === null) {
        if (anchor.hasAttribute('href')) anchor.removeAttribute('href');
    } else if (anchor.getAttribute('href') !== href) {
        anchor.setAttribute('href', href);
    }
    anchor.classList.toggle(LINK_BLOCKED_CLASS, href === null);

    const title =
        href === null
            ? 'Not opened: this workflow id cannot be safely written into a filter query.'
            : "Every workflow that shares this one's family root, wherever it is in the namespace.";
    if (anchor.title !== title) anchor.title = title;
}
