// @vitest-environment jsdom
//
// The panel's three on-screen promises: it names the host it sent a payload to, it
// does not disappear while you are using it (rule 3 at the top of tooltip.ts), and
// it renders an answer only for the question it actually asked (rule 5).
//
// The hover specs are here because both halves of rule 3 SHIPPED BROKEN, and both
// looked like the whole feature was broken: the panel closed under the pointer as
// soon as the pointer moved inside it, and the panel's own scrollbar closed it. A
// bug you cannot reach by hovering in a unit test is a bug that comes back.
//
// The correlation specs are here for the opposite reason — nothing has gone wrong
// yet. They pin a property whose failure would not look like a bug at all: a panel
// captioned with this workflow's id, showing another workflow's decrypted input.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodecConfig, PayloadKind, PayloadRequest, PayloadResult } from '../../src/payloads';
import { isPayloadRequest } from '../../src/payloads';
import {
    installPayloadTooltip,
    MAX_CACHED_PAYLOADS,
    provenance,
    removePayloadTooltip,
    resetPayloadState,
    type TooltipRow,
} from '../../src/tooltip';
import { PANEL_CLASS, PAYLOAD_CLASS } from '../../src/render';
import { MESSAGE_SOURCE } from '../../src/types';
import { fakeRunId } from '../helpers';

describe('provenance', () => {
    it('names the endpoint by host', () => {
        const note = provenance('codec.example.com');

        expect(note.textContent).toBe(' · decoded by codec.example.com');
    });

    it('carries its own class, so the heading cannot uppercase the hostname', () => {
        // Asserting the class rather than the computed style on purpose: jsdom
        // applies no stylesheet, so a getComputedStyle check here would pass with
        // the rule deleted. The class is the contract between the two files;
        // `.tuis-panel-provenance` in public/content.css is the other half.
        const note = provenance('codec.example.com');

        expect(note.className).toBe('tuis-panel-provenance');
        expect(note.tagName).toBe('SPAN');
    });

    it('writes the host as text, never as markup', () => {
        // A codec endpoint is a string from settings. It is not authored here.
        const note = provenance('a<img src=x onerror=alert(1)>.example.com');

        expect(note.querySelector('img')).toBeNull();
        expect(note.textContent).toContain('a<img src=x onerror=alert(1)>.example.com');
    });
});

// ── The harness ──────────────────────────────────────────────────────────────

const NAMESPACE = 'sample-namespace';
const RUN_ID = fakeRunId(201);

const ROW: TooltipRow = {
    workflowId: 'sample-workflow',
    runId: RUN_ID,
    workflowType: 'SampleWorkflow',
    status: 'Completed',
};

// A running workflow is asked ONE question rather than two — there is no result
// event to fetch — which is also what makes it the right fixture for counting
// requests below.
const RUNNING_ROW: TooltipRow = { ...ROW, status: 'Running' };

// A DIFFERENT row, for the specs about moving the pointer between two buttons. Its
// ids differ from the first row's, because the whole point of those specs is which
// row was asked about.
const SECOND_ROW: TooltipRow = { ...RUNNING_ROW, workflowId: 'second-workflow', runId: fakeRunId(202) };

const GRACE_MS = 500; // comfortably past HOVER_DELAY_MS and CLOSE_DELAY_MS
const PART_WAY_MS = 80; // short of HOVER_DELAY_MS, so a pending hover timer is still pending

// Every dependency is read through a function, so a spec can change what the page
// looks like between two hovers — which is the only way to test that the namespace
// is part of the cache key.
let currentRow: TooltipRow | null = ROW;
let currentNamespace = NAMESPACE;
let currentCodec: CodecConfig = { endpoint: '' };

// Rows that belong to a SPECIFIC button, for the two-button specs. Everything else
// uses currentRow, so one fixture row stays the default and nothing else changes.
const rowsByButton = new Map<HTMLElement, TooltipRow>();

// Every payload request the panel posted, in order.
let posted: PayloadRequest[] = [];

function button(): HTMLElement {
    return document.querySelector<HTMLElement>(`.${PAYLOAD_CLASS}`)!;
}

// A second row in the same table, with its own `{ }` button bound to its own
// workflow. Returned rather than looked up, because the specs that use it need to
// aim a pointer event at exactly this one.
function addSecondButton(row: TooltipRow = SECOND_ROW): HTMLElement {
    const cell = document
        .querySelector('tbody')!
        .appendChild(document.createElement('tr'))
        .appendChild(document.createElement('td'));
    const trigger = cell.appendChild(document.createElement('button'));
    trigger.className = PAYLOAD_CLASS;
    trigger.textContent = '{ }';
    rowsByButton.set(trigger, row);
    return trigger;
}

function panel(): HTMLElement {
    return document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;
}

function section(kind: PayloadKind): { heading: Element; body: Element } {
    const nodes = panel().querySelectorAll(`.${PANEL_CLASS}-section`);
    const node = kind === 'input' ? nodes[0]! : nodes[1]!;
    return {
        heading: node.querySelector(`.${PANEL_CLASS}-heading`)!,
        body: node.querySelector(`.${PANEL_CLASS}-body`)!,
    };
}

// pointerover is what the code listens to, and it must bubble to reach a
// delegated listener on the document — as a real one does.
function pointerOver(target: EventTarget): void {
    target.dispatchEvent(new Event('pointerover', { bubbles: true }));
}

function openPanel(): void {
    pointerOver(button());
    vi.advanceTimersByTime(GRACE_MS);
    expect(panel().hidden).toBe(false);
}

// The answer, as the MAIN world would post it: every field the request named,
// echoed back. `answers()` builds a CORRECT one, and each correlation spec below
// breaks exactly one field of it.
function answerTo(request: PayloadRequest, overrides: Partial<PayloadResult> = {}): PayloadResult {
    return {
        source: MESSAGE_SOURCE,
        type: 'payload-result',
        id: request.id,
        namespace: request.namespace,
        workflowId: request.workflowId,
        runId: request.runId,
        kind: request.kind,
        label: request.kind === 'input' ? 'Input' : 'Completed',
        text: `text for ${request.kind} of ${request.workflowId}`,
        error: null,
        decodedBy: null,
        ...overrides,
    };
}

function deliver(data: unknown, source: Window | null = window): void {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
}

// The answer travels through a CHAIN of awaits before it reaches the DOM: the
// promise ask() is waiting on, the cache write and the in-flight cleanup that
// request() hangs off it, request()'s own frame, then the continuation in fill().
// Draining microtasks is what makes the assertion about the panel rather than about
// the message.
//
// Generously longer than the chain, and deliberately NOT the exact hop count. It was
// 4 — which was exact — and adding rule 6's in-flight join lengthened the chain and
// turned eight render assertions red for a reason that had nothing to do with the
// panel. Note that a drain which is too SHORT fails loudly (a section still reading
// "Loading…") rather than passing vacuously, because every spec expecting "Loading…"
// after a bad answer is paired with one expecting the real text after a good one.
const MICROTASK_DRAIN = 24;

async function settled(): Promise<void> {
    for (let tick = 0; tick < MICROTASK_DRAIN; tick++) await Promise.resolve();
}

// One complete round trip: hover, answer whatever was asked, render.
async function hoverAndAnswer(overrides: Partial<PayloadResult> = {}): Promise<void> {
    const before = posted.length;
    openPanel();
    for (const request of posted.slice(before)) deliver(answerTo(request, overrides));
    await settled();
}

beforeAll(() => {
    // Installed once: it registers listeners on the document and the window, and
    // installing per test would stack them.
    installPayloadTooltip({
        // Per-button first, so a two-button spec can give each row its own identity;
        // currentRow otherwise, which is what every other spec uses.
        findRow: (tr) => {
            const trigger = tr.querySelector<HTMLElement>(`.${PAYLOAD_CLASS}`);
            return (trigger && rowsByButton.get(trigger)) ?? currentRow;
        },
        namespace: () => currentNamespace,
        codec: () => currentCodec,
    });
});

beforeEach(() => {
    vi.useFakeTimers();
    currentRow = ROW;
    currentNamespace = NAMESPACE;
    currentCodec = { endpoint: '' };
    rowsByButton.clear();
    posted = [];
    // Module state, and it outlives a test: without this the specs that count
    // requests would pass or fail depending on which ran first.
    resetPayloadState();
    vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
        // The type guard, not a cast: a message the page world would refuse is a
        // message that was never sent, and this spec should fail in that case.
        if (isPayloadRequest(message)) posted.push(message);
    }) as typeof window.postMessage);
    // A table row, because openNow resolves the row through button.closest('tr').
    // Built node by node rather than with innerHTML: `npm run surface` parses the
    // test tree too, and a fixture is not a good enough reason to teach the gate
    // that some innerHTML is fine.
    document.body.replaceChildren();
    const table = document.body.appendChild(document.createElement('table'));
    const cell = table
        .appendChild(document.createElement('tbody'))
        .appendChild(document.createElement('tr'))
        .appendChild(document.createElement('td'));
    const trigger = cell.appendChild(document.createElement('button'));
    trigger.className = PAYLOAD_CLASS;
    trigger.textContent = '{ }';
});

describe('the panel under the pointer', () => {
    it('survives a move between two elements INSIDE it', () => {
        openPanel();

        // Heading to body, the move a reader makes before they have read a word,
        // as the browser reports it: pointerout naming where the pointer went,
        // then pointerover on the element it arrived at.
        const heading = panel().querySelector(`.${PANEL_CLASS}-heading`)!;
        const body = panel().querySelector(`.${PANEL_CLASS}-body`)!;
        heading.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: body }));
        pointerOver(body);
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(false);
    });

    // The test above passes if EITHER guard works, which is not good enough: it
    // was written first, and it stayed green against the broken pointerout
    // handler because the pointerover that follows happened to cancel the close.
    // These two pin one guard each, so neither can regress behind the other.

    it('does not schedule a close on a pointerout inside it', () => {
        openPanel();

        panel().querySelector(`.${PANEL_CLASS}-heading`)!.dispatchEvent(new Event('pointerout', { bubbles: true }));
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(false);
    });

    it('cancels a close already scheduled when the pointer arrives inside it', () => {
        openPanel();

        // Leaving the button starts the grace period; crossing the gap into the
        // panel has to stop it, and `pointerenter` cannot be relied on to say so
        // once the pointer is moving between the panel's own children.
        pointerOver(document.querySelector('table')!);
        pointerOver(panel().querySelector(`.${PANEL_CLASS}-body`)!);
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(false);
    });

    it('survives its own scrollbar', () => {
        openPanel();

        // The panel is a scroller (max-height + overflow: auto). A scroll event
        // does not bubble, so the listener that closes on a PAGE scroll is
        // capture-phase on the window — and therefore hears this one too.
        panel().dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(false);
    });

    it('stays open while a mouse button is held down inside it', () => {
        // Rule 3's drag half: selecting a value out of the panel routinely drags
        // the pointer past its edge, and closing there loses the selection and the
        // text at once.
        openPanel();
        panel().dispatchEvent(new Event('pointerdown', { bubbles: true }));

        pointerOver(document.querySelector('table')!);
        vi.advanceTimersByTime(GRACE_MS * 4);
        expect(panel().hidden).toBe(false);

        // …and closes once the button is released, or the panel would be stuck open
        // for the rest of the page's life.
        window.dispatchEvent(new Event('pointerup'));
        vi.advanceTimersByTime(GRACE_MS);
        expect(panel().hidden).toBe(true);
    });

    it('still closes when the pointer moves out to the page', () => {
        openPanel();

        pointerOver(document.querySelector('table')!);
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(true);
    });

    it('still closes when the pointer leaves the document', () => {
        openPanel();

        // No element is entered, so no pointerover follows. relatedTarget: null is
        // the only signal that the pointer is gone rather than merely elsewhere.
        document.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: null }));
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(true);
    });

    it('still closes when the PAGE scrolls', () => {
        // The reason the listener exists: the panel is position: fixed, so a page
        // scroll would leave it pointing at a row that has moved.
        openPanel();

        document.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel().hidden).toBe(true);
    });
});

// ── What the hover costs ─────────────────────────────────────────────────────

describe('what one hover asks for', () => {
    it('asks nothing at all until a pointer arrives', () => {
        // Rule 1, as an assertion: the button is on the row and the panel exists as
        // soon as a hover happens, but a rendered table costs zero requests. The
        // whole feature's cost story is this line.
        expect(posted).toHaveLength(0);
    });

    it('asks for the input and the outcome of a closed workflow, and addresses this origin', () => {
        openPanel();

        expect(posted.map((request) => request.kind)).toEqual(['input', 'outcome']);
        expect(posted[0]).toMatchObject({ namespace: NAMESPACE, workflowId: ROW.workflowId, runId: RUN_ID });
    });

    it('does not ask for the result of a running workflow', () => {
        // There is no result event yet, so the request could only ever answer
        // "nothing". The panel says so itself instead of spending a round trip
        // finding out.
        currentRow = RUNNING_ROW;

        openPanel();

        expect(posted.map((request) => request.kind)).toEqual(['input']);
        expect(section('outcome').body.textContent).toBe('Still running.');
    });

    it('sends the codec endpoint with the request, and nothing else', () => {
        // The MAIN world holds no extension APIs, so the endpoint has to travel with
        // the question. It is also why the endpoint is re-checked on arrival — see
        // the ledger note in pageApi.ts.
        currentCodec = { endpoint: 'https://codec.example.com' };

        openPanel();

        // toEqual and not toMatchObject: the assertion is that the message carries ONE
        // codec field. A credential flag beside a caller-chosen endpoint is the thing
        // this stage deleted, and a message that still shipped one would pass a
        // subset check while re-opening exactly that hole.
        expect(posted[0]!.codec).toEqual({ endpoint: 'https://codec.example.com' });
    });

    it('asks about the row the pointer ENDED on, not the one it passed over first', () => {
        // RULE 2'S OWN BUG, and the reason the hover timer has to remember its button.
        // Crossing a table enters several buttons inside the delay. The timer was
        // armed for the first one and every later button was ignored, so the panel
        // opened anchored under row B carrying row A's payload — rule 5's failure mode
        // reached through the code that implements rule 2.
        currentRow = RUNNING_ROW;
        const second = addSecondButton();

        pointerOver(button());
        vi.advanceTimersByTime(PART_WAY_MS);
        pointerOver(second);
        vi.advanceTimersByTime(GRACE_MS);

        // Exactly one request, and it is about the second row: the first row's timer
        // was cancelled rather than left to fire. Asserting the id as well as the
        // length is what makes this fail against the old code, which asked once too —
        // about the wrong workflow.
        expect(posted.map((request) => request.workflowId)).toEqual([SECOND_ROW.workflowId]);
        expect(panel().hidden).toBe(false);
        expect(panel().textContent).toContain(SECOND_ROW.workflowId);
    });

    it('still opens while the pointer sits on one button and pointerover repeats', () => {
        // The other half of the same fix, and the reason it is not simply "cancel and
        // re-arm every time". pointerover fires for every element entered and a button
        // has children, so a handler that re-armed unconditionally would push the
        // opening one delay further into the future on every event — a panel that
        // never opens while the pointer is moving inside its own button.
        currentRow = RUNNING_ROW;

        for (let tick = 0; tick < 5; tick++) {
            pointerOver(button());
            vi.advanceTimersByTime(PART_WAY_MS);
        }

        expect(panel().hidden).toBe(false);
        expect(posted).toHaveLength(1);
    });

    it('asks once when a click on the button also fires focusin', async () => {
        // RULE 6. A real click on the `{ }` button fires focusin AND click, and both
        // open the panel. The cache cannot help: it is still empty while the first
        // request is in flight, so each entry point found nothing, posted its own
        // message and waited for its own reply. Two history events for one click —
        // and, with a codec server configured, two copies of the same payload leaving
        // the machine.
        currentRow = RUNNING_ROW;

        button().dispatchEvent(new Event('focusin', { bubbles: true }));
        button().dispatchEvent(new Event('click', { bubbles: true }));
        await settled();

        expect(posted).toHaveLength(1);

        // The positive control, and it is the half a naive fix breaks: the second
        // caller JOINED the first question, so it must still be handed the answer.
        // Dropping it instead would leave the panel reading "Loading…" for ever, which
        // is a worse bug than the duplicate request.
        deliver(answerTo(posted[0]!));
        await settled();
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('asks nothing when the row cannot be identified', () => {
        // No run id, no history request. The panel does not open either, because an
        // empty panel over a row reads as "this workflow has no input".
        currentRow = null;

        pointerOver(button());
        vi.advanceTimersByTime(GRACE_MS);

        expect(posted).toHaveLength(0);
        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });
});

// ── Rule 5: an answer has to name the question it answers ────────────────────
//
// Every spec here delivers a message the id check ALONE would accept. The id is a
// small integer starting at 1 in every tab, so "it carries id 1" is a thing a
// forged or stale message gets right by accident.

describe('correlating an answer with its question', () => {
    it('renders an answer that names the run it was asked about', () => {
        // The positive control. Without it, every spec below would pass against a
        // panel that renders nothing at all.
        return hoverAndAnswer().then(() => {
            expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
            expect(section('input').heading.textContent).toBe('Input');
        });
    });

    it('names the codec host in the heading when part of the answer was decoded elsewhere', async () => {
        // The on-screen promise the README makes: a payload that was sent to a
        // server says so where it is read, not only in a settings page.
        await hoverAndAnswer({ decodedBy: 'codec.example.com' });

        expect(section('input').heading.textContent).toContain('decoded by codec.example.com');
        expect(section('input').heading.querySelector(`.${PANEL_CLASS}-provenance`)).not.toBeNull();
    });

    it('renders nothing from an answer about a different run', async () => {
        openPanel();
        const asked = posted[0]!;

        deliver(answerTo(asked, { runId: fakeRunId(999), text: 'somebody else’s input' }));
        await settled();

        expect(section('input').body.textContent).toBe('Loading…');
        expect(panel().textContent).not.toContain('somebody else');
    });

    it('renders nothing from an answer about a different namespace or workflow id', async () => {
        // A workflow id is unique only WITHIN a namespace, and one tab reaches
        // several. This is the case a run-keyed check would miss.
        openPanel();
        const asked = posted[0]!;

        deliver(answerTo(asked, { namespace: 'another-namespace', text: 'other namespace' }));
        deliver(answerTo(asked, { workflowId: 'another-workflow', text: 'other workflow' }));
        await settled();

        expect(section('input').body.textContent).toBe('Loading…');
    });

    it('does not put a result answer in the input section', async () => {
        // Same run, same id, wrong half of the panel. Nothing about the id says
        // which question it belongs to.
        openPanel();
        const asked = posted.find((request) => request.kind === 'input')!;

        deliver(answerTo(asked, { kind: 'outcome', label: 'Completed', text: 'the result' }));
        await settled();

        expect(section('input').body.textContent).toBe('Loading…');
    });

    it('renders nothing from an answer whose fields are not the types they claim', async () => {
        // A MUTATION AUDIT FOUND THIS GAP. Every spec around it correlates — right
        // shape, wrong run — so all of them still passed with the shape check at the
        // top of the message handler deleted, because the id lookup and the
        // correlation check between them turn most malformed messages away anyway.
        //
        // What they do not turn away is a message with the four correlation fields
        // right and a RENDERED field wrong, which is the one that reaches the screen:
        // `text: {}` is painted as "[object Object]" and an `error` of 0 is falsy, so
        // the panel skips the error branch and shows a body it does not have. Neither
        // looks like a rejected message; both look like the extension is broken.
        //
        // isPayloadResult validates to the leaves. This is the spec that says its CALL
        // SITE is load-bearing, and it is asserted through the panel because that is
        // where the wrong thing would appear. The guard's own truth table is in
        // tests/unit/payloads.spec.ts.
        openPanel();
        const asked = posted[0]!;

        for (const malformed of [{ text: {} }, { label: 42 }, { error: 0 }, { decodedBy: 7 }]) {
            deliver({ ...answerTo(asked), ...malformed });
        }
        await settled();

        expect(section('input').body.textContent).toBe('Loading…');
        expect(section('input').heading.textContent).toBe('Input');
        // And the question was not cancelled by any of them, so the real answer still
        // arrives — the same drop-do-not-delete property as the spec below.
        deliver(answerTo(asked));
        await settled();
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('lets the real answer land after a mismatched one arrived first', async () => {
        // THE assertion behind "drop it, do not settle it". A mismatched message is
        // not deleted from the pending map, because deleting it would let a forged
        // or stale answer CANCEL the question it collided with — and the section
        // would sit at "Loading…" until the timeout, with no way to retry but a
        // reload.
        openPanel();
        const asked = posted[0]!;

        deliver(answerTo(asked, { runId: fakeRunId(999), text: 'wrong run' }));
        await settled();
        deliver(answerTo(asked));
        await settled();

        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('ignores a well-formed answer to a question nobody asked', async () => {
        // Nothing was hovered, so there is no pending question. Anything on the page
        // can post one of these.
        deliver({
            source: MESSAGE_SOURCE,
            type: 'payload-result',
            id: 1,
            namespace: NAMESPACE,
            workflowId: ROW.workflowId,
            runId: RUN_ID,
            kind: 'input',
            label: 'Input',
            text: 'unsolicited',
            error: null,
            decodedBy: null,
        });
        await settled();

        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });

    it('ignores a message from an iframe even when every field matches', async () => {
        // event.source is the one part of a MessageEvent the sender does not choose.
        openPanel();
        const asked = posted[0]!;

        deliver(answerTo(asked, { text: 'from an iframe' }), null);
        await settled();

        expect(section('input').body.textContent).toBe('Loading…');
    });

    it('renders an error answer as an error, not as a payload', async () => {
        await hoverAndAnswer({ error: 'No codec server configured.', text: '', label: '' });

        expect(section('input').body.textContent).toBe('⚠ No codec server configured.');
    });
});

// ── The cache, and what it is allowed to keep ────────────────────────────────

describe('caching answers', () => {
    it('does not ask twice about the same run', async () => {
        currentRow = RUNNING_ROW;
        await hoverAndAnswer();
        expect(posted).toHaveLength(1);

        await hoverAndAnswer();

        expect(posted).toHaveLength(1);
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('does not serve one namespace’s payload as another’s', async () => {
        // The namespace is part of the cache key for the same reason it is part of
        // the correlation check: `order-42` exists in staging and in production, and
        // a tab reaches both.
        currentRow = RUNNING_ROW;
        await hoverAndAnswer();

        currentNamespace = 'another-namespace';
        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
        expect(posted[1]!.namespace).toBe('another-namespace');
    });

    it('does not cache an error, because it is usually a setting about to be fixed', async () => {
        currentRow = RUNNING_ROW;
        await hoverAndAnswer({ error: 'No codec server configured.', text: '', label: '' });

        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('forgets everything when the codec settings change', async () => {
        // Configuring a codec server has to make the panel re-ask, or the answer
        // that says "not decoded here" is the answer forever and the setting looks
        // like it did nothing.
        currentRow = RUNNING_ROW;
        await hoverAndAnswer();

        resetPayloadState();
        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
    });

    it('does not let an answer already in flight repopulate the cache it was cleared out of', async () => {
        // THE INVALIDATION EPOCH. Emptying the map is not enough on its own: a request
        // posted under the OLD codec endpoint is still out there, and it resolves a
        // moment after the setting changed. Writing that answer into the cache would
        // serve the old endpoint's text — or a "no codec server configured" error's
        // successor — as though it were the new setting's answer, and the user would
        // have to hover twice to see their own change take effect.
        currentRow = RUNNING_ROW;
        openPanel();
        const asked = posted[0]!;

        resetPayloadState();
        deliver(answerTo(asked));
        await settled();

        // Asked again, which is the observable consequence of the answer not being
        // kept. Without the epoch this is 1: the late answer lands in the fresh cache
        // and the next hover reads it back.
        await hoverAndAnswer();
        expect(posted).toHaveLength(2);
    });

    it('does not let an answer already in flight paint the panel either', async () => {
        // The other half of the spec above, and the half that was BROKEN: the epoch
        // stopped the late answer being cached and nothing stopped it being rendered.
        // A user who removed their codec endpoint would still have watched that
        // endpoint's decode appear in the open panel a moment later — the one place
        // the removed setting is most visible.
        currentRow = RUNNING_ROW;
        openPanel();
        const asked = posted[0]!;

        resetPayloadState();
        deliver(answerTo(asked, { text: 'decoded by a server you just removed' }));
        await settled();

        // Hidden, and holding nothing from the old setting. Asserted on the body text
        // as well as on `hidden`, because a panel that is merely hidden still hands
        // the text to anything that reads the DOM.
        expect(panel().hidden).toBe(true);
        expect(panel().textContent).not.toContain('decoded by a server you just removed');
    });

    it('does not let a settling request cancel the join for the one that replaced it', async () => {
        // Rule 6 across a settings change. A → reset → B for the same key → A settles.
        // A's cleanup used to delete whatever the key held, which by then was B, so C
        // posted a third request instead of joining B for free. Nothing about it looks
        // wrong on screen; it is visible only as request count.
        currentRow = RUNNING_ROW;
        openPanel();
        const first = posted[0]!;
        expect(posted).toHaveLength(1);

        resetPayloadState();
        openPanel(); // B: same run, same key, a new request because the cache is empty
        expect(posted).toHaveLength(2);

        deliver(answerTo(first)); // A settles, late and unwanted
        await settled();

        // C: the same question again while B is still out. It must join B.
        pointerOver(button());
        vi.advanceTimersByTime(GRACE_MS);
        await settled();

        expect(posted).toHaveLength(2);
    });

    it('is bounded, because what it holds is decoded personal data', async () => {
        // The per-row cache is bounded for memory. This one is bounded for memory
        // AND because its values are the payloads themselves: a tab left open all
        // afternoon would otherwise hold every customer record its owner had
        // glanced at, long after the panel closed.
        currentRow = RUNNING_ROW;
        for (let index = 0; index < MAX_CACHED_PAYLOADS; index++) {
            currentRow = { ...RUNNING_ROW, runId: fakeRunId(1_000 + index) };
            await hoverAndAnswer();
        }
        expect(posted).toHaveLength(MAX_CACHED_PAYLOADS);

        // Still cached at the limit: eviction has not happened yet.
        currentRow = { ...RUNNING_ROW, runId: fakeRunId(1_000) };
        await hoverAndAnswer();
        expect(posted).toHaveLength(MAX_CACHED_PAYLOADS);

        // One more distinct run tips it over, and the whole map goes — so the run
        // that was cached first has to be asked about again.
        currentRow = { ...RUNNING_ROW, runId: fakeRunId(2_000) };
        await hoverAndAnswer();
        currentRow = { ...RUNNING_ROW, runId: fakeRunId(1_000) };
        await hoverAndAnswer();

        // Two requests beyond the loop: the run that tipped the map over, and the
        // re-ask for the run that was evicted with it.
        expect(posted).toHaveLength(MAX_CACHED_PAYLOADS + 2);
    });
});

// ── Rule 7: switching it off takes it away ───────────────────────────────────

describe('switching the panel off', () => {
    it('takes the panel off the page, not merely out of the render pass', async () => {
        // The `{ }` buttons are in the table, so the render pass stops drawing them.
        // The panel is on <body>, where no render pass looks — so before this existed,
        // turning the feature off while a panel was open left a decoded payload sitting
        // on screen underneath a switch that said the feature was off.
        currentRow = RUNNING_ROW;
        await hoverAndAnswer();
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);

        removePayloadTooltip();

        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });

    it('forgets what it had decoded, so switching it back on does not reprint it', async () => {
        // The half a user cannot see, and the reason this is not just `panel.remove()`:
        // the cache holds the decoded payloads themselves. "Off" has to mean the text
        // is gone as well as the node.
        currentRow = RUNNING_ROW;
        await hoverAndAnswer();
        expect(posted).toHaveLength(1);

        removePayloadTooltip();
        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
    });

    it('drops an answer that arrives after it was switched off', async () => {
        // Nothing can recall a request already sent — the history event was fetched
        // and any codec POST has happened. What this does control is the screen: a
        // reply landing after the switch moved must not reopen the panel or fill it.
        currentRow = RUNNING_ROW;
        openPanel();
        const asked = posted[0]!;

        removePayloadTooltip();
        deliver(answerTo(asked));
        await settled();

        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });
});
