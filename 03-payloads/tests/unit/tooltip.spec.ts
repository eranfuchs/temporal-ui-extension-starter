// @vitest-environment jsdom
//
// src/payloads/tooltip.ts — THE ELEMENT AND THE GESTURE. One spec section per rule at the top
// of that file: what a render costs (1), which button the delay belongs to (2), what
// does not close the panel (3), which answers may still paint into it (4), and what
// switching it off has to take with it (5).
//
// The four invariants about which ANSWER may be believed are the client's, and their
// specs are in payloadClient.spec.ts. Both files drive the same installed panel
// through tests/tooltipHarness.ts.
//
// Rule 3 is over-represented on purpose: BOTH HALVES OF IT SHIPPED BROKEN, and both
// looked like the whole feature was broken rather than like a detail — the panel
// closed under the pointer as soon as the pointer moved inside it, and the panel's own
// scrollbar closed it. A bug you cannot reach by hovering in a unit test is a bug that
// comes back.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    GRACE_MS,
    NAMESPACE,
    PART_WAY_MS,
    ROW,
    RUNNING_ROW,
    RUN_ID,
    SECOND_ROW,
    addSecondButton,
    button,
    hoverAndAnswer,
    installHarness,
    openPanel,
    page,
    panel,
    pointerOver,
    posted,
    resetHarness,
    section,
    settled,
    answerTo,
    deliver,
} from '../tooltipHarness';
import { PANEL_CLASS } from '../../src/render';
import { provenance, removePayloadTooltip } from '../../src/payloads/tooltip';

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

beforeAll(installHarness);
beforeEach(resetHarness);

// ── Rule 3: it does not close under the pointer ───────────────────────────────

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

// ── Rules 1 and 2: what a render costs, and which button the delay is for ─────

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
        page.row = RUNNING_ROW;

        openPanel();

        expect(posted.map((request) => request.kind)).toEqual(['input']);
        expect(section('outcome').body.textContent).toBe('Still running.');
    });

    it('sends the codec endpoint with the request, and nothing else', () => {
        // The MAIN world holds no extension APIs, so the endpoint has to travel with
        // the question. It is also why the endpoint is re-checked on arrival — see
        // the ledger note in pageApi.ts.
        page.codec = { endpoint: 'https://codec.example.com' };

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
        // opened anchored under row B carrying row A's payload — the failure mode
        // invariant 1 exists to catch, reached through the code that implements rule 2.
        page.row = RUNNING_ROW;
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
        page.row = RUNNING_ROW;

        for (let tick = 0; tick < 5; tick++) {
            pointerOver(button());
            vi.advanceTimersByTime(PART_WAY_MS);
        }

        expect(panel().hidden).toBe(false);
        expect(posted).toHaveLength(1);
    });

    it('asks nothing when the row cannot be identified', () => {
        // No run id, no history request. The panel does not open either, because an
        // empty panel over a row reads as "this workflow has no input".
        page.row = null;

        pointerOver(button());
        vi.advanceTimersByTime(GRACE_MS);

        expect(posted).toHaveLength(0);
        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });
});

// ── Rule 4: a late answer does not paint into the panel that replaced it ──────

describe('an answer arriving after its hover is over', () => {
    it('does not paint into the panel a second hover opened', async () => {
        // The generation gate, driven the way a pointer drives it: two rows, two
        // requests in flight, and the FIRST one answers last. Nothing about that
        // answer is malformed — it names the run it was asked about, so invariant 1
        // accepts it. The only thing wrong with it is that its hover is over.
        page.row = RUNNING_ROW;
        const second = addSecondButton();

        openPanel();
        const first = posted[0]!;

        pointerOver(second);
        vi.advanceTimersByTime(GRACE_MS);
        const current = posted[1]!;

        deliver(answerTo(first, { text: 'the row you have already left' }));
        await settled();

        expect(panel().textContent).not.toContain('the row you have already left');

        // The positive control, and it is what makes this a gate rather than a
        // blanket refusal: the answer to the hover that IS current still paints.
        deliver(answerTo(current));
        await settled();
        expect(section('input').body.textContent).toBe(`text for input of ${SECOND_ROW.workflowId}`);
    });

    it('does not reopen a panel that was closed while it was in flight', async () => {
        // Closing moves the generation too, which is what lets close() do double duty
        // in resetPayloadState(). Without that, moving the pointer away and having the
        // answer land a moment later would repaint a panel the user had dismissed.
        page.row = RUNNING_ROW;
        openPanel();
        const asked = posted[0]!;

        pointerOver(document.querySelector('table')!);
        vi.advanceTimersByTime(GRACE_MS);
        expect(panel().hidden).toBe(true);

        deliver(answerTo(asked, { text: 'late, for a panel you closed' }));
        await settled();

        expect(panel().hidden).toBe(true);
        expect(panel().textContent).not.toContain('late, for a panel you closed');
    });
});

// ── Rule 5: switching it off takes the node, the reference and the text ───────

describe('switching the panel off', () => {
    it('takes the panel off the page, not merely out of the render pass', async () => {
        // The `{ }` buttons are in the table, so the render pass stops drawing them.
        // The panel is on <body>, where no render pass looks — so before this existed,
        // turning the feature off while a panel was open left a decoded payload sitting
        // on screen underneath a switch that said the feature was off.
        page.row = RUNNING_ROW;
        await hoverAndAnswer();
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);

        removePayloadTooltip();

        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });

    it('forgets what it had decoded, so switching it back on does not reprint it', async () => {
        // The half a user cannot see, and the reason this is not just `panel.remove()`:
        // the cache holds the decoded payloads themselves. "Off" has to mean the text
        // is gone as well as the node.
        page.row = RUNNING_ROW;
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
        page.row = RUNNING_ROW;
        openPanel();
        const asked = posted[0]!;

        removePayloadTooltip();
        deliver(answerTo(asked));
        await settled();

        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });
});
