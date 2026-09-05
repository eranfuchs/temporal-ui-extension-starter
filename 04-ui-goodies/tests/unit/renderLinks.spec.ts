// @vitest-environment jsdom
//
// The deep-link buttons: one per configured link, expanded for the row it sits in.
//
// Half of these are about a URL that must NOT be clickable. The template is a
// settings string and the expansion takes its values from workflow data, so this is
// the last line before a `javascript:` href sits in the Temporal page waiting to be
// clicked — and the anchor has to lose an href it was previously given, not merely
// fail to be given a new one.

import { beforeEach, describe, expect, it } from 'vitest';

import { LINK_BLOCKED_CLASS, LINK_CLASS } from '../../src/decoration';
import { applyToTable } from '../../src/render';
import { buildWorkflowTable } from '../helpers';
import {
    CHILD_A_RUN,
    FAMILY,
    OPTIONS,
    lookupFor,
    mutationsDuring,
    resetRenderHarness,
} from '../renderHarness';

beforeEach(resetRenderHarness);

describe('deep links', () => {
    const links = [
        { label: 'Logs', urlTemplate: 'https://example.com/search?q={workflowId}&ns={namespace}' },
        { label: 'Traces', urlTemplate: 'https://example.com/traces?run={runId}' },
    ];

    it('adds one button per configured link, expanded for that row', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, linksEnabled: true, links });

        const anchors = Array.from(tbody.querySelectorAll<HTMLAnchorElement>(`.${LINK_CLASS}`));
        expect(anchors.map((a) => a.textContent)).toEqual(['Logs', 'Traces']);
        expect(anchors[0]!.getAttribute('href')).toBe(
            'https://example.com/search?q=child-a&ns=sample-namespace',
        );
        expect(anchors[1]!.getAttribute('href')).toBe(`https://example.com/traces?run=${CHILD_A_RUN}`);
        // Both matter: window.opener would hand the third-party tool a handle on
        // the Temporal tab, and the Referer would hand it the namespace and
        // workflow id on every click.
        expect(anchors[0]!.rel).toBe('noopener noreferrer');
        expect(anchors[0]!.referrerPolicy).toBe('no-referrer');
        expect(anchors[0]!.target).toBe('_blank');
    });

    it('removes buttons when a link is deleted from settings', () => {
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links });
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links: links.slice(0, 1) });
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`)).toHaveLength(1);

        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: false, links });
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`)).toHaveLength(0);
    });

    it('renders a button with NO href when the template is not an http(s) URL', async () => {
        // The template is a settings string, and the expanded URL can take its
        // scheme from the workflow data, so this is the last line before a
        // `javascript:` href sits in the Temporal page waiting to be clicked.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const options = {
            ...OPTIONS,
            linksEnabled: true,
            links: [{ label: 'Bad', urlTemplate: 'javascript:alert(1)' }],
        };
        applyToTable(tbody, lookupFor(FAMILY), options);

        // The blocked path is a render path too, so it obeys rule 2 as well: a
        // class written unconditionally is the same infinite loop.
        const mutations = await mutationsDuring(() => {
            applyToTable(tbody, lookupFor(FAMILY), options);
        });
        expect(mutations).toEqual([]);

        const anchor = tbody.querySelector<HTMLAnchorElement>(`.${LINK_CLASS}`)!;
        // Still rendered — a button that silently disappears reads as a broken
        // extension and has nowhere to explain itself.
        expect(anchor.textContent).toBe('Bad');
        expect(anchor.hasAttribute('href')).toBe(false);
        expect(anchor.classList.contains(LINK_BLOCKED_CLASS)).toBe(true);
        expect(anchor.title).toContain('http');
    });

    it('takes the href back when a template is edited into something unsafe', () => {
        // Same anchor, re-rendered: the attribute has to be REMOVED, not merely
        // left unwritten, or the previous safe URL stays clickable forever.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'child-a', runId: CHILD_A_RUN }]);
        const lookup = lookupFor(FAMILY);
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links: links.slice(0, 1) });
        const anchor = tbody.querySelector<HTMLAnchorElement>(`.${LINK_CLASS}`)!;
        expect(anchor.hasAttribute('href')).toBe(true);

        applyToTable(tbody, lookup, {
            ...OPTIONS,
            linksEnabled: true,
            links: [{ label: 'Logs', urlTemplate: 'javascript:alert(1)' }],
        });
        expect(tbody.querySelector(`.${LINK_CLASS}`)).toBe(anchor); // the same node
        expect(anchor.hasAttribute('href')).toBe(false);

        // …and gives it back when the template is fixed.
        applyToTable(tbody, lookup, { ...OPTIONS, linksEnabled: true, links: links.slice(0, 1) });
        expect(anchor.classList.contains(LINK_BLOCKED_CLASS)).toBe(false);
        expect(anchor.getAttribute('href')).toContain('https://example.com/search');
    });

    it('does not add a button to a row it has no data for', () => {
        // Without a row there is nothing to put in the template, and a button
        // that searches for "{workflowId}" is worse than no button.
        const tbody = buildWorkflowTable(document, [{ workflowId: 'not-in-the-api-response' }]);
        applyToTable(tbody, lookupFor(FAMILY), { ...OPTIONS, linksEnabled: true, links });
        expect(tbody.querySelectorAll(`.${LINK_CLASS}`)).toHaveLength(0);
    });
});
