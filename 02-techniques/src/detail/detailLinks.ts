// ISOLATED world: the deep links on a single workflow's own page.
//
// Two sites, both INSIDE the page's own layout:
//
//   • the workflow-scoped links, in a bar beside the page's own tabs;
//   • the activity-scoped links, in each activity's own panel, on the row the UI
//     has already labelled "Activity Id".
//
// THREE INVARIANTS.
//
//  1. BOTH SITES ARE ANCHORED TO MEANING, NOT POSITION — rule 1 at the top of
//     render.ts. The activity anchor is the UI's own label, the words "Activity Id":
//     a label is what the UI calls a field, so it survives a restyle in a way a
//     generated class name does not. The floating card this used to draw instead, and
//     what it cost, are in docs/design-notes.md.
//  2. A BAR THAT CANNOT FIND ITS ANCHOR IS PARKED WHERE IT CAN BE SEEN.
//     LINK_BAR_ADRIFT_CLASS, counted by the popup, with every pass looking for the
//     real anchor again and moving the bar the moment it appears. The failure this
//     exists for is not a missing node — a stale selector leaves the bar attached to
//     <body> at the top-left, invisible behind the app's chrome, which reads as "the
//     feature only appears after you toggle it". A single-page app renders its header
//     after its first paint, so adrift is the normal state for the first frame and a
//     bug only if it persists.
//  3. IT FETCHES NOTHING. Everything here comes from responses the page fetched for
//     itself, folded in the MAIN world by detailWatch.ts. No request, no cache, no
//     pacing, and no ledger check — a ledger entry is authority to spend the page's
//     bearer, and this feature never spends it. src/rowInfo/rowInfo.ts is the file to
//     read for the other case. It shows on screen: on a tab already open on a workflow
//     when the extension loaded, the bar says it has observed nothing and asks for a
//     reload rather than fetching the history itself.

import { safeParse } from 'valibot';

import {
    acceptFactsFor,
    activityByPanelId,
    activityForLink,
    detailFactsMessageSchema,
    detailRefFromPath,
    mergeFacts,
    NO_FACTS,
    rowFromFacts,
    type ActivityMatch,
    type DetailActivity,
    type DetailFacts,
    type DetailRef,
} from './detail';
import { templatesInScope, type DeepLinkTemplate } from '../links/deepLink';
import { ACTIVITY_LINKS_CLASS, LINK_BAR_CLASS } from '../decoration';
import { syncLinkAnchors, type LinkPlacement } from '../links/linkRender';
import { formatAge } from '../rowInfo/rowInfo';
import type { WorkflowRow } from '../types';

// The bar is parked here when the page's own layout could not be found — see the
// note above. A modifier on the same node rather than a different node, so the
// transition is one class write and not a rebuild.
const LINK_BAR_ADRIFT_CLASS = 'tuis-linkbar-adrift';
const NOTE_CLASS = 'tuis-linkbar-note';

// How many activity panels get links in one pass. The UI opens panels one or two at
// a time, so this is not a limit anybody meets; it is a bound on what a hostile or
// broken page can make this loop do, in the same spirit as MAX_ACTIVITIES.
export const MAX_ACTIVITY_PANELS = 24;

// An activityId is caller-chosen, so its shape is not ours to prescribe — but the
// text of a DOM node is not necessarily an id at all, and a resolver that is handed
// a paragraph should stop before it searches 500 activities for it.
const MAX_PANEL_ID_LENGTH = 128;

// ── What we know, and where it came from ─────────────────────────────────────

// The run these facts are about, and the facts. Replaced wholesale when the page
// navigates to a different run: a single-page app keeps this module loaded across
// navigations, and merging two workflows' activities would be worse than showing
// none.
let observed: { ref: DetailRef; facts: DetailFacts } | null = null;

// What the last pass managed to do, for the popup. A feature whose effect cannot be
// seen from outside the page is hard to review, and "2 activity panels linked" is
// the shortest possible statement that this is working — while `adrift` is the
// shortest possible statement of the one failure that otherwise looks like nothing
// at all.
let lastPass = { panelsLinked: 0, adrift: false };

export function receiveDetailFacts(data: unknown, pathname: string): boolean {
    const message = safeParse(detailFactsMessageSchema, data);
    if (!message.success) return false;
    // The PARSED facts, never event.data: validated to the leaves and narrowed to the
    // declared fields, so what mergeFacts() folds is the shape it says it folds.
    const { namespace, workflowId, runId, facts } = message.output;
    const page = detailRefFromPath(pathname);
    // Not on a workflow's page (any more). The answer to a request made before the
    // user navigated away arrives after they have, every time.
    if (!page) return false;
    if (!acceptFactsFor(page, { namespace, workflowId, runId })) return false;
    const base = observed && sameRun(observed.ref, page) ? observed.facts : NO_FACTS;
    observed = { ref: page, facts: mergeFacts(base, facts) };
    return true;
}

// Registers the message listener. Split from receiveDetailFacts so the merge rules
// are testable without a window — the same split as installRowInfo().
export function installDetailLinks(onFacts: () => void): void {
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
// NOT called when the master switch goes off: removeAllDecoration() takes the links
// off the page, and keeping the facts means switching back on redraws them
// immediately instead of showing "nothing observed yet" until the page happens to
// fetch its history again — which, for a closed workflow, may be never.
export function clearDetailFacts(): void {
    observed = null;
    lastPass = { panelsLinked: 0, adrift: false };
}

export function detailLinkStats(): {
    onDetailPage: boolean;
    activitiesKnown: number;
    activityPanelsLinked: number;
    linksAdrift: boolean;
} {
    return {
        onDetailPage: detailRefFromPath(location.pathname) !== null,
        activitiesKnown: observed ? observed.facts.activities.length : 0,
        activityPanelsLinked: lastPass.panelsLinked,
        linksAdrift: lastPass.adrift,
    };
}

function sameRun(a: DetailRef, b: DetailRef): boolean {
    return a.namespace === b.namespace && a.workflowId === b.workflowId && a.runId === b.runId;
}

// ── Drawing it ───────────────────────────────────────────────────────────────

export interface DetailLinksOptions {
    // The master switch AND the links switch, resolved by the caller. These links
    // exist to open link templates, so they have no setting of their own — one more
    // toggle whose only state worth having is "off" is one more thing to explain in
    // the popup.
    enabled: boolean;
    links: DeepLinkTemplate[];
    // Passed in rather than read from location/Date so that every case below is
    // reachable from a jsdom test without navigating anything.
    pathname: string;
    nowMs: number;
    root?: HTMLElement;
}

// Returns true when anything of ours is on the page after this pass.
export function syncDetailLinks(options: DetailLinksOptions): boolean {
    const root = options.root ?? document.body;
    if (!root) return false;
    const page = detailRefFromPath(options.pathname);

    // Facts about a run we are no longer looking at are dropped here rather than
    // on navigation: there is no navigation event to hook in a single-page app
    // that does not also fire for things that are not navigations.
    if (observed && (!page || !sameRun(observed.ref, page))) observed = null;

    if (!options.enabled || !page || options.links.length === 0) {
        removeDetailLinks(root);
        return false;
    }

    const facts = observed?.facts ?? NO_FACTS;
    // No start time yet means no observation has landed, or only a middle page of
    // history has — see rowFromFacts() for why a link is not built from a workflow
    // whose own start time is unknown. The bar still appears, to say so.
    const row = rowFromFacts(page, facts);

    const bar = syncLinkBar(root, page, facts, row, options);
    const panelsLinked = syncActivityPanels(root, page, facts, row, options);
    lastPass = { panelsLinked, adrift: bar?.classList.contains(LINK_BAR_ADRIFT_CLASS) ?? false };
    return bar !== null || panelsLinked > 0;
}

export function removeDetailLinks(root: ParentNode = document): void {
    for (const node of Array.from(root.querySelectorAll(`.${LINK_BAR_CLASS}, .${ACTIVITY_LINKS_CLASS}`))) {
        node.remove();
    }
    lastPass = { panelsLinked: 0, adrift: false };
}

// ── The workflow-scoped bar ──────────────────────────────────────────────────

function syncLinkBar(
    root: HTMLElement,
    page: DetailRef,
    facts: DetailFacts,
    row: WorkflowRow | null,
    options: DetailLinksOptions,
): HTMLElement | null {
    const templates = templatesInScope(options.links, 'workflow');
    // With nothing observed there is nothing to link, and the bar's job becomes
    // saying why — which is the one thing about this design a reader has to be told,
    // because "no links appeared" and "this extension does not fetch" look identical.
    const noteText = row === null ? waitingNote() : null;
    const existing = root.querySelector<HTMLElement>(`.${LINK_BAR_CLASS}`);

    if (templates.length === 0 && noteText === null) {
        existing?.remove();
        return null;
    }

    const bar = existing ?? buildBar(root);
    place(bar, findBarPlacement(root, bar), root);

    syncLinkAnchors(
        bar,
        row === null
            ? []
            : templates.map((template) => ({
                  template,
                  context: { namespace: page.namespace, row, nowMs: options.nowMs },
              })),
    );
    syncNote(bar, noteText);

    // The scope of everything in it, on the bar itself rather than in a line of its
    // own: the UI pages history lazily, so "the events loaded so far" is genuinely
    // not the whole workflow, and a bar that implied otherwise would be the wrong
    // kind of confident.
    const title = provenance(facts);
    if (bar.title !== title) bar.title = title;
    return bar;
}

function waitingNote(): string {
    return observed
        ? 'Reading this workflow’s own history…'
        : 'Nothing observed on this page yet — reload it and the links appear. This extension does not fetch the history itself.';
}

function provenance(facts: DetailFacts): string {
    // "at least", because eventsSeen is a floor rather than a total — see the field's
    // own note in detail.ts. A disclosure of scope that over-states the scope is
    // worse than one that reads as approximate.
    return `Deep links from this extension.\nBuilt from at least ${facts.eventsSeen} history events this page has loaded, plus its own description. Nothing was fetched to draw them.`;
}

function buildBar(root: HTMLElement): HTMLElement {
    const bar = root.ownerDocument.createElement('div');
    bar.className = LINK_BAR_CLASS;
    return bar;
}

function syncNote(bar: HTMLElement, text: string | null): void {
    const existing = bar.querySelector<HTMLElement>(`:scope > .${NOTE_CLASS}`);
    if (text === null) {
        existing?.remove();
        return;
    }
    const note = existing ?? bar.ownerDocument.createElement('span');
    if (!existing) {
        note.className = NOTE_CLASS;
        bar.appendChild(note);
    }
    // textContent, never innerHTML — the rule for every string this extension puts
    // on the page, even the ones it wrote itself, because the next edit to this
    // function may not be writing a constant.
    if (note.textContent !== text) note.textContent = text;
}

// ── Where the bar goes ──────────────────────────────────────────────────────

// A node to insert before, in a parent. `before: null` appends.
interface BarPlacement {
    parent: HTMLElement;
    before: Node | null;
}

// The links the page's own tab bar is made of. Anchored to MEANING: these are the
// routes a workflow page has, so a tab bar is "the thing containing a link to this
// workflow's history". Class names and DOM shape are free to change.
//
// Deliberately NOT `nav:has(a[href*="/history"])`: `:has()` is a 2023 selector and
// jsdom's engine throws on the ones it does not implement, which inside a render
// pass would take the whole pass down. Reading the anchors and walking up with
// closest() asks the same question with selectors that have worked for a decade.
const TAB_LINK_SELECTOR =
    'a[href*="/history"], a[href*="/timeline"], a[href*="/relationships"], a[href*="/workers"], a[href*="/call-stack"]';
const TAB_BAR_SELECTOR = 'nav, ul, [class*="tab"], [role="tablist"]';

function findBarPlacement(root: HTMLElement, bar: HTMLElement): BarPlacement | null {
    // Scoped to <main> so that the site-wide navigation — which also contains links
    // and lists — cannot be mistaken for this workflow's tabs. The internal
    // extension additionally checks the candidate's on-screen position, which is not
    // available here: jsdom reports every rectangle as zero, so a geometric guard
    // would make this untestable in exchange for a check that only helps against a
    // page shape nobody has seen.
    const main = root.querySelector('main') ?? root;

    for (const tab of Array.from(main.querySelectorAll<HTMLAnchorElement>(TAB_LINK_SELECTOR))) {
        // Never anchor to ourselves. Our own links point at a log tool, not at a
        // Temporal route, so this cannot match today — it is here because a future
        // template could name one, and a bar that inserts itself before itself
        // forever is a mutation loop, which is the expensive kind of bug.
        if (bar.contains(tab)) continue;
        const tabBar = tab.closest(TAB_BAR_SELECTOR);
        if (tabBar?.parentElement && !bar.contains(tabBar)) {
            return { parent: tabBar.parentElement, before: tabBar };
        }
    }

    // Second choice: straight after the page's own header. Same fallback the
    // internal extension uses, and it holds up when the tabs have not rendered yet.
    const header = main.querySelector('header');
    if (header?.parentElement) {
        return { parent: header.parentElement, before: siblingAfter(header, bar) };
    }
    return null;
}

// The node after `node`, skipping our own bar — so that "is the bar already here?"
// is not answered by comparing the bar against itself. Without this, a bar already
// sitting immediately after the header would be re-inserted on every pass: a
// childList mutation, which wakes the observer, which schedules a pass. Rule 2.
function siblingAfter(node: Node, bar: HTMLElement): Node | null {
    let next = node.nextSibling;
    while (next === bar) next = next.nextSibling;
    return next;
}

function place(bar: HTMLElement, at: BarPlacement | null, root: HTMLElement): void {
    if (at === null) {
        // Adrift: visible, labelled, and re-checked on the next pass. See the note
        // at the top of this file for why the corner is not a resting place.
        if (bar.parentElement !== root) root.appendChild(bar);
        bar.classList.toggle(LINK_BAR_ADRIFT_CLASS, true);
        return;
    }
    if (bar.parentElement !== at.parent || bar.nextSibling !== at.before) {
        at.parent.insertBefore(bar, at.before);
    }
    bar.classList.toggle(LINK_BAR_ADRIFT_CLASS, false);
}

// ── The activity-scoped links ───────────────────────────────────────────────

// The label whose value is an activity id, normalised. Every non-letter is stripped
// before comparing, so "Activity Id", "Activity ID:", `activityId` and
// `activity_id` are one case — the UI renders that field from the proto's own field
// name and different versions have prettified it differently. Matching one exact
// spelling would be a claim about a formatter this extension does not control.
const ACTIVITY_ID_LABEL = 'activityid';

// Where a labelled row keeps its label. Several of these, because the UI has used a
// definition list, a table and a flex layout for this over the versions; what does
// not change is that the label is a LEAF element whose whole text is the field's
// name and whose next sibling holds the value.
//
// `div` is deliberately absent, and it is the one that would break this. A wrapper
// div whose only text is the label matches just as well as the leaf inside it — and
// its `nextElementSibling` is the NEXT FIELD'S wrapper, not the value, so the pass
// would read some other field's text as the activity id and link confidently to the
// wrong activity. The same trap the internal extension avoided by listing leaves.
const LABEL_CANDIDATE_SELECTOR = 'p, span, dt, td, th, label, strong, b';

function syncActivityPanels(
    root: HTMLElement,
    page: DetailRef,
    facts: DetailFacts,
    row: WorkflowRow | null,
    options: DetailLinksOptions,
): number {
    const templates = templatesInScope(options.links, 'activity');
    const wanted = new Set<Element>();

    if (templates.length > 0 && row !== null) {
        for (const label of Array.from(root.querySelectorAll<HTMLElement>(LABEL_CANDIDATE_SELECTOR))) {
            if (wanted.size >= MAX_ACTIVITY_PANELS) break;
            if (normalizeLabel(label.textContent) !== ACTIVITY_ID_LABEL) continue;
            const valueEl = label.nextElementSibling;
            if (!(valueEl instanceof HTMLElement)) continue;

            const panelId = panelIdOf(valueEl);
            if (panelId === null) continue;
            const match = activityByPanelId(facts, panelId);
            // An id we cannot resolve gets NO link, rather than a link built from
            // whatever activity happens to be newest. This is the whole difference
            // between "a link about this activity" and "a link that looks like one".
            if (!match) continue;

            const group = groupIn(valueEl);
            wanted.add(group);
            syncLinkAnchors(group, templates.map(placementFor(page, row, match, options.nowMs)));
            const title = groupTitle(match, facts, options.nowMs);
            if (group.title !== title) group.title = title;
        }
    }

    // Panels that have closed, ids that have changed, and groups left over from a
    // template edit. Removing by "not touched this pass" needs no bookkeeping in the
    // DOM and cannot leave one behind.
    for (const group of Array.from(root.querySelectorAll(`.${ACTIVITY_LINKS_CLASS}`))) {
        if (!wanted.has(group)) group.remove();
    }
    return wanted.size;
}

function placementFor(
    page: DetailRef,
    row: WorkflowRow,
    match: ActivityMatch,
    nowMs: number,
): (template: DeepLinkTemplate) => LinkPlacement {
    const notes = matchNotes(match);
    return (template) => ({
        template,
        context: {
            namespace: page.namespace,
            row,
            nowMs,
            activity: activityForLink(match.activity),
        },
        notes,
    });
}

// How this link found its activity, said on the link. A reader clicking it cannot
// otherwise know that the id they can see resolved to more than one activity, and
// that is exactly the fact that decides whether the search results can be trusted.
function matchNotes(match: ActivityMatch): string[] {
    const notes: string[] = [];
    if (match.by === 'scheduledEventId') {
        notes.push(
            `Matched by scheduled event id: the history read so far carries no activity id for this activity.`,
        );
    }
    if (match.ambiguous) {
        notes.push(
            `More than one activity in this run has this id — the workflow chose it, so it can repeat. This link is about the newest of them (scheduled event ${match.activity.scheduledEventId}).`,
        );
    }
    return notes;
}

function groupIn(valueEl: HTMLElement): HTMLElement {
    const existing = valueEl.querySelector<HTMLElement>(`:scope > .${ACTIVITY_LINKS_CLASS}`);
    if (existing) return existing;
    const group = valueEl.ownerDocument.createElement('span');
    group.className = ACTIVITY_LINKS_CLASS;
    // Appended INSIDE the UI's own value cell, and nothing of the UI's is moved,
    // re-parented or restyled. Rule 3: the framework owns this subtree and will
    // rebuild it whenever it likes; we add one node and re-add it afterwards.
    valueEl.appendChild(group);
    return group;
}

// One activity's line, as a tooltip on its link group: the type, how stuck it is,
// how old it is, and where the facts came from. NO FAILURE MESSAGE — the note at
// the top of src/rowInfo/rowInfo.ts is the rule, and it applies here for the same reason: a
// failure message is application data.
function groupTitle(match: ActivityMatch, facts: DetailFacts, nowMs: number): string {
    return `${activityLabel(match.activity, nowMs)}\n${provenance(facts)}`;
}

function activityLabel(activity: DetailActivity, nowMs: number): string {
    const parts = [activity.activityType || activity.activityId || `event ${activity.scheduledEventId}`];
    if (activity.attempt !== null && activity.attempt > 1) parts.push(`↻ ${activity.attempt}`);
    if (activity.pending) parts.push('pending');
    else if (activity.outcome !== 'open') parts.push(activity.outcome);
    if (activity.scheduledAtMs !== null) parts.push(`scheduled ${formatAge(activity.scheduledAtMs, nowMs)} ago`);
    return parts.join(' · ');
}

function normalizeLabel(text: string | null): string {
    return (text ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

// The id this panel is showing, EXCLUDING anything this extension put there.
//
// The obvious `valueEl.textContent` is a self-feeding loop waiting to happen: the
// link group is a child of the value cell, so once it is added the cell's text is
// the id plus our own labels, the next pass reads a different id, fails to resolve
// it, removes the group, reads the original id again, and adds it back — a rebuild
// per animation frame, forever. Rule 2 is about writes; this is the same rule
// applied to reads.
function panelIdOf(valueEl: HTMLElement): string | null {
    let text = '';
    for (const node of Array.from(valueEl.childNodes)) {
        if (node instanceof HTMLElement && node.classList.contains(ACTIVITY_LINKS_CLASS)) continue;
        text += node.textContent ?? '';
    }
    const id = text.trim();
    // Bounded, and empty is not an id. Not shape-checked beyond that: an activityId
    // is whatever the workflow author passed, and the real test of whether this
    // string identifies an activity is whether activityByPanelId() can find one.
    if (!id || id.length > MAX_PANEL_ID_LENGTH) return null;
    return id;
}
