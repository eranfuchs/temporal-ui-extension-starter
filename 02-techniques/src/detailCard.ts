// ISOLATED world: the deep-link card on a single workflow's own page.
//
// One box, bottom-right: the workflow-scoped links once, then the activity-scoped
// links for each activity the page's own history mentioned.
//
// ── WHY A FLOATING CARD AND NOT BUTTONS IN THE EVENT TABLE ───────────────────
//
// Rule 1 at the top of render.ts is ANCHOR TO MEANING, NOT POSITION, and on the
// workflow list there is a perfect anchor: `a[href*="/workflows/"]` is what a row
// IS. A workflow's own page has no equivalent for "the row of activity N" — the
// timeline is SVG, the event list is virtualised, and neither carries a stable
// hook that means "this activity". Anchoring to a class or a position there is a
// guess that breaks on the next UI release.
//
// The internal extension this starter came from learned that expensively: a button
// whose anchor selectors had gone stale was not missing, it was ATTACHED TO <body>
// at the top-left, invisible behind the app's own chrome. It read as "the feature
// only appears after you toggle it", and it was diagnosed twice before somebody
// found the real cause. A deliberate fixed position is the honest version of what
// that bug produced by accident.
//
// ── IT FETCHES NOTHING ───────────────────────────────────────────────────────
//
// Everything here comes from responses the page fetched for itself, folded in the
// MAIN world by detailWatch.ts. No request, no cache, no pacing, and no ledger
// check — a ledger entry is authority to spend the page's bearer, and this feature
// never spends it. src/rowInfo.ts is the file to read for the other case.
//
// The consequence is worth stating because it shows on screen: on a tab that was
// already open on a workflow when the extension loaded, the card says it has
// observed nothing and asks for a reload. It does NOT go and fetch the history to
// fill itself in. That is the trade this stage of the starter kit is demonstrating.

import {
    acceptFactsFor,
    activityForLink,
    detailRefFromPath,
    isDetailFactsMessage,
    linkableActivities,
    mergeFacts,
    NO_FACTS,
    rowFromFacts,
    type DetailActivity,
    type DetailFacts,
    type DetailRef,
} from './detail';
import { expandTemplate, templatesInScope, type DeepLinkTemplate } from './deepLink';
import { CARD_CLASS, LINK_BLOCKED_CLASS, LINK_CLASS } from './render';
import { formatAge } from './rowInfo';

// How many activities get their own line. A workflow with hundreds of activities
// would otherwise produce a card taller than the screen and slower to rebuild than
// the page it is drawn on; the rest are counted in the footer. Newest first,
// because the newest is what somebody on this page is looking at.
export const CARD_ACTIVITY_LIMIT = 20;

const HEAD_CLASS = 'tuis-card-head';
const TOGGLE_CLASS = 'tuis-card-toggle';
const BODY_CLASS = 'tuis-card-body';
const GROUP_CLASS = 'tuis-card-group';
const LABEL_CLASS = 'tuis-card-label';
const NOTE_CLASS = 'tuis-card-note';
const COLLAPSED_CLASS = 'tuis-card-collapsed';

// ── What we know, and where it came from ─────────────────────────────────────

// The run these facts are about, and the facts. Replaced wholesale when the page
// navigates to a different run: a single-page app keeps this module loaded across
// navigations, and merging two workflows' activities into one card would be worse
// than showing none.
let observed: { ref: DetailRef; facts: DetailFacts } | null = null;

// Whether the user folded the card away. Kept in a variable rather than read off
// the DOM because the body is rebuilt whenever the facts change, and re-reading it
// from a node that is about to be replaced is how a collapsed card springs open on
// the next poll.
let collapsed = false;

// The last body signature written, so a pass with nothing new to say touches
// nothing at all — rule 2 at the top of render.ts, and it applies with particular
// force here: this card is on <body>, which is exactly what content.ts's
// MutationObserver watches, so an unconditional rebuild would wake the observer,
// which would schedule a pass, which would rebuild. That is not a slow render;
// it is one core, forever.
let renderedSignature = '';

export function receiveDetailFacts(data: unknown, pathname: string): boolean {
    if (!isDetailFactsMessage(data)) return false;
    const page = detailRefFromPath(pathname);
    // Not on a workflow's page (any more). The answer to a request made before the
    // user navigated away arrives after they have, every time.
    if (!page) return false;
    if (!acceptFactsFor(page, { namespace: data.namespace, workflowId: data.workflowId, runId: data.runId })) {
        return false;
    }
    const base = observed && sameRun(observed.ref, page) ? observed.facts : NO_FACTS;
    observed = { ref: page, facts: mergeFacts(base, data.facts) };
    return true;
}

// Registers the message listener. Split from receiveDetailFacts so the merge rules
// are testable without a window — the same split as installRowInfo().
export function installDetailCard(onFacts: () => void): void {
    window.addEventListener('message', (event: MessageEvent) => {
        // A filter, not a check: it says the message came from this page rather
        // than an iframe, and every script in this page passes it. See the note on
        // isDetailFactsMessage() for what a forged one can and cannot do.
        if (event.source !== window) return;
        if (receiveDetailFacts(event.data, location.pathname)) onFacts();
    });
}

// Exported for the tests, which share one instance of this module across every
// spec in a file and would otherwise inherit the previous spec's workflow.
//
// NOT called when the master switch goes off: removeAllDecoration() takes the card
// off the page, and keeping the facts means switching back on redraws it
// immediately instead of showing "nothing observed yet" until the page happens to
// fetch its history again — which, for a closed workflow, may be never.
export function clearDetailFacts(): void {
    observed = null;
    renderedSignature = '';
    collapsed = false;
}

// For the popup. A feature whose effect cannot be seen from outside the page is
// hard to review, and "the card is showing 7 activities" is the shortest possible
// statement that this is working.
export function detailCardStats(): { onDetailPage: boolean; activitiesKnown: number } {
    return {
        onDetailPage: detailRefFromPath(location.pathname) !== null,
        activitiesKnown: observed ? observed.facts.activities.length : 0,
    };
}

function sameRun(a: DetailRef, b: DetailRef): boolean {
    return a.namespace === b.namespace && a.workflowId === b.workflowId && a.runId === b.runId;
}

// ── Drawing it ───────────────────────────────────────────────────────────────

export interface DetailCardOptions {
    // The master switch AND the links switch, resolved by the caller. The card
    // exists to show link templates, so it has no separate setting of its own —
    // one more toggle whose only state worth having is "off" is one more thing to
    // explain in the popup.
    enabled: boolean;
    links: DeepLinkTemplate[];
    // Passed in rather than read from location/Date so that every case below is
    // reachable from a jsdom test without navigating anything.
    pathname: string;
    nowMs: number;
    root?: HTMLElement;
}

// Returns true when a card is on the page after this pass.
export function syncDetailCard(options: DetailCardOptions): boolean {
    const root = options.root ?? document.body;
    if (!root) return false;
    const page = detailRefFromPath(options.pathname);

    // Facts about a run we are no longer looking at are dropped here rather than
    // on navigation: there is no navigation event to hook in a single-page app
    // that does not also fire for things that are not navigations.
    if (observed && (!page || !sameRun(observed.ref, page))) observed = null;

    if (!options.enabled || !page || options.links.length === 0) {
        removeDetailCard(root);
        return false;
    }

    const signature = signatureOf(page, options);
    const existing = root.querySelector<HTMLElement>(`:scope > .${CARD_CLASS}`);
    if (existing && signature === renderedSignature) {
        // Nothing about the data changed. The collapse class is the one thing the
        // user can have altered since, and toggle() with an explicit force does not
        // write when the token is already in the wanted state.
        existing.classList.toggle(COLLAPSED_CLASS, collapsed);
        return true;
    }

    const card = existing ?? buildShell(root);
    const body = card.querySelector<HTMLElement>(`.${BODY_CLASS}`)!;
    // Replaced wholesale rather than diffed node by node. The signature above is
    // what keeps that from happening on every pass, and a card whose contents
    // changed is a card whose every line may have moved.
    body.textContent = '';
    fillBody(body, page, options);
    card.classList.toggle(COLLAPSED_CLASS, collapsed);
    renderedSignature = signature;
    return true;
}

export function removeDetailCard(root: ParentNode = document): void {
    for (const node of Array.from(root.querySelectorAll(`.${CARD_CLASS}`))) node.remove();
    renderedSignature = '';
}

// Everything the rendered card depends on, in one string. If two passes produce
// the same signature they would produce the same DOM, which is what makes skipping
// the second one safe.
//
// The separators are ASCII control characters, one per nesting level (\u0001 inside
// an activity, \u0005 between top-level fields), and they are written as ESCAPES
// rather than as the characters themselves. Two reasons, in that order: a workflow
// id, an activity type and a link label are all attacker-influenced strings, and
// joining them with a character none of them can contain is what stops two
// different cards from producing one signature. And a raw control character in
// source is invisible in an editor, invisible in a diff, and makes a grep for its
// own line fail — which is exactly how the U+0004 that used to be on the
// `activities.join` line below was eventually found.
function signatureOf(page: DetailRef, options: DetailCardOptions): string {
    const facts = observed?.facts ?? NO_FACTS;
    const activities = linkableActivities(facts)
        .slice(0, CARD_ACTIVITY_LIMIT)
        .map((a) => [a.scheduledEventId, a.activityType, a.activityId, a.attempt, a.outcome, a.pending].join('\u0001'));
    return [
        page.namespace,
        page.workflowId,
        page.runId ?? '',
        // The templates, because editing one in the popup has to redraw the card.
        options.links.map((link) => `${link.label}\u0002${link.urlTemplate}`).join('\u0003'),
        facts.workflowType ?? '',
        facts.status ?? '',
        facts.startTimeMs ?? '',
        facts.endTimeMs ?? '',
        facts.activities.length,
        facts.eventsSeen,
        activities.join('\u0004'),
        // NOT options.nowMs. Every field it feeds is a relative age rounded to
        // whole minutes or hours by formatAge, so including it would rewrite the
        // card on every animation frame to change nothing.
    ].join('\u0005');
}

function buildShell(root: HTMLElement): HTMLElement {
    const doc = root.ownerDocument;
    const card = doc.createElement('div');
    card.className = CARD_CLASS;

    const head = doc.createElement('div');
    head.className = HEAD_CLASS;
    const title = doc.createElement('span');
    title.textContent = 'Deep links';
    const toggle = doc.createElement('button');
    toggle.className = TOGGLE_CLASS;
    toggle.type = 'button';
    // Painted from the module's state, not hardcoded open. This shell is rebuilt
    // from scratch whenever the card was removed and reinstated — the master switch
    // going off and on again is the everyday case — and `collapsed` outlives that,
    // so a hardcoded caret would point down over a folded card.
    paintToggle(toggle);
    toggle.addEventListener('click', () => {
        collapsed = !collapsed;
        card.classList.toggle(COLLAPSED_CLASS, collapsed);
        paintToggle(toggle);
    });
    head.append(title, toggle);

    const body = doc.createElement('div');
    body.className = BODY_CLASS;
    card.append(head, body);
    root.appendChild(card);
    return card;
}

function paintToggle(toggle: HTMLElement): void {
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.title = collapsed ? 'Expand' : 'Collapse';
}

function fillBody(body: HTMLElement, page: DetailRef, options: DetailCardOptions): void {
    const doc = body.ownerDocument;
    const facts = observed?.facts ?? NO_FACTS;
    const row = rowFromFacts(page, facts);

    // No start time yet means no observation has landed, or only a middle page of
    // history has. Say which and stop — see rowFromFacts() for why a link is not
    // drawn from a workflow whose own start time is unknown.
    if (!row) {
        body.appendChild(
            note(
                doc,
                observed
                    ? 'Reading this workflow’s own history…'
                    : 'Nothing observed on this page yet — reload it and the links appear. This extension does not fetch the history itself.',
            ),
        );
        return;
    }

    const workflowLinks = templatesInScope(options.links, 'workflow');
    const activityLinks = templatesInScope(options.links, 'activity');

    if (workflowLinks.length > 0) {
        const group = doc.createElement('div');
        group.className = GROUP_CLASS;
        group.appendChild(label(doc, facts.workflowType ?? 'this workflow'));
        for (const template of workflowLinks) {
            group.appendChild(
                anchorFor(doc, template, {
                    namespace: page.namespace,
                    row,
                    nowMs: options.nowMs,
                }),
            );
        }
        body.appendChild(group);
    }

    const activities = linkableActivities(facts);
    if (activityLinks.length === 0) {
        // The teaching line. Somebody with only workflow templates configured has
        // no way to discover that the same field understands activity tokens, and
        // this is the page where it matters.
        body.appendChild(note(doc, 'Add {activityType} to a link template for per-activity links.'));
    } else if (activities.length === 0) {
        body.appendChild(note(doc, 'No activities in the history read so far.'));
    } else {
        for (const activity of activities.slice(0, CARD_ACTIVITY_LIMIT)) {
            const group = doc.createElement('div');
            group.className = GROUP_CLASS;
            group.appendChild(label(doc, activityLabel(activity, options.nowMs)));
            for (const template of activityLinks) {
                group.appendChild(
                    anchorFor(doc, template, {
                        namespace: page.namespace,
                        row,
                        nowMs: options.nowMs,
                        activity: activityForLink(activity),
                    }),
                );
            }
            body.appendChild(group);
        }
        if (activities.length > CARD_ACTIVITY_LIMIT) {
            body.appendChild(note(doc, `+${activities.length - CARD_ACTIVITY_LIMIT} older activities not listed.`));
        }
    }

    // The scope of everything above, stated. The UI pages history lazily, so "the
    // events loaded so far" is genuinely not the whole workflow, and a card that
    // implied otherwise would be the wrong kind of confident.
    body.appendChild(
        note(doc, `From the ${facts.eventsSeen} history events this page has loaded, plus its own description.`),
    );
}

// One activity's line: the type, how stuck it is, and how old it is. NO FAILURE
// MESSAGE — the note at the top of src/rowInfo.ts is the rule, and it applies
// here for the same reason: a failure message is application data.
function activityLabel(activity: DetailActivity, nowMs: number): string {
    const parts = [activity.activityType || activity.activityId || `event ${activity.scheduledEventId}`];
    if (activity.attempt !== null && activity.attempt > 1) parts.push(`↻ ${activity.attempt}`);
    if (activity.pending) parts.push('pending');
    else if (activity.outcome !== 'open') parts.push(activity.outcome);
    if (activity.scheduledAtMs !== null) parts.push(formatAge(activity.scheduledAtMs, nowMs));
    return parts.join(' · ');
}

function anchorFor(
    doc: Document,
    template: DeepLinkTemplate,
    context: Parameters<typeof expandTemplate>[1],
): HTMLAnchorElement {
    const { url, href, unknownTokens } = expandTemplate(template.urlTemplate, context);
    const anchor = doc.createElement('a');
    // The same class the table's links use, so the two cannot end up styled
    // differently, and the same three attributes for the same reasons — see
    // syncDeepLinks() in render.ts.
    anchor.className = LINK_CLASS;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.referrerPolicy = 'no-referrer';
    anchor.textContent = template.label;
    if (href !== null) anchor.setAttribute('href', href);
    anchor.classList.toggle(LINK_BLOCKED_CLASS, href === null);

    const notes: string[] = [];
    if (href === null) notes.push('Not opened: a link must be an absolute http:// or https:// URL.');
    if (unknownTokens.length > 0) {
        // On this page the likeliest cause is an activity field Temporal has not
        // filled — a pending activity has no attempt count in the history — so the
        // title says which token, not just that something was missing.
        notes.push(`Unknown tokens: ${unknownTokens.join(' ')}`);
    }
    anchor.title = notes.length > 0 ? `${url}\n\n${notes.join('\n')}` : url;
    return anchor;
}

function label(doc: Document, text: string): HTMLElement {
    const node = doc.createElement('span');
    node.className = LABEL_CLASS;
    // textContent, never innerHTML: an activity type is a string from a response,
    // and this card is the wrong place to find out that somebody's activity is
    // named after a script tag.
    node.textContent = text;
    return node;
}

function note(doc: Document, text: string): HTMLElement {
    const node = doc.createElement('div');
    node.className = NOTE_CLASS;
    node.textContent = text;
    return node;
}
