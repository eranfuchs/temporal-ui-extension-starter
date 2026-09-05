// The only place in this extension that writes an <a> the user can click.
//
// RESPONSIBILITY: turn expanded templates into anchors, idempotently, with the
// three hardening attributes on every one of them. deepLink.ts decides what a URL
// IS and whether it may be opened; this file only ever draws the answer.
//
// Used from TWO pages: the workflow list, through syncDeepLinks() below, and a single
// workflow's own page, through detail/detailLinks.ts, which calls syncLinkAnchors()
// directly. See docs/design-notes.md#why-each-of-the-four-files-exists.

import { expandTemplate, templatesInScope, type DeepLinkContext, type DeepLinkTemplate } from './deepLink';
import { LINK_BLOCKED_CLASS, LINK_CLASS, type Placement, type RenderOptions } from '../decoration';

export function syncDeepLinks(
    cell: HTMLTableCellElement,
    placement: Placement | undefined,
    options: RenderOptions,
): void {
    // WORKFLOW-SCOPED TEMPLATES ONLY. A template that mentions an activity token
    // has nothing to fill from a table row — there is no activity in a list row —
    // so its button belongs on a single workflow's own page and is drawn there by
    // detail/detailLinks.ts. Rendering it here would produce a link with an
    // unresolved token in it on every row. See "TWO SCOPES, ONE VOCABULARY" in
    // deepLink.ts.
    const wanted: DeepLinkTemplate[] =
        options.linksEnabled && placement ? templatesInScope(options.links, 'workflow') : [];
    syncLinkAnchors(
        cell,
        wanted.map((template) => ({
            template,
            context: { namespace: options.namespace, row: placement!.row, nowMs: options.nowMs },
        })),
    );
}

// One template, expanded against one context, plus anything the caller wants said
// in the anchor's title beyond what the expansion itself reports.
export interface LinkPlacement {
    template: DeepLinkTemplate;
    context: DeepLinkContext;
    // Appended to the title after the built-in notes. detail/detailLinks.ts uses it
    // to disclose HOW an activity was matched, which is a fact about the link's
    // accuracy and belongs on the link rather than in a doc.
    notes?: string[];
}

// Writes a list of link anchors as the direct `.tuis-link` children of one
// container, reusing the ones already there.
//
// INVARIANT: THE SAME WRITER FOR BOTH PAGES. The table's links and a workflow page's
// links are styled the same, carry the same three hardening attributes, report an
// unopenable URL the same way and are idempotent in the same way.
// Breaking it — by writing anchors in detail/detailLinks.ts instead of calling this —
// is a divergence nobody sees, in the file that draws the extension's most visible
// output. Two copies of this agreed for as long as it took to add one field to one.
export function syncLinkAnchors(container: HTMLElement, wanted: LinkPlacement[]): void {
    const existing = Array.from(container.querySelectorAll<HTMLAnchorElement>(`:scope > .${LINK_CLASS}`));

    if (wanted.length === 0) {
        for (const node of existing) node.remove();
        return;
    }

    wanted.forEach((placement, index) => {
        const { template } = placement;
        const { url, href, unknownTokens } = expandTemplate(template.urlTemplate, placement.context);

        let anchor = existing[index];
        if (!anchor) {
            anchor = container.ownerDocument.createElement('a');
            anchor.className = LINK_CLASS;
            anchor.target = '_blank';
            // noopener/noreferrer: the destination is a third-party tool, and
            // window.opener would hand it a live handle on the Temporal tab.
            anchor.rel = 'noopener noreferrer';
            // Without this the Referer carries the namespace and the workflow id
            // to that third party on every click. The URL is what the user chose
            // to send; the referrer is not.
            anchor.referrerPolicy = 'no-referrer';
            container.appendChild(anchor);
        }
        // Compare-then-write throughout (rule 2 in render.ts).
        if (anchor.textContent !== template.label) anchor.textContent = template.label;

        // The href is the only value here that can DO anything, so it is the one
        // place that does not take the expanded URL on trust — see safeHref().
        // No href at all, rather than a disabled-looking one: an anchor without
        // it is unclickable, unfocusable and cannot be middle-clicked either.
        if (href === null) {
            if (anchor.hasAttribute('href')) anchor.removeAttribute('href');
        } else if (anchor.getAttribute('href') !== href) {
            anchor.setAttribute('href', href);
        }
        // toggle() with an explicit force is idempotent per spec: it returns
        // early when the token is already in the wanted state, so this does not
        // write the attribute on every pass.
        anchor.classList.toggle(LINK_BLOCKED_CLASS, href === null);

        const notes: string[] = [];
        if (href === null) {
            notes.push('Not opened: a link must be an absolute http:// or https:// URL.');
        }
        // On a workflow's own page the likeliest cause is a field Temporal has not
        // filled — a pending activity has no attempt count and no close time in the
        // history — so the title names the token rather than saying "something".
        if (unknownTokens.length > 0) notes.push(`Unknown tokens: ${unknownTokens.join(' ')}`);
        notes.push(...(placement.notes ?? []));
        const title = notes.length > 0 ? `${url}\n\n${notes.join('\n')}` : url;
        if (anchor.title !== title) anchor.title = title;
    });

    for (const extra of existing.slice(wanted.length)) extra.remove();
}
