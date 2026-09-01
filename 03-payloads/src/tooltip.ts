// The hover panel that shows a workflow's input and result.
//
// ISOLATED world. It owns one floating element, decides WHEN to ask for a
// payload, and renders the answer — it never fetches anything itself. The fetch
// is payloadServe.ts’s, in the page’s world, for the CORS reasons set out at the
// top of payloads.ts.
//
// SEVEN RULES here. Six of them are each a bug that happened first. The fifth did
// not happen here: it was carried across from the per-row questions, where a review
// of rowInfoClient.ts found the same hole and the answer to "what is the worst a
// wrong answer does?" is much worse on this side.
//
//  1. NOTHING IS FETCHED ON RENDER. A table of 100 rows must cost zero requests
//     until a pointer lands on one. The only entry points are pointerover,
//     focusin and click — there is no code path from a render pass to a request.
//  2. HOVER INTENT. Moving the pointer across the table passes over many rows.
//     A short delay before asking means a traverse costs nothing.
//
//     The delay is only hover INTENT if it also remembers WHICH button it is
//     waiting for. It did not: the timer was armed for the first button entered
//     and any button entered while it was still pending was ignored, so pointing
//     at row A and moving to row B within the delay opened B's panel and filled it
//     with A's payload. Traversing a table is precisely how that happens, which
//     made the rule's own implementation the thing that broke rule 5.
//  3. IT DOES NOT CLOSE UNDER THE POINTER. A panel that vanishes when the
//     pointer moves off the button cannot be read, scrolled or selected — and
//     selecting a value out of it is most of why anyone opens it. So there is a
//     grace period, it is cancelled by the pointer being anywhere over the panel,
//     and it is suspended entirely while a mouse button is held down inside it (a
//     text selection dragged past the edge must not close it).
//
//     This rule was broken twice by the code enforcing it, and both bugs read as
//     "the tooltip is impossible to use": a `pointerout` between two elements
//     INSIDE the panel closed it under the pointer, and a capture-phase scroll
//     listener closed it when the panel's own scrollbar was used. Each is fixed
//     where it happened, and both are pinned by tests/unit/tooltip.spec.ts.
//  4. THE ANSWER MAY BE STALE BY THE TIME IT ARRIVES. Two hovers are two
//     requests in flight, and they can answer in either order. Every fill is
//     stamped with the generation of the hover that asked for it, and a late
//     answer to a closed panel is dropped rather than rendered into whatever is
//     open now.
//  5. AN ANSWER HAS TO NAME THE QUESTION IT ANSWERS. The request id is a small
//     integer starting at 1 in every tab, so "it carries id 3" is a thing a
//     forged message gets right by accident. Every answer is checked against the
//     namespace, workflow id, run id and kind that were asked about, and the same
//     four parts are the cache key. On this rung that check is doing more work
//     than it does for the per-row questions: the worst a wrong last-event answer
//     does is print the wrong event type in a cell, whereas the worst a wrong
//     payload answer does is put one workflow's decrypted input under another
//     workflow's name — somebody else's personal data, on screen, labelled as
//     this customer's.
//  6. ONE QUESTION IS ONE REQUEST. The cache answers a question asked twice — but
//     only once the first answer has ARRIVED. Three of the entry points reach the
//     same row (a hover opens it, Tab focuses it, a click on the button fires
//     focusin AND click), and every one of them found an empty cache and posted its
//     own message. Two requests for one panel, and on a rung that can forward a
//     payload to a codec server, two copies leaving the machine for one glance. So
//     a question already in flight is JOINED, not asked again.
//  7. SWITCHING IT OFF TAKES IT AWAY. The `{ }` buttons live in the table, so the
//     render pass removes them; the panel lives on <body>, so nothing in a render
//     pass touches it. Turning the payload switch off while a panel was open used
//     to leave it there — a decoded payload sitting on screen, under a switch that
//     said the feature was off — with its decoded text still in the cache behind
//     it. Off has to mean the node is gone and the cache is empty.

import {
    isPayloadResult,
    type CodecConfig,
    type PayloadKind,
    type PayloadRequest,
    type PayloadResult,
} from './payloads';
import { PANEL_CLASS, PAYLOAD_CLASS } from './render';
import { runKey } from './rows';
import { MESSAGE_SOURCE } from './types';

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

// Which hover the panel currently belongs to. Rule 4.
let generation = 0;
let hoverTimer: number | null = null;
// WHICH button the pending hover timer is for. Rule 2: without this the timer is
// a delay and not an intent — see scheduleOpen().
let hoverTarget: HTMLElement | null = null;
let closeTimer: number | null = null;
let pointerHeldInPanel = false;

// What one hover asks about. Rule 5: this is both the correlation check on the
// answer and the cache key, so the two cannot drift apart.
interface Question {
    namespace: string;
    workflowId: string;
    runId: string;
    kind: PayloadKind;
}

// Answers already received. A pointer moving back and forth between two rows is
// very common and each round trip is a real request.
const cache = new Map<string, PayloadResult>();

// The cache is bounded, which the per-row cache in rowInfoClient.ts needs for
// memory and this one needs for a second reason: its values are DECODED payloads,
// up to MAX_DISPLAY_CHARS each. A tab left open all afternoon would otherwise keep
// every customer record its owner had glanced at, long after the panel closed.
// Exported so the spec that drives eviction does not hard-code the number and
// then keep passing after it changes.
export const MAX_CACHED_PAYLOADS = 200;

// The namespace is part of the key, prefixed the same length-prefixed way runKey
// does it. A workflow id is unique WITHIN a namespace, and one tab reaches several
// of them, so a run-only key would serve `order-42`'s input from one namespace as
// `order-42`'s input in another — see the same argument, at more length, in
// rowInfoClient.ts.
function cacheKey(question: Question): string {
    const { namespace, workflowId, runId, kind } = question;
    return `${kind}|${namespace.length}:${namespace}:${runKey(workflowId, runId)}`;
}

// Emptying the map is not enough: a request already in flight under the old codec
// setting resolves a moment later and would refill the cache it was invalidated out
// of. Each request remembers the epoch it was asked under — see request().
let cacheEpoch = 0;

// Called when the codec settings change, and when the payload panel is switched
// off: an answer that failed because no codec server was configured must not be the
// answer forever, and an answer decoded by a server the user has since removed must
// not outlive the setting. Not needed for a namespace change — the namespace is in
// the key.
//
// close() FIRST, and it is not tidying up. Three things can be holding an answer
// from before the change — the cache, a request in flight, and the panel already
// on screen — and emptying only the first two leaves the third: the epoch stops a
// late answer being CACHED, and nothing stopped it being RENDERED, because fill()
// gates on `generation` and only close() moves that. So the setting a user had
// just removed could still paint its decode into the open panel, one hover after
// they removed it. Named for what it does to all three, because "clear the cache"
// is exactly the reading that shipped the hole.
export function resetPayloadState(): void {
    close();
    cache.clear();
    inFlight.clear();
    cacheEpoch++;
}

// Rule 7: the panel is switched off, so the panel goes away.
//
// Three separate things, and leaving out any one of them leaves personal data
// somewhere a user who just switched the feature off would not expect it: the node
// (which is on <body>, so no render pass touches it), the reference to the node
// (or insidePanel() keeps answering yes for a detached element and a click outside
// stops closing anything), and the decoded text behind it.
//
// What this CANNOT do is recall a request already sent. A history event fetched a
// moment ago was fetched; a payload already POSTed to a codec server is already
// there. Switching off stops the next question — it is not a revocation, and the
// popup does not claim otherwise.
export function removePayloadTooltip(): void {
    close();
    panel?.remove();
    panel = null;
    titleLine = null;
    sections = null;
    resetPayloadState();
}

export function installPayloadTooltip(dependencies: TooltipDeps): void {
    deps = dependencies;

    // Delegated, on the document. Per-element listeners would have to be attached
    // by the render pass and re-attached after every re-render — and the rows are
    // recycled, so they would accumulate on nodes that now show a different
    // workflow.
    // ONE handler decides where the pointer is, and `pointerover` is the event
    // that knows: it fires for every element the pointer enters, and it bubbles,
    // so a delegated listener sees every move as "now over X". Over the button or
    // anywhere in the panel keeps it open; anything else starts the grace period.
    document.addEventListener('pointerover', (event) => {
        const button = buttonFrom(event.target);
        if (button) scheduleOpen(button);
        else if (insidePanel(event.target)) keepOpen();
        else scheduleClose();
    });
    // `pointerout` fires on every move BETWEEN elements too, including two
    // elements inside the panel — heading to body is one — and closing on it was
    // rule 3's bug, in the code that exists to uphold rule 3: the panel vanished
    // under the pointer as soon as the pointer moved inside it, because
    // `pointerenter` does not fire again between descendants and so nothing
    // cancelled the close.
    //
    // What is left here is the one case `pointerover` cannot report: the pointer
    // leaving the document, which enters no element at all. `relatedTarget` is
    // null for exactly that and non-null for every element-to-element move.
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
    // way one listener hears every scroller on the page. Which is also how this
    // closed the panel whenever the panel itself was scrolled: it is a scroller
    // too (`max-height` + `overflow: auto`), so reading a long payload dismissed
    // the thing being read, and the panel became impossible to scroll at all.
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

    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        // Well-formed to the leaves — isPayloadResult validates every field,
        // including the three run fields this check is about to read.
        if (!isPayloadResult(event.data)) return;
        const waiting = pending.get(event.data.id);
        if (!waiting) return;
        // Rule 5. NOT `pending.delete` on a mismatch: a message that names the
        // wrong run must not settle — or cancel — the question it collided with.
        // Dropping it leaves the real answer (or the timeout) to do that, so the
        // worst a forged answer achieves here is nothing at all.
        //
        // As in rowInfoClient.ts, this is not authentication and cannot be made
        // into it: postMessage has no authenticated sender, and a forger who reads
        // the request we just posted knows all four fields. What it rules out is
        // every case that does not involve reading our traffic first — another
        // extension's messages, one of our own answers replayed for a different
        // namespace, and an unsolicited answer about a run nobody hovered.
        if (!answersTheQuestion(waiting.question, event.data)) return;
        pending.delete(event.data.id);
        waiting.settle(event.data);
    });
}

function answersTheQuestion(question: Question, result: PayloadResult): boolean {
    return (
        result.namespace === question.namespace &&
        result.workflowId === question.workflowId &&
        result.runId === question.runId &&
        result.kind === question.kind
    );
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
    // A different button. The pending timer belongs to a row the pointer has left,
    // and letting it stand is the bug in rule 2 above: it would fire for the old
    // button, anchor the panel there, and fetch that row's payload while the pointer
    // sits on this one. Cancel and re-arm, which also restarts the delay — moving
    // across five rows costs nothing and the fifth is the one that opens.
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

    const result = await request(question);
    // Rule 4: this answer belongs to a hover that is over.
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

// ── Asking the page world ───────────────────────────────────────────────────

let nextRequestId = 1;
const pending = new Map<number, { question: Question; settle: (result: PayloadResult) => void }>();

// Questions asked and not yet answered, keyed the same way the cache is. Rule 6:
// this is the cache for the interval the cache cannot cover — between the message
// going out and the answer coming back. Entries are removed as they settle, so this
// map is bounded by what is genuinely in flight and needs no eviction pass.
const inFlight = new Map<string, Promise<PayloadResult>>();

// A request that never comes back must not leave a section saying "Loading…"
// forever — the MAIN-world script could be absent entirely (an older build of
// the extension, a page it did not run on).
const REQUEST_TIMEOUT_MS = 15_000;

async function request(question: Question): Promise<PayloadResult> {
    const key = cacheKey(question);
    const cached = cache.get(key);
    if (cached) return cached;

    // Rule 6. The cache is only an answer to "have we asked this before?" once the
    // answer is back; between the message going out and the reply arriving it says
    // "no". Clicking the button is enough to reach here twice — the click fires
    // focusin as well — and both callers would have posted their own request and
    // waited for their own reply. Joining the promise makes the second caller free.
    const inflight = inFlight.get(key);
    if (inflight) return await inflight;

    const epoch = cacheEpoch;
    const attempt = ask(question)
        .then((result) => {
            // Remembered HERE rather than at each awaiter, so two callers sharing one
            // request write one cache entry, and so the eviction pass in remember()
            // is not run twice for the same insert.
            //
            // Errors are not cached: they are usually a setting the user is about to
            // fix. Neither is an answer whose epoch has passed — see cacheEpoch.
            if (!result.error && epoch === cacheEpoch) remember(key, result);
            return result;
        })
        // Whatever happened, this question is no longer in flight. In `finally` and
        // not in the `then` above so that a rejection — which ask() should never
        // produce, but a future edit could — cannot leave a permanently poisoned
        // entry that every later hover joins.
        //
        // ONLY IF THE ENTRY IS STILL THIS ATTEMPT'S. resetPayloadState() empties the
        // map while requests are still out, so the same key can legitimately hold a
        // NEWER attempt by the time this one settles. An unconditional delete then
        // removes the new attempt's entry, and the next hover — which should have
        // joined it for free — posts a third request instead. That is rule 6 failing
        // in the one situation nobody hovers twice to check.
        .finally(() => {
            if (inFlight.get(key) === attempt) inFlight.delete(key);
        });

    inFlight.set(key, attempt);
    return await attempt;
}

async function ask(question: Question): Promise<PayloadResult> {
    const id = nextRequestId++;
    const message: PayloadRequest = {
        source: MESSAGE_SOURCE,
        type: 'payload-request',
        id,
        namespace: question.namespace,
        workflowId: question.workflowId,
        runId: question.runId,
        kind: question.kind,
        // The fallback is the no-egress config: an uninstalled dependency must not
        // be able to produce a request that sends anything anywhere.
        codec: deps?.codec() ?? { endpoint: '' },
    };

    return await new Promise<PayloadResult>((resolve) => {
        const timeout = window.setTimeout(() => {
            pending.delete(id);
            resolve({
                source: MESSAGE_SOURCE,
                type: 'payload-result',
                id,
                namespace: question.namespace,
                workflowId: question.workflowId,
                runId: question.runId,
                kind: question.kind,
                label: '',
                text: '',
                decodedBy: null,
                error: 'No answer from the page world. Reload the tab.',
            });
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, {
            question,
            settle: (answer) => {
                window.clearTimeout(timeout);
                resolve(answer);
            },
        });
        // location.origin, never '*': this names a run the user is looking at, and
        // an iframe on the page has no business reading it.
        window.postMessage(message, location.origin);
    });
}

function remember(key: string, result: PayloadResult): void {
    // Whole-map eviction rather than an LRU, for the same reason rowInfoClient.ts
    // gives: what is on screen is one hover away from being re-fetched, so being
    // crude here costs one round trip and nothing else. Cleared BEFORE the insert,
    // so the entry the user is looking at survives its own eviction pass.
    if (cache.size >= MAX_CACHED_PAYLOADS) cache.clear();
    cache.set(key, result);
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
    // <pre>, because a decoded payload is pretty-printed JSON and its
    // indentation is the only thing making it readable. textContent throughout —
    // this is data authored by whoever started the workflow.
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
