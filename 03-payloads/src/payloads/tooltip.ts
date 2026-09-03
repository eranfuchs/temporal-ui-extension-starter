// The hover panel that shows a workflow's input and result.
//
// RESPONSIBILITY: one floating element, and the decision about WHEN to ask for a
// payload. It owns the panel's markup, its position, the pointer and keyboard
// gestures that open and close it, and the rendering of an answer. It asks
// src/payloads/payloadClient.ts for the answer and never fetches anything itself — the
// fetch is payloadServe.ts's, in the page's world, for the CORS reasons set out at
// the top of codec.ts.
//
// ISOLATED world. That matters for more than imports: the panel lives on
// document.body, which is the page's DOM, not one of our own. See rule 5.
//
// FIVE RULES here — all about the element and the gesture. The four about which
// ANSWER may be believed are the client's, at the top of src/payloads/payloadClient.ts, and
// are numbered as invariants so a citation says which file it means. Each of these
// five was broken at least once by the code written to uphold it, and the incidents
// are in docs/design-notes.md under "The payload panel" — required reading before
// deleting one.
//
//  1. NOTHING IS FETCHED ON RENDER. A table of 100 rows must cost zero requests
//     until a pointer lands on one. The only entry points are pointerover,
//     focusin and click — there is no code path from a render pass to a request.
//  2. HOVER INTENT, NOT A DELAY. The timer before asking remembers WHICH button it
//     is for; a different button cancels and re-arms it. Without that field the
//     timer fires for the row the pointer has left, which anchors the panel to one
//     row and fills it with another row's payload.
//  3. IT DOES NOT CLOSE UNDER THE POINTER. A panel that vanishes when the pointer
//     leaves the button cannot be read, scrolled, or selected out of — and
//     selecting a value out of it is most of why anyone opens it. So: a grace
//     period, cancelled by the pointer being anywhere over the panel, suspended
//     entirely while a mouse button is held down inside it, and a scroll of the
//     panel's own scrollbar is not a scroll of the page.
//  4. A LATE ANSWER DOES NOT PAINT INTO THE PANEL THAT REPLACED IT. Two hovers are
//     two requests in flight and they can answer in either order. Every fill is
//     stamped with the generation of the hover that asked for it, and `generation`
//     moves whenever the panel stops belonging to that hover — openNow() takes the
//     next one, close() moves past it — so both opening the next panel and closing
//     this one make an answer already in flight undeliverable.
//  5. SWITCHING IT OFF TAKES THE NODE, THE REFERENCE AND THE TEXT. The `{ }`
//     buttons are in the table, so a render pass removes them; the panel is on
//     <body>, so no render pass touches it. Hiding it is not enough — `hidden`
//     stops decoded text being SHOWN and does nothing about it being THERE, in a
//     DOM the page can read.

import { installPayloadClient, requestPayload, resetPayloadClient, type Question } from './payloadClient';
import { type CodecConfig, type PayloadKind } from './payloadMessages';
import { PANEL_CLASS, PAYLOAD_CLASS } from '../decoration';

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

// A workflow that has not closed has no result event to fetch, and asking for
// one is a request that can only answer "nothing yet".
const RUNNING_STATUS = 'Running';

let deps: TooltipDeps | null = null;
let panel: HTMLDivElement | null = null;
let titleLine: HTMLDivElement | null = null;
let sections: Record<PayloadKind, { heading: HTMLElement; body: HTMLElement }> | null = null;

// Which hover the panel currently belongs to, and the gate every fill checks.
// Rule 4.
let generation = 0;
let hoverTimer: number | null = null;
// WHICH button the pending hover timer is for. Rule 2: without this the timer is
// a delay and not an intent — see scheduleOpen().
let hoverTarget: HTMLElement | null = null;
let closeTimer: number | null = null;
let pointerHeldInPanel = false;

// Called when the codec settings change, and when the payload panel is switched
// off.
//
// FOUR THINGS CAN BE HOLDING AN ANSWER FROM BEFORE THE CHANGE, and this function
// exists because emptying only some of them is the reading that shipped a hole
// twice. resetPayloadClient() empties three — the cache, the requests in flight,
// and the right of an answer still in flight to be cached. The fourth is here:
//
//   close(), so a late answer allowed to paint cannot, because fill() gates on
//   `generation` and close() moves it past every hover in flight; and
//   erasePanelText(), because close() sets `hidden`, which stops the text being
//   SHOWN and does nothing about it being THERE. This panel is on document.body,
//   in the DOM the page shares with us — an ISOLATED world does not get its own —
//   so decoded payload text in a hidden node is text any script in the page can
//   read out of it. Hiding personal data is not erasing it.
//
// Both halves, and why each one was missed, are in docs/design-notes.md.
export function resetPayloadState(): void {
    close();
    erasePanelText();
    resetPayloadClient();
}

// Every node this panel puts words into, emptied. Null-safe on purpose: the master
// switch nulls these references before it resets, and a reset with no panel built
// yet is the ordinary first case.
function erasePanelText(): void {
    if (titleLine) titleLine.textContent = '';
    if (!sections) return;
    for (const section of Object.values(sections)) {
        section.heading.textContent = '';
        section.body.textContent = '';
    }
}

// Rule 5: the panel is switched off, so the panel goes away — the node, the
// reference to it (or insidePanel() keeps answering yes for a detached element and
// a click outside stops closing anything), and the decoded text behind it.
//
// What this CANNOT do is recall a request already sent. Switching off stops the
// next question; it is not a revocation, and the popup does not claim otherwise.
//
// Detach first, then reset: resetPayloadState() does the close() and the erasure.
// The node is gone by then, which is strictly more than erasing its text —
// ensurePanel() rebuilds on the next hover because it checks `isConnected`, not
// just for null.
export function removePayloadTooltip(): void {
    panel?.remove();
    panel = null;
    titleLine = null;
    sections = null;
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
    // delegated listener sees every move as "now over X". Over the button or
    // anywhere in the panel keeps it open; anything else starts the grace period.
    document.addEventListener('pointerover', (event) => {
        const button = buttonFrom(event.target);
        if (button) scheduleOpen(button);
        else if (insidePanel(event.target)) keepOpen();
        else scheduleClose();
    });
    // Rule 3. `pointerout` fires on every move BETWEEN elements, including two
    // elements inside the panel, so closing on it closed the panel under the
    // pointer. What is left here is the one case `pointerover` cannot report: the
    // pointer leaving the document, which enters no element at all and is the only
    // case with a null relatedTarget.
    document.addEventListener('pointerout', (event) => {
        if (event.relatedTarget === null) scheduleClose();
    });
    // Keyboard: the affordance is a real <button>, so it is reachable by Tab.
    document.addEventListener('focusin', (event) => {
        const button = buttonFrom(event.target);
        if (button) openNow(button);
    });
    document.addEventListener('click', (event) => {
        const button = buttonFrom(event.target);
        if (button) {
            // A click on a row's button must not also count as a click on the row
            // underneath it, which navigates away from the list.
            event.preventDefault();
            event.stopPropagation();
            openNow(button);
        } else if (!insidePanel(event.target)) {
            close();
        }
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
    // has to ask whether the scroller is the panel: rule 3, and the reason reading a
    // long payload used to dismiss it.
    window.addEventListener(
        'scroll',
        (event) => {
            if (insidePanel(event.target)) return;
            close();
        },
        { passive: true, capture: true },
    );
    window.addEventListener('resize', close);
    window.addEventListener('pointerup', () => {
        pointerHeldInPanel = false;
    });
}

function buttonFrom(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(`.${PAYLOAD_CLASS}`) : null;
}

function insidePanel(target: EventTarget | null): boolean {
    return target instanceof Node && panel !== null && panel.contains(target);
}

// ── Opening and closing ─────────────────────────────────────────────────────

function scheduleOpen(button: HTMLElement): void {
    cancel(closeTimer);
    closeTimer = null;
    // Already waiting for THIS button: leave the timer alone, so holding the pointer
    // still over one button does not push its own opening further away with every
    // pointerover the browser reports.
    if (hoverTimer !== null && hoverTarget === button) return;
    // A different button. Rule 2: the pending timer belongs to a row the pointer has
    // left, and letting it stand would fire for the old button, anchor the panel
    // there, and fetch that row's payload while the pointer sits on this one. Cancel
    // and re-arm, which also restarts the delay — moving across five rows costs
    // nothing and the fifth is the one that opens.
    cancel(hoverTimer);
    hoverTarget = button;
    hoverTimer = window.setTimeout(() => {
        hoverTimer = null;
        hoverTarget = null;
        openNow(button);
    }, HOVER_DELAY_MS);
}

// The pointer is somewhere it may stay. Cancels a close in flight without
// scheduling anything: called on every move inside the panel, so it has to be
// cheap and idempotent.
function keepOpen(): void {
    cancel(closeTimer);
    closeTimer = null;
}

function scheduleClose(): void {
    cancel(hoverTimer);
    hoverTimer = null;
    hoverTarget = null;
    if (closeTimer !== null) return;
    closeTimer = window.setTimeout(() => {
        closeTimer = null;
        // Rule 3: a held pointer means a selection is in progress inside the
        // panel. Re-arm rather than close, so the drag can finish.
        if (pointerHeldInPanel) {
            scheduleClose();
            return;
        }
        close();
    }, CLOSE_DELAY_MS);
}

function cancel(timer: number | null): void {
    if (timer !== null) window.clearTimeout(timer);
}

// Moving `generation` is the whole point of this function, not the `hidden` flag:
// it is what makes every answer still in flight undeliverable. openNow() moves it
// too — the difference is that this leaves it on a generation no hover owns. See
// fill().
function close(): void {
    cancel(hoverTimer);
    cancel(closeTimer);
    hoverTimer = null;
    hoverTarget = null;
    closeTimer = null;
    generation++;
    if (panel) panel.hidden = true;
}

function openNow(button: HTMLElement): void {
    cancel(hoverTimer);
    cancel(closeTimer);
    hoverTimer = null;
    hoverTarget = null;
    closeTimer = null;

    const tr = button.closest('tr');
    const row = tr && deps ? deps.findRow(tr as HTMLTableRowElement) : null;
    if (!row) return;

    // Read ONCE, for both sections. namespace() reads the current URL and this
    // function starts two round trips: asking twice could label one panel with
    // answers from two different namespaces if the user navigated in between.
    const namespace = deps?.namespace() ?? '';

    const mine = ++generation;
    const ui = ensurePanel();
    ui.panel.hidden = false;
    ui.titleLine.textContent = `${row.workflowId} · ${row.workflowType} · ${row.status}`;
    place(ui.panel, button);

    void fill({ namespace, workflowId: row.workflowId, runId: row.runId, kind: 'input' }, mine);
    if (row.status === RUNNING_STATUS) {
        ui.sections.outcome.heading.textContent = 'Result';
        ui.sections.outcome.body.textContent = 'Still running.';
    } else {
        void fill({ namespace, workflowId: row.workflowId, runId: row.runId, kind: 'outcome' }, mine);
    }
}

async function fill(question: Question, mine: number): Promise<void> {
    const ui = ensurePanel();
    const section = ui.sections[question.kind];
    section.heading.textContent = question.kind === 'input' ? 'Input' : 'Result';
    section.body.textContent = 'Loading…';

    const result = await requestPayload(question);
    // Rule 4. This answer belongs to a hover that is over: two hovers are two
    // requests in flight and they can answer in either order.
    if (mine !== generation) return;

    if (result.error) {
        section.body.textContent = `⚠ ${result.error}`;
        return;
    }
    section.heading.textContent = result.label;
    if (result.decodedBy) section.heading.appendChild(provenance(result.decodedBy));
    section.body.textContent = result.text;
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
    sections: Record<PayloadKind, { heading: HTMLElement; body: HTMLElement }>;
} {
    // `isConnected` and not just a null check: the master switch removes every
    // node this extension put in the page, this one included, so a stale
    // reference has to be rebuilt rather than re-shown.
    if (panel && titleLine && sections && panel.isConnected) return { panel, titleLine, sections };

    panel = document.createElement('div');
    panel.className = PANEL_CLASS;
    panel.setAttribute('role', 'tooltip');
    // The body is filled after a round trip, so a screen reader has to be told
    // it changed.
    panel.setAttribute('aria-live', 'polite');
    panel.hidden = true;

    titleLine = document.createElement('div');
    titleLine.className = `${PANEL_CLASS}-title`;
    panel.appendChild(titleLine);

    sections = {
        input: appendSection(panel),
        outcome: appendSection(panel),
    };

    panel.addEventListener('pointerenter', keepOpen);
    panel.addEventListener('pointerleave', scheduleClose);
    // Rule 3, the drag half of it. The release is listened for on the window
    // (in installPayloadTooltip) because the pointer is routinely released
    // outside the panel it was pressed in, and a pointerup we never see would
    // leave the flag set and the panel open for good.
    panel.addEventListener('pointerdown', () => {
        pointerHeldInPanel = true;
    });

    document.body.appendChild(panel);
    return { panel, titleLine, sections };
}

function appendSection(host: HTMLElement): { heading: HTMLElement; body: HTMLElement } {
    const section = document.createElement('div');
    section.className = `${PANEL_CLASS}-section`;
    const heading = document.createElement('div');
    heading.className = `${PANEL_CLASS}-heading`;
    // <pre>, because a payload is shown as the exact bytes that arrived — whatever
    // whitespace the server chose is the whitespace on screen, and collapsing it
    // would be this panel editing a value somebody may copy back into a request.
    // Set via textContent only: this is data authored by whoever started the workflow.
    const body = document.createElement('pre');
    body.className = `${PANEL_CLASS}-body`;
    section.append(heading, body);
    host.appendChild(section);
    return { heading, body };
}

// Anchored under the button, pulled back inside the viewport, flipped above when
// there is no room below. Measured after the panel is visible, because a hidden
// element has no height to measure.
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
