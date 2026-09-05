// THE CLASS NAMES MORE THAN ONE FILE NEEDS, and the shape of one render pass.
// Nothing here touches the DOM; it is the vocabulary the modules that do all share.
//
// RESPONSIBILITY: hold the ROOT class of everything this extension draws — which is
// what the master switch has to sweep — plus any class two files both name.
//
// Not every class in the extension, and the difference is deliberate. A node that
// only ever exists inside one of these roots is named locally by the file that draws
// it — the payload panel's own sections in payloads/tooltip.ts, the note inside the
// link bar in detail/detailLinks.ts — because removing the root takes it with it. A
// modifier written onto a root is local for the same reason (LINK_BAR_ADRIFT_CLASS,
// in detailLinks.ts). The test for a new class: it belongs here unless removing
// something named here already takes it off the page AND exactly one file ever writes
// the string.
//
// REMOVABLE_ROOT_CLASSES below is the load-bearing half, and its own comment states
// the contract. What no list can promise is that it names every root — including the
// three nodes that are not in the table at all: the payload panel, which
// payloads/tooltip.ts owns, and the link sites on a single workflow's own page, which
// detail/detailLinks.ts owns. Both files find their own nodes by these same names. A
// selector in one file and the node it is meant to find in another is how the two
// drift apart, so each string exists once, here.
// See docs/design-notes.md#why-each-of-the-four-files-exists.

import type { DeepLinkTemplate } from './links/deepLink';
import type { RowInfo } from './rowInfo/rowInfoClient';
import type { SegmentKind, WorkflowRow } from './types';

// ── What we put on the page ──────────────────────────────────────────────────

export const PREFIX_CLASS = 'tuis-prefix';
export const SEGMENT_CLASS = 'tuis-seg';
export const LINK_CLASS = 'tuis-link';
// A link whose template expanded to something we will not open. It still
// renders: a button that vanishes reads as a broken extension, and the title
// then has nowhere to explain itself.
export const LINK_BLOCKED_CLASS = 'tuis-link-blocked';
// The "Last event" column: one <th> in the header row, one <td> in every body row,
// both placed immediately after the workflow-id column. Both are needed for every
// row, always — a table where some rows have the extra cell and some do not is a
// table with a visibly broken layout, which is why the column is applied to the
// whole <tbody> at once rather than inside decorateRow().
export const LAST_EVENT_CLASS = 'tuis-last-event';
export const COLUMN_HEAD_CLASS = 'tuis-col-head';
// Inside that <th>: the word, and the button that re-asks. The label is a node of
// its own rather than a text child so that reading the header's own name does not
// mean stripping the button's glyph out of th.textContent — which the specs, and
// anyone debugging the column order, do have to do.
export const COLUMN_LABEL_CLASS = 'tuis-col-label';
export const COLUMN_REFRESH_CLASS = 'tuis-col-refresh';
// The retrying-activity badge, in the workflow-id cell beside the id.
export const RETRY_CLASS = 'tuis-retry';
// The two per-row affordances that open a payload panel — one for the input, one
// for the result. payloads/payloadButton.ts RENDERS them and knows nothing else
// about them — the hovering, the fetching and the panel itself are
// payloads/tooltip.ts, which finds each button by its own class. The two buttons
// ask two independent questions (each costs its own request, and one's answer
// never blocks the other's), but there is one panel between them: hovering the
// other button replaces what the panel is showing rather than opening a second
// one beside it. Two classes rather than one class plus a data-attribute so
// REMOVABLE_ROOT_CLASSES below stays a flat list of selectors, like every other
// root here.
export const PAYLOAD_INPUT_CLASS = 'tuis-payload-input';
export const PAYLOAD_OUTPUT_CLASS = 'tuis-payload-output';
// The floating payload panel. Exactly one exists on the page at a time —
// payloads/tooltip.ts builds it lazily on the first hover of either button and
// reuses it for the other kind from then on; render.ts only ever removes it (see
// removeAllDecoration). `data-tuis-kind` on the element (not the class) records
// which of the two questions it is currently answering.
export const PANEL_CLASS = 'tuis-panel';
// The two places detail/detailLinks.ts writes on a single workflow's own page: a bar
// of workflow-scoped links beside the page's own tabs, and a group of
// activity-scoped links inside each activity's own panel.
export const LINK_BAR_CLASS = 'tuis-linkbar';
export const ACTIVITY_LINKS_CLASS = 'tuis-act-links';
export const OFF_CLASS = 'tuis-off';

// THE MASTER SWITCH'S CONTRACT, as a value rather than a paragraph.
//
// Every root above appears here, and removeAllDecoration() in render.ts builds its
// selector from this list — so a root cannot be swept by the code and missing from
// the documentation, or the reverse. What the list still cannot know is that a NEW
// root exists at all; that is what the positive control in the cleanup spec is for,
// which is why the spec restates the list by hand instead of importing this one.
//
// Only ROOTS belong here. A node that only ever exists inside one of these comes off
// with its parent, and adding it would suggest it is separately at risk.
export const REMOVABLE_ROOT_CLASSES: readonly string[] = [
    PREFIX_CLASS,
    LINK_CLASS,
    PAYLOAD_INPUT_CLASS,
    PAYLOAD_OUTPUT_CLASS,
    RETRY_CLASS,
    // The panel is here even though it lives on <body> and not in a row, and on this
    // rung it is the one that matters most: it is the only node this extension draws
    // that has DECODED PAYLOAD TEXT in it. A panel left open after the master switch
    // would be personal data still on screen from an extension the user has just
    // turned off. payloads/tooltip.ts rebuilds it on demand.
    PANEL_CLASS,
    // The workflow page's two link sites, for the same reason and one weaker: "off"
    // has to mean off, and they are the most visible thing this extension draws, so
    // leaving one behind is the clearest possible way to look like the master switch
    // does nothing — which is exactly what makes a security reviewer stop believing
    // the rest of the claims. detail/detailLinks.ts rebuilds them on demand.
    LINK_BAR_CLASS,
    ACTIVITY_LINKS_CLASS,
    // Both halves of the added column. Leaving the <th> behind would shift every
    // header label one cell to the left of its data.
    LAST_EVENT_CLASS,
    COLUMN_HEAD_CLASS,
];

// Must match `.tuis-seg { width }` in public/content.css. The link's indent is
// derived from it, so the two drifting apart lays the workflow id on top of the
// connector strokes.
export const SEGMENT_WIDTH_PX = 18;

// ── What a render pass is given ──────────────────────────────────────────────

export interface Placement {
    sequence: number;
    depth: number;
    segments: SegmentKind[];
    row: WorkflowRow;
}

export interface RenderOptions {
    treeEnabled: boolean;
    linksEnabled: boolean;
    // The `{ }` button. Costs nothing to draw and nothing to leave alone — the
    // requests happen on hover, in payloads/tooltip.ts, and not in a render pass.
    payloadsEnabled: boolean;
    // The two features fed by rowInfo/rowInfoClient.ts. Separate switches because
    // they cost one API request per running row EACH — see rowInfo/rowInfoServe.ts.
    lastEventEnabled: boolean;
    retryEnabled: boolean;
    links: DeepLinkTemplate[];
    namespace: string;
    // Injected rather than read from Date.now() so a test can pin the clock.
    nowMs: number;
    // What came back for a run, if anything has yet. Undefined means "not asked or
    // not answered", which is a third state and must not render as "nothing found".
    info: RowInfoLookup;
    // Pressed the refresh control in the column header. Wired in content.ts, which
    // is the only place that knows the namespace and which rows are on screen.
    //
    // Not optional: a header button whose handler was left off would look exactly
    // like a working one, so the type is what makes the wiring impossible to forget.
    onRefresh: () => void;
}

export type RowInfoLookup = (workflowId: string, runId: string) => RowInfo | undefined;

export interface RenderStats {
    rowsSeen: number;
    rowsMatched: number;
    rowsIndented: number;
    reordered: boolean;
    // How many rows are currently showing a retry badge. Surfaced in the popup:
    // the number is the answer to "is anything stuck right now?", and a feature
    // whose effect cannot be seen from outside the page is hard to review.
    retryBadges: number;
}

export type PlacementLookup = (workflowId: string, runId: string | null) => Placement | undefined;
