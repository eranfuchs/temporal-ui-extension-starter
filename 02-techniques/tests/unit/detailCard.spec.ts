// @vitest-environment jsdom
//
// The card on a single workflow's page. These specs are less about the markup than
// about four decisions that are invisible from the outside:
//
//   1. It draws on a workflow's page and nowhere else.
//   2. A template's own tokens decide whether it is drawn once or once per
//      activity. There is no setting for that anywhere.
//   3. A second pass with nothing new to say must not touch the DOM. This card is
//      on <body>, which is the node the MutationObserver watches, so a rebuild that
//      is not needed is not slow — it is a loop.
//   4. A message about a different workflow is dropped, and no message ever puts a
//      failure message on screen.

import { beforeEach, describe, expect, it } from 'vitest';

import {
    CARD_ACTIVITY_LIMIT,
    clearDetailFacts,
    receiveDetailFacts,
    syncDetailCard,
    type DetailCardOptions,
} from '../../src/detailCard';
import { MAX_ACTIVITIES, NO_FACTS, type DetailActivity, type DetailFacts } from '../../src/detail';
import { CARD_CLASS, LINK_BLOCKED_CLASS, LINK_CLASS } from '../../src/render';
import { fakeRunId } from '../helpers';
import { MESSAGE_SOURCE } from '../../src/types';

const RUN = fakeRunId(801);
const OTHER_RUN = fakeRunId(802);
const NS = 'sample-namespace';
const PATH = `/namespaces/${NS}/workflows/order-42/${RUN}/history`;
const NOW = Date.parse('2026-01-01T12:00:00Z');

const WORKFLOW_LINK = { label: 'Logs', urlTemplate: 'https://logs.example.com/?wf={workflowId}&t={startTimeIso}' };
const ACTIVITY_LINK = {
    label: 'Activity logs',
    urlTemplate: 'https://logs.example.com/?wf={workflowId}&a={activityType}&n={activityAttempt}',
};

function activity(overrides: Partial<DetailActivity> = {}): DetailActivity {
    return {
        scheduledEventId: '5',
        activityId: 'charge-1',
        activityType: 'ChargeCard',
        attempt: null,
        scheduledAtMs: Date.parse('2026-01-01T11:00:00Z'),
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

function sync(overrides: Partial<DetailCardOptions> = {}): boolean {
    return syncDetailCard({
        enabled: true,
        links: [WORKFLOW_LINK],
        pathname: PATH,
        nowMs: NOW,
        ...overrides,
    });
}

function card(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>(`.${CARD_CLASS}`);
}

function bodyText(): string {
    return card()?.querySelector('.tuis-card-body')?.textContent ?? '';
}

function links(): HTMLAnchorElement[] {
    return Array.from(card()?.querySelectorAll<HTMLAnchorElement>(`.${LINK_CLASS}`) ?? []);
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

// ── Where it draws ───────────────────────────────────────────────────────────

describe('where the card appears', () => {
    it('draws on a workflow page once a template is configured', () => {
        expect(sync()).toBe(true);
        expect(card()).not.toBeNull();
    });

    it('draws nothing on the list page, and removes what it drew', () => {
        sync();
        expect(card()).not.toBeNull();
        // Navigating within the single-page app: same module, different path.
        expect(sync({ pathname: `/namespaces/${NS}/workflows` })).toBe(false);
        expect(card()).toBeNull();
    });

    it('draws nothing with no templates configured', () => {
        // The card exists to show link templates; an empty one would be a box that
        // explains that there is nothing to explain.
        expect(sync({ links: [] })).toBe(false);
        expect(card()).toBeNull();
    });

    it('is removed by the master switch, and comes straight back', () => {
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        sync();
        expect(bodyText()).toContain('ProcessOrder');

        expect(sync({ enabled: false })).toBe(false);
        expect(card()).toBeNull();

        // The facts survive the switch on purpose (see clearDetailFacts): a closed
        // workflow's page may never fetch its history again, so dropping them would
        // leave the card saying "nothing observed" until a reload.
        expect(sync()).toBe(true);
        expect(bodyText()).toContain('ProcessOrder');
    });
});

// ── What it says before anything has been observed ───────────────────────────

describe('before any response has been observed', () => {
    it('says so, and says it does not fetch', () => {
        sync();
        // The visible consequence of the piggyback. A reader who does not know that
        // would file this as a bug.
        expect(bodyText()).toContain('Nothing observed on this page yet');
        expect(links()).toHaveLength(0);
    });

    it('says it is still reading when the observed page had no start time', () => {
        // A middle page of a paged history: activities, no WorkflowExecutionStarted.
        receiveDetailFacts(message({ facts: { ...NO_FACTS, eventsSeen: 100, activities: [activity()] } }), PATH);
        sync();
        expect(bodyText()).toContain('Reading this workflow');
        expect(links()).toHaveLength(0);
    });
});

// ── Scope: one vocabulary, two scopes ────────────────────────────────────────

describe('scope', () => {
    beforeEach(() => {
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

    it('draws a workflow template once, whatever the activity count', () => {
        sync({ links: [WORKFLOW_LINK] });
        expect(links()).toHaveLength(1);
        expect(links()[0]!.getAttribute('href')).toBe(
            `https://logs.example.com/?wf=order-42&t=${encodeURIComponent('2026-01-01T10:00:00.000Z')}`,
        );
    });

    it('draws an activity template once per activity, newest first', () => {
        sync({ links: [ACTIVITY_LINK] });
        const drawn = links();
        expect(drawn).toHaveLength(2);
        // '9' before '5': the newest activity is the one somebody on this page is
        // looking at.
        expect(drawn[0]!.getAttribute('href')).toContain('a=ShipOrder');
        expect(drawn[1]!.getAttribute('href')).toContain('a=ChargeCard');
        expect(bodyText()).toContain('ShipOrder');
    });

    it('splits a mixed list without being told which is which', () => {
        // Two workflow-scoped links + one activity-scoped link × two activities.
        sync({ links: [WORKFLOW_LINK, ACTIVITY_LINK, { label: 'Trace', urlTemplate: 'https://t.example.com/{runId}' }] });
        expect(links()).toHaveLength(4);
    });

    it('teaches the activity tokens when none are configured', () => {
        sync({ links: [WORKFLOW_LINK] });
        expect(bodyText()).toContain('Add {activityType} to a link template');
    });

    it('reports a token Temporal has not filled instead of guessing it', () => {
        // A pending activity has no attempt count in the history. The link is still
        // drawn — most of it is useful — and the title names what is missing.
        sync({ links: [ACTIVITY_LINK] });
        const drawn = links()[0]!;
        expect(drawn.title).toContain('Unknown tokens: {activityAttempt}');
        expect(drawn.classList.contains(LINK_BLOCKED_CLASS)).toBe(false);
    });

    it('leaves a misspelled token alone, and says which one', () => {
        // Not the same case as the one above, and the difference is worth a spec of
        // its own: `{attempt}` is not a token this build has, so the template is
        // workflow-scoped (see templateScope) and the token stays literal. An
        // earlier draft of these specs used `{attempt}` believing it was the
        // activity one, and every assertion passed for the wrong reason.
        sync({ links: [{ label: 'Typo', urlTemplate: 'https://logs.example.com/?n={attempt}' }] });
        expect(links()).toHaveLength(1);
        expect(links()[0]!.getAttribute('href')).toBe('https://logs.example.com/?n={attempt}');
        expect(links()[0]!.title).toContain('Unknown tokens: {attempt}');
    });

    it('gives every link the same three attributes the table gives its own', () => {
        sync({ links: [ACTIVITY_LINK] });
        for (const anchor of links()) {
            expect(anchor.target).toBe('_blank');
            expect(anchor.rel).toBe('noopener noreferrer');
            expect(anchor.referrerPolicy).toBe('no-referrer');
        }
    });

    it('refuses to open a template that is not an absolute http(s) URL', () => {
        sync({ links: [{ label: 'Bad', urlTemplate: 'javascript:alert({workflowId})' }] });
        const drawn = links()[0]!;
        expect(drawn.hasAttribute('href')).toBe(false);
        expect(drawn.classList.contains(LINK_BLOCKED_CLASS)).toBe(true);
    });
});

// ── The activity line ────────────────────────────────────────────────────────

describe('the activity line', () => {
    it('shows the attempt count, the state and the age — and no failure message', () => {
        receiveDetailFacts(
            message({
                from: 'describe',
                facts: facts({ activities: [activity({ attempt: 900, pending: true })] }),
            }),
            PATH,
        );
        sync({ links: [ACTIVITY_LINK] });
        expect(bodyText()).toContain('ChargeCard · ↻ 900 · pending · 1h');
        // The one assertion in this file about a decision rather than a shape: the
        // fold never carries a failure message, so there is none here to leak. See
        // the note at the top of src/rowInfo.ts.
        expect(bodyText()).not.toContain('declined');
    });

    it('does not call a first attempt a retry', () => {
        receiveDetailFacts(message({ facts: facts({ activities: [activity({ attempt: 1 })] }) }), PATH);
        sync({ links: [ACTIVITY_LINK] });
        expect(bodyText()).not.toContain('↻');
    });

    it('states how much of the history it is talking about', () => {
        receiveDetailFacts(message({ facts: facts({ eventsSeen: 40, activities: [activity()] }) }), PATH);
        sync({ links: [ACTIVITY_LINK] });
        // The UI pages history lazily, so this list is genuinely not the whole
        // workflow and the card must not imply that it is.
        expect(bodyText()).toContain('From the 40 history events this page has loaded');
    });

    it('counts the activities it did not list', () => {
        const many = Array.from({ length: CARD_ACTIVITY_LIMIT + 3 }, (_, i) =>
            activity({ scheduledEventId: String(100 + i), activityId: `a-${i}`, activityType: `Step${i}` }),
        );
        receiveDetailFacts(message({ facts: facts({ activities: many }) }), PATH);
        sync({ links: [ACTIVITY_LINK] });
        expect(links()).toHaveLength(CARD_ACTIVITY_LIMIT);
        expect(bodyText()).toContain('+3 older activities not listed.');
    });

    it('writes an activity type as text, never as markup', () => {
        receiveDetailFacts(
            message({ facts: facts({ activities: [activity({ activityType: '<img src=x onerror=1>' })] }) }),
            PATH,
        );
        sync({ links: [ACTIVITY_LINK] });
        expect(card()!.querySelector('img')).toBeNull();
        expect(bodyText()).toContain('<img src=x onerror=1>');
    });
});

// ── Idempotency ──────────────────────────────────────────────────────────────

describe('a pass with nothing new to say', () => {
    it('does not touch the DOM', () => {
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        sync({ links: [WORKFLOW_LINK, ACTIVITY_LINK] });
        const before = links()[0]!;

        sync({ links: [WORKFLOW_LINK, ACTIVITY_LINK] });
        // Node identity, not markup equality: a rebuild that produced the same HTML
        // would still have woken the MutationObserver, which is the actual failure.
        expect(links()[0]).toBe(before);
    });

    it('does not rebuild just because time passed', () => {
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        sync({ links: [ACTIVITY_LINK] });
        const before = links()[0]!;
        // Every age in the card is rounded to whole minutes or hours, so a pass a
        // second later has nothing to redraw. nowMs is excluded from the signature
        // for exactly this reason.
        sync({ links: [ACTIVITY_LINK], nowMs: NOW + 1000 });
        expect(links()[0]).toBe(before);
    });

    it('does rebuild when a template is edited', () => {
        receiveDetailFacts(message(), PATH);
        sync({ links: [WORKFLOW_LINK] });
        const before = links()[0]!;
        sync({ links: [{ ...WORKFLOW_LINK, label: 'Logs (staging)' }] });
        expect(links()[0]).not.toBe(before);
        expect(links()[0]!.textContent).toBe('Logs (staging)');
    });

    it('does rebuild when a new response is observed', () => {
        receiveDetailFacts(message(), PATH);
        sync({ links: [ACTIVITY_LINK] });
        expect(bodyText()).toContain('No activities in the history read so far.');

        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        sync({ links: [ACTIVITY_LINK] });
        expect(bodyText()).toContain('ChargeCard');
    });
});

// ── The collapse toggle ──────────────────────────────────────────────────────

describe('collapsing', () => {
    it('survives a rebuild', () => {
        receiveDetailFacts(message(), PATH);
        sync();
        card()!.querySelector<HTMLButtonElement>('.tuis-card-toggle')!.click();
        expect(card()!.classList.contains('tuis-card-collapsed')).toBe(true);

        // A new observation rebuilds the body. Reading the collapsed state off a
        // node that is about to be replaced is how a folded card springs open.
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        sync();
        expect(card()!.classList.contains('tuis-card-collapsed')).toBe(true);
    });

    it('survives the card being removed and reinstated', () => {
        // The everyday case is the master switch, or a walk to the list page and
        // back: the shell is built from scratch, while `collapsed` outlives it. A
        // mutation audit caught this — the spec above passes even with the state
        // never reapplied, because that path reuses the existing card node.
        receiveDetailFacts(message(), PATH);
        sync();
        card()!.querySelector<HTMLButtonElement>('.tuis-card-toggle')!.click();

        sync({ enabled: false });
        sync();
        expect(card()!.classList.contains('tuis-card-collapsed')).toBe(true);
        // And the caret has to agree with the body it controls.
        expect(card()!.querySelector('.tuis-card-toggle')!.textContent).toBe('▸');
    });
});

// ── Which messages are believed ──────────────────────────────────────────────

describe('receiveDetailFacts', () => {
    it('accepts an answer about the workflow on screen', () => {
        expect(receiveDetailFacts(message(), PATH)).toBe(true);
    });

    it('rejects an answer about another run, workflow or namespace', () => {
        expect(receiveDetailFacts(message({ runId: OTHER_RUN }), PATH)).toBe(false);
        expect(receiveDetailFacts(message({ workflowId: 'order-43' }), PATH)).toBe(false);
        expect(receiveDetailFacts(message({ namespace: 'other' }), PATH)).toBe(false);
        sync();
        expect(bodyText()).toContain('Nothing observed on this page yet');
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
        // History names the activity; describe carries its live attempt count. The
        // card needs both, and they arrive separately.
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        receiveDetailFacts(
            message({
                from: 'describe',
                facts: { ...NO_FACTS, activities: [activity({ activityId: '', activityType: '', attempt: 900, pending: true })] },
            }),
            PATH,
        );
        sync({ links: [ACTIVITY_LINK] });
        expect(bodyText()).toContain('ChargeCard · ↻ 900 · pending');
        expect(links()[0]!.getAttribute('href')).toContain('n=900');
    });

    it('drops what it knew when the page moves to a different run', () => {
        receiveDetailFacts(message({ facts: facts({ activities: [activity()] }) }), PATH);
        sync({ links: [ACTIVITY_LINK] });
        expect(bodyText()).toContain('ChargeCard');

        const otherPath = `/namespaces/${NS}/workflows/order-42/${OTHER_RUN}/history`;
        sync({ links: [ACTIVITY_LINK], pathname: otherPath });
        // Not a stale ChargeCard from the previous run — that would be the card
        // asserting something false about the workflow on screen.
        expect(bodyText()).toContain('Nothing observed on this page yet');
    });

    it('will not take an unbounded activity list from a forged message', () => {
        const many = Array.from({ length: MAX_ACTIVITIES + 1 }, (_, i) =>
            activity({ scheduledEventId: String(i) }),
        );
        expect(receiveDetailFacts(message({ facts: facts({ activities: many }) }), PATH)).toBe(false);
    });
});
