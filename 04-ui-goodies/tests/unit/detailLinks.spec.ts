// @vitest-environment jsdom
//
// The deep links on a single workflow's own page. These specs are less about the
// markup than about five decisions that are invisible from the outside:
//
//   1. Both sites are INSIDE the page's own layout — the bar beside the page's own
//      tabs, the activity links inside the row the UI labels "Activity Id". The
//      floating box this file used to test is the failure, not the design; the note
//      at the top of src/detail/detailLinks.ts says why.
//   2. When the layout cannot be found the bar is parked somewhere VISIBLE and
//      returns inline by itself on a later pass. A way-station, not a destination.
//   3. An activity link is about ONE activity, resolved from the id on screen. An
//      id that resolves to nothing gets no link at all.
//   4. A pass with nothing new to say must not touch the DOM — asserted here with a
//      MutationObserver, because this feature writes into a subtree the content
//      script is itself observing, so a needless rebuild is not slow, it is a loop.
//   5. A message about a different workflow is dropped, and no message ever puts a
//      failure message on screen.

import { beforeEach, describe, expect, it } from 'vitest';

import {
    clearDetailFacts,
    detailLinkStats,
    MAX_ACTIVITY_PANELS,
    receiveDetailFacts,
    syncDetailLinks,
    type DetailLinksOptions,
} from '../../src/detail/detailLinks';
import { MAX_ACTIVITIES, NO_FACTS, type DetailActivity, type DetailFacts } from '../../src/detail/detail';
import { ACTIVITY_LINKS_CLASS, LINK_BAR_CLASS, LINK_BLOCKED_CLASS, LINK_CLASS } from '../../src/decoration';
import { fakeRunId } from '../helpers';
import { MESSAGE_SOURCE } from '../../src/types';

const RUN = fakeRunId(801);
const OTHER_RUN = fakeRunId(802);
const NS = 'sample-namespace';
const PATH = `/namespaces/${NS}/workflows/order-42/${RUN}/history`;
const NOW = Date.parse('2026-01-01T12:00:00Z');

const WORKFLOW_LINK = { label: 'Logs', urlTemplate: 'https://logs.example.com/?wf={workflowId}&t={startTimeIso}' };
// Keyed on {activityId}, like the default in src/settings.ts and for the reason
// given there: the type repeats within a run, the id does not.
const ACTIVITY_LINK = {
    label: 'Activity logs',
    urlTemplate: 'https://logs.example.com/?wf={workflowId}&a={activityId}&n={activityAttempt}',
};

function activity(overrides: Partial<DetailActivity> = {}): DetailActivity {
    return {
        scheduledEventId: '5',
        activityId: 'charge-1',
        activityType: 'ChargeCard',
        attempt: null,
        scheduledAtMs: Date.parse('2026-01-01T11:00:00Z'),
        closedAtMs: null,
        outcome: 'open',
        pending: false,
        ...overrides,
    };
}

function facts(overrides: Partial<DetailFacts> = {}): DetailFacts {
    return {
        ...NO_FACTS,
        workflowType: 'ProcessOrder',
        taskQueue: 'orders',
        status: 'Running',
        startTimeMs: Date.parse('2026-01-01T10:00:00Z'),
        eventsSeen: 40,
        ...overrides,
    };
}

// A message as detailWatch.ts posts it.
function message(overrides: Record<string, unknown> = {}): unknown {
    return {
        source: MESSAGE_SOURCE,
        type: 'detail-facts',
        from: 'history',
        namespace: NS,
        workflowId: 'order-42',
        runId: RUN,
        facts: facts(),
        ...overrides,
    };
}

function sync(overrides: Partial<DetailLinksOptions> = {}): boolean {
    return syncDetailLinks({
        enabled: true,
        links: [WORKFLOW_LINK],
        pathname: PATH,
        nowMs: NOW,
        ...overrides,
    });
}

// ── The page ─────────────────────────────────────────────────────────────────
//
// Built out of the two things the real UI is anchored by, and nothing else: a
// <header>, and a tab bar recognised as "the list containing a link to this
// workflow's history". No class names from the real UI appear here, because none of
// them are what the code matches on.

function buildPage(options: { header?: boolean; tabs?: boolean; main?: boolean } = {}): HTMLElement {
    const host = options.main === false ? document.body : document.createElement('main');
    if (options.main !== false) document.body.appendChild(host);

    if (options.header !== false) {
        const header = document.createElement('header');
        const title = document.createElement('h1');
        title.textContent = 'order-42';
        header.appendChild(title);
        host.appendChild(header);
    }
    if (options.tabs !== false) host.appendChild(buildTabs());

    const panels = document.createElement('div');
    panels.id = 'panels';
    host.appendChild(panels);
    return host;
}

function buildTabs(): HTMLElement {
    const nav = document.createElement('nav');
    for (const route of ['history', 'relationships', 'workers']) {
        const tab = document.createElement('a');
        tab.setAttribute('href', `/namespaces/${NS}/workflows/order-42/${RUN}/${route}`);
        tab.textContent = route;
        nav.appendChild(tab);
    }
    return nav;
}

// One activity panel as the UI renders it: a labelled row whose label is the field's
// own name and whose next sibling holds the value. Three shapes, because the UI has
// used a definition list, a table and a flex layout for this over its versions —
// which is why the code matches the LABEL's text rather than a container.
function openPanel(id: string, options: { label?: string; shape?: 'dl' | 'table' | 'flex' } = {}): HTMLElement {
    const panels = document.getElementById('panels')!;
    const label = options.label ?? 'Activity Id';
    const shape = options.shape ?? 'dl';

    if (shape === 'table') {
        const table = document.createElement('table');
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = label;
        const td = document.createElement('td');
        td.textContent = id;
        tr.append(th, td);
        table.appendChild(tr);
        panels.appendChild(table);
        return td;
    }
    if (shape === 'flex') {
        const row = document.createElement('div');
        const name = document.createElement('span');
        name.textContent = label;
        const value = document.createElement('span');
        value.textContent = id;
        row.append(name, value);
        panels.appendChild(row);
        return value;
    }
    const list = document.createElement('dl');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = id;
    list.append(dt, dd);
    panels.appendChild(list);
    return dd;
}

// ── Reading what was drawn ───────────────────────────────────────────────────

function bar(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(`.${LINK_BAR_CLASS}`);
}

function barLinks(): HTMLAnchorElement[] {
    return Array.from(bar()?.querySelectorAll<HTMLAnchorElement>(`.${LINK_CLASS}`) ?? []);
}

function groups(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll<HTMLElement>(`.${ACTIVITY_LINKS_CLASS}`));
}

function groupLinks(): HTMLAnchorElement[] {
    return groups().flatMap((group) => Array.from(group.querySelectorAll<HTMLAnchorElement>(`.${LINK_CLASS}`)));
}

function barText(): string {
    return bar()?.textContent ?? '';
}

beforeEach(() => {
    // textContent, not innerHTML: the sink ban in scripts/surface.json has no
    // allowance list and covers the specs too, which is the point — a spec is where
    // `innerHTML` gets habitual.
    document.body.textContent = '';
    // The module holds the observed run for the tab's lifetime, and every spec in
    // this file shares one instance of it.
    clearDetailFacts();
});

// ── Where the workflow-scoped bar goes ───────────────────────────────────────

describe('the workflow link bar', () => {
    it('goes inside the page’s own layout, before its tabs', () => {
        const main = buildPage();
        expect(sync()).toBe(true);
        // In the UI's own container, immediately before the UI's own tab bar. This is
        // the demand the floating card failed: part of the existing GUI.
        expect(bar()!.parentElement).toBe(main);
        expect(bar()!.nextElementSibling).toBe(main.querySelector('nav'));
        expect(bar()!.classList.contains('tuis-linkbar-adrift')).toBe(false);
    });

    it('falls back to just after the header when the tabs have not rendered', () => {
        // The first frames of a single-page app, every time.
        const main = buildPage({ tabs: false });
        sync();
        expect(bar()!.previousElementSibling).toBe(main.querySelector('header'));
        expect(bar()!.classList.contains('tuis-linkbar-adrift')).toBe(false);
    });

    it('ignores the site-wide navigation outside <main>', () => {
        // A page has more than one <nav>, and the outer one holds links too. Scoping
        // to <main> is what stops this bar from landing in the app's own chrome.
        const outer = buildTabs();
        document.body.appendChild(outer);
        const main = buildPage({ tabs: false });
        sync();
        expect(outer.previousElementSibling).not.toBe(bar());
        expect(bar()!.parentElement).toBe(main);
    });

    it('parks itself where it can be SEEN when it recognises nothing', () => {
        // The failure this design is most likely to have: selectors go stale, and the
        // node ends up on <body> at the top-left, behind the app's chrome, reading as
        // "the feature does nothing". So it is labelled instead of hidden, and the
        // popup counts it.
        buildPage({ header: false, tabs: false, main: false });
        expect(sync()).toBe(true);
        expect(bar()!.parentElement).toBe(document.body);
        expect(bar()!.classList.contains('tuis-linkbar-adrift')).toBe(true);
        expect(detailLinkStats().linksAdrift).toBe(true);
    });

    it('comes back inline by itself once the layout appears', () => {
        // The whole justification for the corner being acceptable: it is a
        // way-station. Every pass looks for the real anchor again.
        buildPage({ header: false, tabs: false, main: false });
        sync();
        const parked = bar()!;

        const main = document.createElement('main');
        main.appendChild(buildTabs());
        document.body.appendChild(main);
        sync();

        // The same node, moved — not a second bar, and not a rebuild.
        expect(bar()).toBe(parked);
        expect(parked.parentElement).toBe(main);
        expect(parked.classList.contains('tuis-linkbar-adrift')).toBe(false);
        expect(detailLinkStats().linksAdrift).toBe(false);
    });

    it('draws nothing on the list page, and removes what it drew', () => {
        buildPage();
        sync();
        expect(bar()).not.toBeNull();
        // Navigating within the single-page app: same module, different path.
        expect(sync({ pathname: `/namespaces/${NS}/workflows` })).toBe(false);
        expect(bar()).toBeNull();
    });

    it('draws nothing with no templates configured', () => {
        buildPage();
        expect(sync({ links: [] })).toBe(false);
        expect(bar()).toBeNull();
    });

    it('is removed by the master switch, and comes straight back', () => {
        buildPage();
        receiveDetailFacts(message(), PATH);
        sync();
        expect(barLinks()).toHaveLength(1);

        expect(sync({ enabled: false })).toBe(false);
        expect(bar()).toBeNull();

        // The facts survive the switch on purpose (see clearDetailFacts): a closed
        // workflow's page may never fetch its history again, so dropping them would
        // leave the bar saying "nothing observed" until a reload.
        expect(sync()).toBe(true);
        expect(barLinks()).toHaveLength(1);
    });

    it('says the workflow tokens are filled from what the page fetched', () => {
        buildPage();
        receiveDetailFacts(message(), PATH);
        sync();
        expect(barLinks()[0]!.getAttribute('href')).toBe(
            `https://logs.example.com/?wf=order-42&t=${encodeURIComponent('2026-01-01T10:00:00.000Z')}`,
        );
        // The scope of everything in the bar, on the bar: the UI pages history
        // lazily, so this is genuinely not the whole workflow. "at least" is part of
        // the assertion because the count is a floor — mergeFacts() takes the max of
        // the responses rather than their sum, so a paged history has loaded more
        // than this. See the eventsSeen note in detail.ts.
        expect(bar()!.title).toContain('at least 40 history events this page has loaded');
    });

    it('refuses to open a template that is not an absolute http(s) URL', () => {
        buildPage();
        receiveDetailFacts(message(), PATH);
        sync({ links: [{ label: 'Bad', urlTemplate: 'javascript:alert({workflowId})' }] });
        const drawn = barLinks()[0]!;
        expect(drawn.hasAttribute('href')).toBe(false);
        expect(drawn.classList.contains(LINK_BLOCKED_CLASS)).toBe(true);
    });
});

// ── What it says before anything has been observed ───────────────────────────

describe('before any response has been observed', () => {
    it('says so, and says it does not fetch', () => {
        buildPage();
        sync();
        // The visible consequence of the piggyback. A reader who does not know that
        // would file this as a bug.
        expect(barText()).toContain('Nothing observed on this page yet');
        expect(barLinks()).toHaveLength(0);
    });

    it('says it is still reading when the observed page had no start time', () => {
        // A middle page of a paged history: activities, no WorkflowExecutionStarted.
        buildPage();
        receiveDetailFacts(message({ facts: { ...NO_FACTS, eventsSeen: 100, activities: [activity()] } }), PATH);
        sync();
        expect(barText()).toContain('Reading this workflow');
        expect(barLinks()).toHaveLength(0);
        // And no activity link either: a window built from an unknown start time is a
        // 1970 window, which is a URL that looks like it works and returns nothing.
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        expect(groups()).toHaveLength(0);
    });
});

// ── The activity links ───────────────────────────────────────────────────────

describe('the activity links', () => {
    beforeEach(() => {
        buildPage();
        receiveDetailFacts(
            message({
                facts: facts({
                    activities: [
                        activity(),
                        activity({ scheduledEventId: '9', activityId: 'ship-1', activityType: 'ShipOrder' }),
                    ],
                }),
            }),
            PATH,
        );
    });

    it('go inside the value cell of the row the UI labels "Activity Id"', () => {
        const value = openPanel('ship-1');
        sync({ links: [ACTIVITY_LINK] });
        // Inside the UI's own cell — nothing of the UI's is moved or re-parented.
        expect(groups()).toHaveLength(1);
        expect(groups()[0]!.parentElement).toBe(value);
        // `{activityAttempt}` is left verbatim, not blanked: this activity is open
        // and Temporal has not written an ActivityTaskStarted for it, and the anchor's
        // title says which token that is. See expandTemplate.
        expect(groupLinks()[0]!.getAttribute('href')).toBe(
            'https://logs.example.com/?wf=order-42&a=ship-1&n={activityAttempt}',
        );
        expect(groupLinks()[0]!.title).toContain('Unknown tokens: {activityAttempt}');
    });

    it('are about the activity in THAT panel, not the newest one', () => {
        // The demand this whole file was rewritten for. Two panels open, two
        // different links, each resolved from the id on screen beside it.
        openPanel('charge-1');
        openPanel('ship-1');
        sync({ links: [ACTIVITY_LINK] });
        const hrefs = groupLinks().map((a) => a.getAttribute('href'));
        expect(hrefs).toHaveLength(2);
        expect(hrefs[0]).toContain('a=charge-1');
        expect(hrefs[1]).toContain('a=ship-1');
    });

    it('read the label through the UI’s spelling of it', () => {
        // The UI renders this field's name from the proto's own field name, and
        // different versions have prettified it differently. Matching one exact
        // spelling would be a claim about a formatter this extension does not own.
        for (const label of ['Activity ID', 'activity id', 'Activity Id:', 'activity_id']) {
            document.getElementById('panels')!.textContent = '';
            openPanel('charge-1', { label });
            sync({ links: [ACTIVITY_LINK] });
            expect(groups(), label).toHaveLength(1);
        }
    });

    it('find the row in every layout the UI has used for it', () => {
        for (const shape of ['dl', 'table', 'flex'] as const) {
            document.getElementById('panels')!.textContent = '';
            openPanel('charge-1', { shape });
            sync({ links: [ACTIVITY_LINK] });
            expect(groups(), shape).toHaveLength(1);
        }
    });

    it('are not drawn from a wrapper whose text merely CONTAINS the label', () => {
        // The trap that made `div` a forbidden label candidate. A wrapper div's whole
        // text is "Activity Idcharge-1", which does not normalise to the label — but
        // its next sibling is the NEXT FIELD's wrapper, so a looser match would have
        // read some other field's value as an activity id and linked confidently to
        // the wrong activity.
        const panels = document.getElementById('panels')!;
        const wrapper = document.createElement('div');
        const inner = document.createElement('div');
        inner.textContent = 'Activity Id';
        wrapper.appendChild(inner);
        const nextField = document.createElement('div');
        nextField.textContent = 'ship-1';
        panels.append(wrapper, nextField);

        sync({ links: [ACTIVITY_LINK] });
        expect(groups()).toHaveLength(0);
    });

    it('draw nothing for an id this run does not have', () => {
        // A stale panel, a truncated history, another workflow's id pasted in. No
        // link at all, rather than a link built from whichever activity is newest:
        // that is the difference between a link about this activity and a link that
        // looks like one.
        openPanel('charge-999');
        sync({ links: [ACTIVITY_LINK] });
        expect(groups()).toHaveLength(0);
    });

    it('say on the link when the id resolved to more than one activity', () => {
        // An activityId is chosen by the workflow author, so a loop can reuse one.
        // The panel shows only the id, so the reader cannot tell — and whether the
        // search results can be trusted turns on exactly this.
        receiveDetailFacts(
            message({ facts: facts({ activities: [activity(), activity({ scheduledEventId: '12' })] }) }),
            PATH,
        );
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        expect(groupLinks()[0]!.title).toContain('More than one activity in this run has this id');
        expect(groupLinks()[0]!.title).toContain('scheduled event 12');
    });

    it('say on the link when they had to match by scheduled event id', () => {
        // A history page that begins mid-workflow carries no activityId, so the panel
        // shows the event id instead. The link still works; it says which key it used.
        receiveDetailFacts(
            message({
                facts: facts({ activities: [activity({ activityId: '', activityType: '' })] }),
            }),
            PATH,
        );
        openPanel('5');
        sync({ links: [ACTIVITY_LINK] });
        expect(groupLinks()[0]!.title).toContain('Matched by scheduled event id');
    });

    it('carry the activity’s own line as a tooltip, and no failure message', () => {
        receiveDetailFacts(
            message({
                from: 'describe',
                facts: facts({ activities: [activity({ attempt: 900, pending: true })] }),
            }),
            PATH,
        );
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        expect(groups()[0]!.title).toContain('ChargeCard · ↻ 900 · pending · scheduled 1h ago');
        // The one assertion here about a decision rather than a shape: the fold never
        // carries a failure message, so there is none here to leak. See the note at
        // the top of src/rowInfo/rowInfo.ts.
        expect(groups()[0]!.title).not.toContain('declined');
    });

    it('do not appear where there is no activity template', () => {
        // Scope is read off the template, and a workflow-scoped one has nothing to
        // fill from an activity. There is no setting for this anywhere.
        openPanel('charge-1');
        sync({ links: [WORKFLOW_LINK] });
        expect(groups()).toHaveLength(0);
        expect(barLinks()).toHaveLength(1);
    });

    it('are removed when the panel closes', () => {
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        expect(groups()).toHaveLength(1);

        document.getElementById('panels')!.textContent = '';
        openPanel('ship-1');
        sync({ links: [ACTIVITY_LINK] });
        // One group, on the panel that is open now. Removing by "not touched this
        // pass" needs no bookkeeping in the DOM and cannot leave one behind.
        expect(groups()).toHaveLength(1);
        expect(groupLinks()[0]!.getAttribute('href')).toContain('a=ship-1');
    });

    it('are bounded, whatever the page contains', () => {
        const many = Array.from({ length: MAX_ACTIVITY_PANELS + 3 }, (_, i) =>
            activity({ scheduledEventId: String(100 + i), activityId: `a-${i}` }),
        );
        receiveDetailFacts(message({ facts: facts({ activities: many }) }), PATH);
        for (const item of many) openPanel(item.activityId);
        sync({ links: [ACTIVITY_LINK] });
        // Not a limit anybody meets — the UI opens one or two panels — but a bound on
        // what a hostile or broken page can make one pass do.
        expect(groups()).toHaveLength(MAX_ACTIVITY_PANELS);
    });

    it('writes an activity id as text, never as markup', () => {
        receiveDetailFacts(
            message({ facts: facts({ activities: [activity({ activityId: '<img src=x onerror=1>' })] }) }),
            PATH,
        );
        openPanel('<img src=x onerror=1>');
        sync({ links: [ACTIVITY_LINK] });
        expect(groups()).toHaveLength(1);
        expect(document.querySelector('img')).toBeNull();
        // …and it reached the URL, encoded.
        expect(groupLinks()[0]!.getAttribute('href')).toContain(encodeURIComponent('<img src=x onerror=1>'));
    });

    it('gives every link the same three attributes the table gives its own', () => {
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        for (const anchor of groupLinks()) {
            expect(anchor.target).toBe('_blank');
            expect(anchor.rel).toBe('noopener noreferrer');
            expect(anchor.referrerPolicy).toBe('no-referrer');
        }
    });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('a pass with nothing new to say', () => {
    // Every write this feature makes lands in a subtree the content script's own
    // MutationObserver is watching, so a rebuild that produces identical DOM is not
    // merely wasteful: it wakes the observer, which schedules a pass, which rebuilds.
    // Counting mutations is the only assertion that catches that; node identity alone
    // would miss an attribute rewritten to the value it already had.
    function mutationsDuring(pass: () => void): MutationRecord[] {
        const observer = new MutationObserver(() => {});
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });
        pass();
        const records = observer.takeRecords();
        observer.disconnect();
        return records;
    }

    beforeEach(() => {
        buildPage();
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        openPanel('charge-1');
    });

    it('does not touch the DOM', () => {
        sync({ links: [WORKFLOW_LINK, ACTIVITY_LINK] });
        const records = mutationsDuring(() => sync({ links: [WORKFLOW_LINK, ACTIVITY_LINK] }));
        expect(records.map((r) => `${r.type} ${r.attributeName ?? ''}`.trim())).toEqual([]);
    });

    it('does not re-insert itself after the header it already follows', () => {
        // The header fallback has an idempotency trap of its own: once the bar sits
        // immediately after the header, "the node after the header" IS the bar, so
        // asking to insert before it re-inserts it — a childList mutation on every
        // pass, on the node the content script is observing. Hence siblingAfter().
        document.querySelector('nav')!.remove();
        sync({ links: [WORKFLOW_LINK] });
        expect(bar()!.previousElementSibling!.tagName).toBe('HEADER');

        const records = mutationsDuring(() => sync({ links: [WORKFLOW_LINK] }));
        expect(records).toEqual([]);
        // And it has not walked away from the header either.
        expect(bar()!.previousElementSibling!.tagName).toBe('HEADER');
    });

    it('does not touch the DOM just because time passed', () => {
        sync({ links: [ACTIVITY_LINK] });
        // An activity's age is rounded to whole minutes and measured from a timestamp
        // in the event history, so a pass a second later has nothing to redraw.
        const records = mutationsDuring(() => sync({ links: [ACTIVITY_LINK], nowMs: NOW + 1000 }));
        expect(records).toEqual([]);
    });

    it('reads the panel id past its own links, so it does not feed itself', () => {
        // The loop this guard prevents: the link group is a child of the value cell,
        // so `valueEl.textContent` would be the id PLUS our own labels. The next pass
        // reads a different id, fails to resolve it, removes the group, reads the
        // original id again, adds it back — one rebuild per animation frame, forever.
        sync({ links: [ACTIVITY_LINK] });
        const group = groups()[0]!;
        expect(group.textContent).not.toBe('');

        sync({ links: [ACTIVITY_LINK] });
        // The same node, still there. A removed-and-recreated group is the loop.
        expect(groups()).toHaveLength(1);
        expect(groups()[0]).toBe(group);
    });

    it('does rebuild when a template is edited', () => {
        sync({ links: [WORKFLOW_LINK] });
        const before = barLinks()[0]!;
        sync({ links: [{ ...WORKFLOW_LINK, label: 'Logs (staging)' }] });
        expect(barLinks()[0]!.textContent).toBe('Logs (staging)');
        // Reused rather than replaced: the anchor is the same node with new text.
        expect(barLinks()[0]).toBe(before);
    });

    it('does redraw when a new response is observed', () => {
        sync({ links: [ACTIVITY_LINK] });
        expect(groupLinks()[0]!.getAttribute('href')).toContain('n={activityAttempt}');

        receiveDetailFacts(
            message({ from: 'describe', facts: facts({ activities: [activity({ attempt: 900 })] }) }),
            PATH,
        );
        sync({ links: [ACTIVITY_LINK] });
        expect(groupLinks()[0]!.getAttribute('href')).toContain('n=900');
    });
});

// ── What the popup is told ───────────────────────────────────────────────────

describe('detailLinkStats', () => {
    it('reports the page, what was observed, and what got linked', () => {
        // The popup's answer to "is it working?", and the reason "no workflow table"
        // is not the answer a reader gets on this page.
        window.history.replaceState({}, '', PATH);
        buildPage();
        receiveDetailFacts(
            message({
                facts: facts({
                    activities: [activity(), activity({ scheduledEventId: '9', activityId: 'ship-1' })],
                }),
            }),
            PATH,
        );
        openPanel('charge-1');
        sync({ links: [WORKFLOW_LINK, ACTIVITY_LINK] });

        expect(detailLinkStats()).toEqual({
            onDetailPage: true,
            activitiesKnown: 2,
            activityPanelsLinked: 1,
            linksAdrift: false,
        });
    });

    it('reports nothing linked on a page that is not a workflow’s', () => {
        window.history.replaceState({}, '', `/namespaces/${NS}/workflows`);
        expect(detailLinkStats()).toEqual({
            onDetailPage: false,
            activitiesKnown: 0,
            activityPanelsLinked: 0,
            linksAdrift: false,
        });
    });
});

// ── Which messages are believed ──────────────────────────────────────────────

describe('receiveDetailFacts', () => {
    beforeEach(() => {
        buildPage();
    });

    it('accepts an answer about the workflow on screen', () => {
        expect(receiveDetailFacts(message(), PATH)).toBe(true);
    });

    it('rejects an answer about another run, workflow or namespace', () => {
        expect(receiveDetailFacts(message({ runId: OTHER_RUN }), PATH)).toBe(false);
        expect(receiveDetailFacts(message({ workflowId: 'order-43' }), PATH)).toBe(false);
        expect(receiveDetailFacts(message({ namespace: 'other' }), PATH)).toBe(false);
        sync();
        expect(barText()).toContain('Nothing observed on this page yet');
    });

    it('rejects a malformed message, and one aimed at another extension', () => {
        expect(receiveDetailFacts(null, PATH)).toBe(false);
        expect(receiveDetailFacts(message({ source: 'someone-else' }), PATH)).toBe(false);
        expect(receiveDetailFacts(message({ facts: { activities: 'no' } }), PATH)).toBe(false);
    });

    it('ignores an answer that arrives after the user navigated away', () => {
        expect(receiveDetailFacts(message(), `/namespaces/${NS}/workflows`)).toBe(false);
    });

    it('merges two answers about the same run', () => {
        // History names the activity; describe carries its live attempt count. A link
        // needs both, and they arrive separately.
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        receiveDetailFacts(
            message({
                from: 'describe',
                facts: {
                    ...NO_FACTS,
                    activities: [activity({ activityId: '', activityType: '', attempt: 900, pending: true })],
                },
            }),
            PATH,
        );
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        // Resolved by the id the history knew, with the attempt count the describe
        // carried.
        expect(groupLinks()[0]!.getAttribute('href')).toContain('a=charge-1&n=900');
    });

    it('drops what it knew when the page moves to a different run', () => {
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        openPanel('charge-1');
        sync({ links: [ACTIVITY_LINK] });
        expect(groups()).toHaveLength(1);

        const otherPath = `/namespaces/${NS}/workflows/order-42/${OTHER_RUN}/history`;
        sync({ links: [ACTIVITY_LINK], pathname: otherPath });
        // Not a stale charge-1 from the previous run — that would be a link asserting
        // something false about the workflow on screen.
        expect(groups()).toHaveLength(0);
        expect(barText()).toContain('Nothing observed on this page yet');
    });

    it('will not take an unbounded activity list from a forged message', () => {
        const many = Array.from({ length: MAX_ACTIVITIES + 1 }, (_, i) => activity({ scheduledEventId: String(i) }));
        expect(receiveDetailFacts(message({ facts: facts({ activities: many }) }), PATH)).toBe(false);
    });
});
