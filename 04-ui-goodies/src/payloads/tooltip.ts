// The hover panel that shows a workflow's input or its result.
//
// RESPONSIBILITY: two buttons on the same row — Input and Output — and ONE
// floating element between them. It owns the panel's markup, its position, the
// pointer and keyboard gestures that open and close it, and the rendering of an
// answer. It asks src/payloads/payloadClient.ts for the answer and never
// fetches anything itself — the fetch is payloadServe.ts's, in the page's
// world, for the CORS reason in README.md.
//
// TWO BUTTONS, ONE PANEL. Stage 03 drew one `{ }` button that opened a single
// panel holding both an input section and a result section, fetching both on
// every hover (skipping only the result for a running workflow). That means
// every hover of a closed workflow cost two requests even when the reader only
// wanted one of the two answers. Splitting it into an Input button and an
// Output button makes each one its own, independent question: hovering "In"
// costs at most one request and never touches the result at all; hovering
// "Out" costs at most one and never touches the input.
//
// Independent QUESTIONS, not independent PANELS. An earlier version of this
// file also gave each kind its own floating element, on the theory that "the
// two can be open at once — a reader comparing input to result hovers one,
// then the other, and the first does not close." In practice the two buttons
// sit a few pixels apart on the same row, so two panels of the panel's own
// width anchor almost on top of each other and the second one is opened
// straight over the first. Hovering Output now REPLACES whatever the panel is
// showing rather than adding a second overlay — the same one element answers
// whichever of the two questions was asked most recently, which is also how
// the private extension this stage is modelled on behaves.
//
// ISOLATED world. That matters for more than imports: the panel lives on
// document.body, which is the page's DOM, not one of our own. See rule 5.
//
// FIVE RULES here, all about the element and the gesture; the four about which
// ANSWER may be believed are the client's, numbered as invariants so a citation
// says which file it means. Each of these five was broken at least once by the
// code written to uphold it — the incidents are in docs/design-notes.md under
// "The payload panel", and the numbering is cited from tests, so renumber
// nothing.
//
//  1. NOTHING IS FETCHED ON RENDER. A table of 100 rows must cost zero requests
//     until a pointer lands on one. The only entry points are pointerover,
//     focusin and click — there is no code path from a render pass to a request.
//  2. HOVER INTENT, NOT A DELAY. The timer before asking remembers WHICH button
//     it is for; a different button — even one of the SAME kind, on a different
//     row — cancels and re-arms it. Without that field the timer fires for the
//     row the pointer has left, which anchors the panel to one row and fills it
//     with another row's payload.
//  3. IT DOES NOT CLOSE UNDER THE POINTER. A panel that vanishes when the pointer
//     leaves the button cannot be read, scrolled, or selected out of — and
//     selecting a value out of it is most of why anyone opens it. So: a grace
//     period, cancelled by the pointer being anywhere over the panel, suspended
//     entirely while a mouse button is held down inside it, and a scroll of the
//     panel's own scrollbar is not a scroll of the page.
//  4. A LATE ANSWER DOES NOT PAINT INTO THE PANEL THAT REPLACED IT. Two hovers —
//     of the same kind on two different rows, or of two different kinds on the
//     same row — are two requests in flight and they can answer in either
//     order. Every fill is stamped with the generation of the hover that asked
//     for it, and `generation` moves whenever the panel stops belonging to that
//     hover — openNow() takes the next one, close() moves past it — so opening
//     the next hover (of either kind) and closing the panel both make an answer
//     already in flight undeliverable. There is one counter, not one per kind,
//     because there is one panel for it to paint into.
//     The counter alone only catches a hover or a close of OURS superseding
//     this one; it says nothing when neither happens and the row itself
//     changes anyway — Temporal's own render pass can detach a button's <tr>,
//     or RECYCLE it to a different workflow, while this generation is still
//     current. fill() re-checks the row itself for exactly that reason; see
//     matchesCurrentRow().
//  5. SWITCHING IT OFF TAKES THE NODE, THE REFERENCE AND THE TEXT. The buttons
//     are in the table, so a render pass removes them; the panel is on <body>,
//     so no render pass touches it. Hiding it is not enough — `hidden` stops
//     decoded text being SHOWN and does nothing about it being THERE, in a DOM
//     the page can read.

import { installPayloadClient, requestPayload, resetPayloadClient, type Question } from './payloadClient';
import { type CodecConfig, type PayloadKind } from './payloadMessages';
import { renderJsonPayload } from './jsonViewer';
import { PANEL_CLASS, PAYLOAD_INPUT_CLASS, PAYLOAD_OUTPUT_CLASS } from '../decoration';

// The subset of a row this panel needs. Deliberately not the render Placement:
// the panel does not care about tree shape, and a narrower dependency is a
// narrower thing to keep working.
export interface TooltipRow {
    workflowId: string;
    runId: string;
    workflowType: string;
    status: string;
}

export interface TooltipDeps {
    // From a table row to what we know about it, or null when we know nothing.
    // Resolved through the row's href on every hover rather than from an
    // attribute we wrote earlier — the UI recycles <tr> elements, so a cached id
    // can belong to the workflow that used to be in this row (see render.ts).
    findRow: (tr: HTMLTableRowElement) => TooltipRow | null;
    namespace: () => string;
    codec: () => CodecConfig;
}

const HOVER_DELAY_MS = 160;
const CLOSE_DELAY_MS = 220;
const COPY_FEEDBACK_MS = 1500;

// A workflow that has not closed has no result event to fetch, and asking for
// one is a request that can only answer "nothing yet". Only the Output button
// checks this — the Input button has no equivalent gap, an input event exists
// from the moment the workflow starts.
const RUNNING_STATUS = 'Running';

// WHICH button a pending hover timer, or the panel itself, currently belongs
// to. Carrying `kind` alongside the element is what lets one set of timers
// serve two buttons without a second copy of everything — see rule 2.
interface ButtonRef {
    kind: PayloadKind;
    button: HTMLElement;
}

// The one panel's elements and its own timers/flags. There is exactly one of
// these, for both kinds — see the top-of-file note on why this stopped being
// per-kind.
interface PanelState {
    panel: HTMLDivElement | null;
    titleLine: HTMLDivElement | null;
    heading: HTMLElement | null;
    body: HTMLElement | null;
    copyButton: HTMLButtonElement | null;
    copyFeedbackTimer: number | null;
    // Which kind the panel is currently showing, or null before anything has
    // ever been hovered. Read by tests through data-tuis-kind on the element
    // itself, and by matchesCurrentRow() as the cheap first check before the
    // more expensive one against `deps.findRow()`: a button only ever asks
    // the one kind it was built for (see buttonFrom()), so the panel having
    // moved on to the OTHER kind already answers the question.
    activeKind: PayloadKind | null;
    // Which hover the panel currently belongs to, and the gate every fill
    // checks. Rule 4.
    generation: number;
    hoverTimer: number | null;
    hoverTarget: ButtonRef | null;
    closeTimer: number | null;
    pointerHeldInPanel: boolean;
    // The button openNow() was last called for. Not necessarily the one the
    // pointer is over now — a click moves focus onto the Copy button inside
    // the panel (see the click handler below), and close() sends focus back
    // here if Escape, a resize or a scroll closes the panel while focus is
    // still in it.
    triggerButton: HTMLElement | null;
}

function freshPanelState(): PanelState {
    return {
        panel: null,
        titleLine: null,
        heading: null,
        body: null,
        copyButton: null,
        copyFeedbackTimer: null,
        activeKind: null,
        generation: 0,
        hoverTimer: null,
        hoverTarget: null,
        closeTimer: null,
        pointerHeldInPanel: false,
        triggerButton: null,
    };
}

let deps: TooltipDeps | null = null;
const state: PanelState = freshPanelState();

// Called when the codec settings change, and when the payload panel is
// switched off.
//
// FOUR THINGS CAN BE HOLDING AN ANSWER FROM BEFORE THE CHANGE, and this
// function exists because emptying only some of them is the reading that
// shipped a hole twice. resetPayloadClient() empties three — the cache, the
// right of an answer already in flight to be joined instead of asked for
// again, and the epoch that stops that same in-flight answer from being
// written into the cache once it resolves (see the comment on that
// function). The fourth is the panel itself, and both of ITS halves are
// here:
//
//   close(), so a late answer allowed to paint cannot, because fill() gates
//   on `generation` and close() moves it past every hover in flight; and
//   erasePanelText(), because close() sets `hidden`, which stops the text
//   being SHOWN and does nothing about it being THERE. The panel is on
//   document.body, in the DOM the page shares with us — an ISOLATED world
//   does not get its own — so decoded payload text in a hidden node is text
//   any script in the page can read out of it. Hiding personal data is not
//   erasing it.
//
// Both halves, and why each one was missed, are in docs/design-notes.md.
export function resetPayloadState(): void {
    close();
    erasePanelText();
    resetPayloadClient();
}

// Every node the panel put words into, emptied. Null-safe on purpose: the
// master switch nulls these references before it resets, and a reset with no
// panel built yet is the ordinary first case.
function erasePanelText(): void {
    if (state.titleLine) state.titleLine.textContent = '';
    if (state.heading) state.heading.textContent = '';
    // Assigning textContent clears element children as well as text — the
    // JSON view comes off with the same call that clears plain text.
    if (state.body) state.body.textContent = '';
}

// Rule 5: the panel is switched off, so it goes away — the node, the
// references to it (or panelContains() keeps answering yes for a detached
// element and a click outside stops closing anything), and the decoded text
// behind it.
//
// What this CANNOT do is recall a request already sent. Switching off stops
// the next question; it is not a revocation, and the popup does not claim
// otherwise.
//
// Detach first, then reset: resetPayloadState() does the close() and the
// erasure. The node is gone by then, which is strictly more than erasing its
// text — ensurePanel() rebuilds on the next hover because it checks
// `isConnected`, not just for null.
export function removePayloadTooltip(): void {
    // Two more references this has always had to clear, on top of the panel
    // itself: a pending copy-feedback timeout closes over the (about-to-be-
    // detached) button below, and a pointer held down inside the panel at
    // the moment of removal may never fire the `pointerup` that would
    // otherwise clear it. Either one left set would still be read by a panel
    // this module builds after the switch is turned back on.
    cancel(state.copyFeedbackTimer);
    state.copyFeedbackTimer = null;
    state.pointerHeldInPanel = false;
    state.panel?.remove();
    state.panel = null;
    state.titleLine = null;
    state.heading = null;
    state.body = null;
    state.copyButton = null;
    resetPayloadState();
}

export function installPayloadTooltip(dependencies: TooltipDeps): void {
    deps = dependencies;
    installPayloadClient({ codec: dependencies.codec });

    // Delegated, on the document. Per-element listeners would have to be attached
    // by the render pass and re-attached after every re-render — and the rows are
    // recycled, so they would accumulate on nodes that now show a different
    // workflow.
    //
    // ONE handler decides where the pointer is, and `pointerover` is the event that
    // knows: it fires for every element the pointer enters, and it bubbles, so a
    // delegated listener sees every move as "now over X". Over a button or
    // anywhere in the panel keeps it open; anywhere else starts the grace period.
    document.addEventListener('pointerover', (event) => {
        const hit = buttonFrom(event.target);
        if (hit) {
            scheduleOpen(hit.kind, hit.button);
            return;
        }
        if (panelContains(event.target)) {
            keepOpen();
            return;
        }
        scheduleClose();
    });
    // Rule 3. `pointerout` fires on every move BETWEEN elements, including two
    // elements inside the panel, so closing on it closed the panel under the
    // pointer. What is left here is the one case `pointerover` cannot report: the
    // pointer leaving the document, which enters no element at all and is the only
    // case with a null relatedTarget.
    document.addEventListener('pointerout', (event) => {
        if (event.relatedTarget === null) scheduleClose();
    });
    // Keyboard: each affordance is a real <button>, so it is reachable by Tab.
    document.addEventListener('focusin', (event) => {
        const hit = buttonFrom(event.target);
        if (hit) openNow(hit.kind, hit.button);
    });
    document.addEventListener('click', (event) => {
        const hit = buttonFrom(event.target);
        if (hit) {
            // A click on a row's button must not also count as a click on the row
            // underneath it, which navigates away from the list.
            event.preventDefault();
            event.stopPropagation();
            openNow(hit.kind, hit.button);
            // A click — unlike a hover, and unlike Tab merely landing on the
            // button — is an explicit request to use this control, so it is the
            // one gesture allowed to move focus off the trigger and onto the
            // action inside the panel it opened. See the ARIA note in
            // ensurePanel() for why the panel itself is not a focus target.
            state.copyButton?.focus();
            return;
        }
        // A click inside the panel — on the Copy button, on a selected value —
        // must not close it.
        if (!panelContains(event.target)) close();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') close();
    });
    // A fixed-position panel is pinned to the viewport, so it would slide off its
    // button as soon as the PAGE scrolls. Closing is honest; re-anchoring on every
    // scroll event is not worth the frames.
    //
    // `capture: true` because a scroll event does not bubble — capture is the only
    // way one listener hears every scroller on the page. Which is why the listener
    // has to ask whether the scroller IS the panel: rule 3, and the reason reading
    // a long payload used to dismiss it.
    window.addEventListener(
        'scroll',
        (event) => {
            if (panelContains(event.target)) return;
            close();
        },
        { passive: true, capture: true },
    );
    window.addEventListener('resize', () => close());
    window.addEventListener('pointerup', () => {
        state.pointerHeldInPanel = false;
    });
}

function buttonFrom(target: EventTarget | null): ButtonRef | null {
    if (!(target instanceof Element)) return null;
    const input = target.closest<HTMLElement>(`.${PAYLOAD_INPUT_CLASS}`);
    if (input) return { kind: 'input', button: input };
    const output = target.closest<HTMLElement>(`.${PAYLOAD_OUTPUT_CLASS}`);
    if (output) return { kind: 'outcome', button: output };
    return null;
}

function panelContains(target: EventTarget | null): boolean {
    return target instanceof Node && state.panel !== null && state.panel.contains(target);
}

// ── Opening and closing ─────────────────────────────────────────────────────

function scheduleOpen(kind: PayloadKind, button: HTMLElement): void {
    cancel(state.closeTimer);
    state.closeTimer = null;
    // Already waiting for THIS button: leave the timer alone, so holding the pointer
    // still over one button does not push its own opening further away with every
    // pointerover the browser reports.
    if (state.hoverTimer !== null && state.hoverTarget?.button === button && state.hoverTarget.kind === kind) return;
    // A different button — possibly the other kind, on the SAME row. Rule 2: the
    // pending timer belongs to a button the pointer has left, and letting it stand
    // would fire for the old one, anchor the panel there, and fetch that button's
    // payload while the pointer sits on this one. Cancel and re-arm, which also
    // restarts the delay — moving across five buttons costs nothing and the fifth
    // is the one that opens.
    cancel(state.hoverTimer);
    state.hoverTarget = { kind, button };
    state.hoverTimer = window.setTimeout(() => {
        state.hoverTimer = null;
        state.hoverTarget = null;
        openNow(kind, button);
    }, HOVER_DELAY_MS);
}

// The pointer is somewhere it may stay. Cancels a close in flight without
// scheduling anything: called on every move inside the panel, so it has to be
// cheap and idempotent.
function keepOpen(): void {
    cancel(state.closeTimer);
    state.closeTimer = null;
}

function scheduleClose(): void {
    cancel(state.hoverTimer);
    state.hoverTimer = null;
    state.hoverTarget = null;
    if (state.closeTimer !== null) return;
    state.closeTimer = window.setTimeout(() => {
        state.closeTimer = null;
        // Rule 3: a held pointer means a selection is in progress inside the
        // panel. Re-arm rather than close, so the drag can finish.
        if (state.pointerHeldInPanel) {
            scheduleClose();
            return;
        }
        close();
    }, CLOSE_DELAY_MS);
}

function cancel(timer: number | null): void {
    if (timer !== null) window.clearTimeout(timer);
}

// Moving `generation` is the whole point of this function, not the `hidden`
// flag: it is what makes every answer still in flight undeliverable. openNow()
// moves it too — the difference is that this leaves it on a generation no
// hover owns. See fill().
function close(): void {
    cancel(state.hoverTimer);
    cancel(state.closeTimer);
    state.hoverTimer = null;
    state.hoverTarget = null;
    state.closeTimer = null;
    state.generation++;
    state.activeKind = null;
    // A click is the one gesture that moves focus off the trigger and onto
    // the Copy button inside the panel (see the click handler below).
    // Escape, a resize and a scroll all close the panel from here without
    // moving focus themselves, so without this, focus is left sitting on a
    // button inside a subtree `hidden` just took out of the accessibility
    // tree — reachable by nothing, visible to nobody. Only redirect it if
    // focus is actually still inside the panel: a click OUTSIDE the panel
    // already moved focus to wherever the user clicked, and that choice is
    // not this function's to override.
    if (state.panel && document.activeElement && state.panel.contains(document.activeElement)) {
        if (state.triggerButton?.isConnected) state.triggerButton.focus();
    }
    state.triggerButton = null;
    if (state.panel) state.panel.hidden = true;
}

function openNow(kind: PayloadKind, button: HTMLElement): void {
    cancel(state.hoverTimer);
    cancel(state.closeTimer);
    state.hoverTimer = null;
    state.hoverTarget = null;
    state.closeTimer = null;

    const tr = button.closest('tr');
    const row = tr && deps ? deps.findRow(tr as HTMLTableRowElement) : null;
    if (!row) return;

    const namespace = deps?.namespace() ?? '';

    const mine = ++state.generation;
    state.activeKind = kind;
    state.triggerButton = button;
    const ui = ensurePanel();
    // The body is the SAME node across every hover (ensurePanel() reuses it),
    // and its `resize: both` is native: a manual drag sets `width`/`height`
    // directly on the element, and nothing else ever clears them. Left alone,
    // one drag on either button, on any row, makes every later hover of
    // either kind open at that dragged size for the rest of the page's life.
    // Clearing it here means a drag only ever affects the hover it happened
    // in — the next one starts from the CSS shrink-to-fit default again.
    ui.body.style.removeProperty('width');
    ui.body.style.removeProperty('height');
    // Whatever the Copy button most recently showed — "Copied" or "Failed" —
    // described the payload the panel used to hold, not this one. The
    // button is the same DOM element across every kind and every row (see
    // ensurePanel()), so without this a label from before this hover is
    // still sitting on it when this one opens.
    resetCopyFeedback();
    ui.panel.dataset.tuisKind = kind;
    ui.panel.hidden = false;
    ui.titleLine.textContent = `${row.workflowId} · ${row.workflowType} · ${row.status}`;
    ui.heading.textContent = kind === 'input' ? 'Input' : 'Result';
    ui.body.textContent = 'Loading…';
    // Placed with the loading placeholder already in, THEN placed again once the
    // real answer (or "Still running.") replaces it below — see the second
    // place() call in each branch. A payload can be much larger or much smaller
    // than "Loading…", and a placement computed only here would clamp the panel
    // to a box it no longer occupies once the answer lands, letting a large
    // payload run off the bottom or right edge of the viewport near it.
    place(ui.panel, button);

    // Only the Output button has a "nothing to fetch yet" case — a running
    // workflow has no result event. The Input button always has something to
    // ask for, from the moment the workflow starts.
    if (kind === 'outcome' && row.status === RUNNING_STATUS) {
        ui.body.textContent = 'Still running.';
        place(ui.panel, button);
        return;
    }

    void fill({ namespace, workflowId: row.workflowId, runId: row.runId, kind }, mine, button);
}

// Re-resolves the row an anchor button belongs to and confirms it is still
// the SAME workflow this question was asked about — not just A workflow.
// Rule 4's generation counter catches a NEWER hover or close of OURS; it
// does nothing when neither happens and Temporal's own render pass detaches
// this <tr> or RECYCLES it to a different workflow in between, because
// nothing about that moves `generation`.
function matchesCurrentRow(question: Question, anchor: HTMLElement): boolean {
    if (!anchor.isConnected || state.activeKind !== question.kind) return false;
    const tr = anchor.closest('tr');
    const row = tr && deps ? deps.findRow(tr as HTMLTableRowElement) : null;
    if (!row) return false;
    return (
        deps?.namespace() === question.namespace &&
        row.workflowId === question.workflowId &&
        row.runId === question.runId
    );
}

async function fill(question: Question, mine: number, anchor: HTMLElement): Promise<void> {
    const ui = ensurePanel();

    const result = await requestPayload(question);
    // Rule 4. This answer belongs to a hover that is over: two hovers — of the
    // same kind on a different row, or of the other kind on this one — are two
    // requests in flight and they can answer in either order.
    if (mine !== state.generation) return;

    // Still THIS generation, but is the row it was asked about still the row
    // this button now sits over? A render pass that detached or recycled the
    // <tr> moved neither `generation` nor `mine`, so the check above passed
    // and this is the only thing left to catch it. Close rather than leave
    // "Loading…" showing forever: the question this generation was
    // answering no longer has a row to answer it about, whether or not
    // another one has taken its place.
    if (!matchesCurrentRow(question, anchor)) {
        close();
        return;
    }

    if (result.error) {
        ui.body.textContent = `⚠ ${result.error}`;
        place(ui.panel, anchor);
        return;
    }
    ui.heading.textContent = result.label;
    if (result.decodedBy) ui.heading.appendChild(provenance(result.decodedBy));
    // Lossless, bounded, flat — see jsonViewer.ts. A payload that is not JSON
    // at all (or too large/deep to safely draw) falls back to the same plain
    // text this used to always show, never to a partially-drawn view.
    ui.body.replaceChildren(renderJsonPayload(document, result.text));
    // The second placement: the panel's real size, now that its real content
    // is in it. No `anchor.isConnected` guard needed here — matchesCurrentRow()
    // above already confirmed it.
    place(ui.panel, anchor);
}

// Copies whatever the panel is showing right now — "Loading…", "Still
// running.", an error, or the decoded payload — rather than re-fetching or
// re-deriving anything: a reader clicks Copy for what is already on their
// screen, not for a second opinion of it.
async function copyBodyText(): Promise<void> {
    const body = state.body;
    const copyButton = state.copyButton;
    if (!body || !copyButton) return;
    // Captured before the await, not read off `state` after it: writeText()
    // is asynchronous, and the same button is reused across both kinds and
    // every row (see ensurePanel()) — a reader can copy Input, then hover
    // Output before the promise settles, and by the time it does, `state`
    // no longer describes what this call started with.
    const generation = state.generation;
    const text = body.textContent ?? '';
    let label: string;
    try {
        await navigator.clipboard.writeText(text);
        label = 'Copied';
    } catch {
        // Clipboard access can be refused outside a user gesture or on an
        // insecure origin. The click IS the gesture; a refusal here is the
        // page's permissions, not something to paper over — but it is still
        // told to the reader rather than swallowed silently, the same way the
        // private extension this is modelled on does.
        label = 'Failed';
    }
    // Only apply it if the generation captured above is still current AND
    // this is still the button the panel is showing — the panel can have
    // been rebuilt entirely (master switch off/on) between the click and
    // here, which is a different `copyButton` even at the same generation
    // number.
    if (state.generation === generation && state.copyButton === copyButton) {
        flashCopyButton(copyButton, label);
    }
}

// "Copy" for as long as nothing has happened, "Copied"/"Failed" for a moment
// after a click, then back to "Copy" — so the button says what happened
// without needing a second element beside it.
function flashCopyButton(copyButton: HTMLButtonElement, label: string): void {
    cancel(state.copyFeedbackTimer);
    copyButton.textContent = label;
    state.copyFeedbackTimer = window.setTimeout(() => {
        state.copyFeedbackTimer = null;
        copyButton.textContent = 'Copy';
    }, COPY_FEEDBACK_MS);
}

// Called by openNow() before it shows anything new: a "Copied"/"Failed"
// label — or a timer still counting down to clearing one — describes the
// payload the button was showing before THIS hover, not the one about to be
// drawn.
function resetCopyFeedback(): void {
    cancel(state.copyFeedbackTimer);
    state.copyFeedbackTimer = null;
    if (state.copyButton) state.copyButton.textContent = 'Copy';
}

// The host is named, every time. "Decoded" on its own reads as if the extension
// did it locally — and a payload that was sent to a server deserves to say so on
// screen, not only in a README.
//
// It is a child element rather than more text in the heading because the heading
// is `text-transform: uppercase`: a hostname is the one part of this line a
// reader has to check character by character, and CODEC.EXAMPLE.COM is both
// harder to read and not what the host is called.
export function provenance(host: string): HTMLElement {
    const note = document.createElement('span');
    note.className = `${PANEL_CLASS}-provenance`;
    note.textContent = ` · decoded by ${host}`;
    return note;
}

// ── The element ─────────────────────────────────────────────────────────────

function ensurePanel(): {
    panel: HTMLDivElement;
    titleLine: HTMLDivElement;
    heading: HTMLElement;
    body: HTMLElement;
} {
    // `isConnected` and not just a null check: the master switch removes every
    // node this extension put in the page, the panel included, so a stale
    // reference has to be rebuilt rather than re-shown.
    if (state.panel && state.titleLine && state.heading && state.body && state.panel.isConnected) {
        return { panel: state.panel, titleLine: state.titleLine, heading: state.heading, body: state.body };
    }

    const panelElement = document.createElement('div');
    panelElement.className = PANEL_CLASS;
    panelElement.hidden = true;

    const titleLine = document.createElement('div');
    titleLine.className = `${PANEL_CLASS}-title`;
    // ARIA: a `role="tooltip"` would describe non-interactive content only, and
    // this panel contains a focusable Copy button — an ARIA tooltip is not
    // allowed to. `role="group"` names it correctly instead: a labelled
    // collection of related content and controls, not a description. The name
    // itself is `aria-labelledby` pointing at this title line rather than a
    // separately-maintained `aria-label`, so it stays correct for free every
    // time openNow() rewrites the title text — there is nothing here that
    // both strings could drift out of step with.
    titleLine.id = `${PANEL_CLASS}-title`;
    panelElement.setAttribute('role', 'group');
    panelElement.setAttribute('aria-labelledby', titleLine.id);
    // The body is filled after a round trip, so a screen reader has to be told
    // it changed.
    panelElement.setAttribute('aria-live', 'polite');
    panelElement.appendChild(titleLine);

    const headingRow = document.createElement('div');
    headingRow.className = `${PANEL_CLASS}-heading-row`;
    const heading = document.createElement('div');
    heading.className = `${PANEL_CLASS}-heading`;

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = `${PANEL_CLASS}-copy`;
    copyButton.textContent = 'Copy';
    // No stopPropagation needed: the document click handler above already
    // treats anything inside the panel as "not outside it", the Copy button
    // included.
    copyButton.addEventListener('click', () => void copyBodyText());
    headingRow.append(heading, copyButton);
    panelElement.appendChild(headingRow);

    // A <div>, not a <pre>: the JSON viewer builds its own indentation out of
    // text nodes, so the whitespace-preserving behaviour this used to need
    // from the tag now comes from `.tuis-panel-body { white-space: pre-wrap }` in
    // public/content.css instead — the same rule, moved from an element to a
    // class so it still applies to the plain-text fallback too. Set via
    // textContent (plain text) or replaceChildren (the JSON view) only: this is
    // data authored by whoever started the workflow.
    const body = document.createElement('div');
    body.className = `${PANEL_CLASS}-body`;
    panelElement.appendChild(body);

    panelElement.addEventListener('pointerenter', () => keepOpen());
    panelElement.addEventListener('pointerleave', () => scheduleClose());
    // Rule 3, the drag half of it. The release is listened for on the window
    // (in installPayloadTooltip) because the pointer is routinely released
    // outside the panel it was pressed in, and a pointerup we never see would
    // leave the flag set and the panel open for good.
    panelElement.addEventListener('pointerdown', () => {
        state.pointerHeldInPanel = true;
    });

    document.body.appendChild(panelElement);

    state.panel = panelElement;
    state.titleLine = titleLine;
    state.heading = heading;
    state.body = body;
    state.copyButton = copyButton;
    return { panel: panelElement, titleLine, heading, body };
}

// Anchored under the button, pulled back inside the viewport, flipped above when
// there is no room below. Measured after the panel is visible, because a hidden
// element has no height to measure. Called once with the loading placeholder in
// place and once more with the real answer — see the callers.
function place(element: HTMLDivElement, button: HTMLElement): void {
    const anchor = button.getBoundingClientRect();
    const margin = 8;
    element.style.left = '0px';
    element.style.top = '0px';
    const box = element.getBoundingClientRect();
    const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - box.width - margin));
    const below = anchor.bottom + 6;
    const top = below + box.height + margin > window.innerHeight ? Math.max(margin, anchor.top - box.height - 6) : below;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
}
