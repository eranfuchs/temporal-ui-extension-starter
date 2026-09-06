// @vitest-environment jsdom
//
// src/payloads/tooltip.ts — THE ELEMENT AND THE GESTURE, for the one panel
// shared by the Input and the Output button. One spec section per rule at the
// top of that file: what a render costs (1), which button the delay belongs to
// (2), what does not close the panel (3), which answers may still paint into it
// (4), and what switching it off has to take with it (5) — each demonstrated on
// the panel most likely to expose it (mostly Input, by convention with the
// harness's default), plus a dedicated section proving the SAME rule holds for
// Output rather than assuming it because the code is shared, and a section for
// the property that only exists because two buttons share it: that hovering the
// other kind replaces what the panel is showing rather than opening a second one
// beside it.
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
import { PANEL_CLASS } from '../../src/decoration';
import { provenance, removePayloadTooltip } from '../../src/payloads/tooltip';
import { JSON_FALLBACK_CLASS, JSON_VIEW_CLASS } from '../../src/payloads/jsonViewer';

describe('provenance', () => {
    it('names the endpoint by host', () => {
        const note = provenance('codec.example.com');

        expect(note.textContent).toBe(' · decoded by codec.example.com');
    });

    it('carries its own class, separate from the bold heading it sits inside', () => {
        // Asserting the class rather than the computed style on purpose: jsdom
        // applies no stylesheet, so a getComputedStyle check here would pass with
        // the rule deleted. The class is the contract between the two files;
        // `.tuis-panel-provenance` in public/content.css is the other half — it
        // keeps the hostname at normal weight while `.tuis-panel-heading` around
        // it is bold.
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
// Demonstrated on the Input panel; "holds for Output too" gets its own section
// further down rather than a duplicate of every case here.

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
        // Rule 1, as an assertion: both buttons are on the row and both panels
        // exist as soon as a hover happens, but a rendered table costs zero
        // requests. The whole feature's cost story is this line.
        expect(posted).toHaveLength(0);
    });

    it('asks only for the input, when Input is hovered', () => {
        openPanel('input');

        expect(posted.map((request) => request.kind)).toEqual(['input']);
        expect(posted[0]).toMatchObject({ namespace: NAMESPACE, workflowId: ROW.workflowId, runId: RUN_ID });
    });

    it('asks only for the outcome, when Output is hovered', () => {
        openPanel('outcome');

        expect(posted.map((request) => request.kind)).toEqual(['outcome']);
        expect(posted[0]).toMatchObject({ namespace: NAMESPACE, workflowId: ROW.workflowId, runId: RUN_ID });
    });

    it('does not ask for the result of a running workflow, on Output', () => {
        // There is no result event yet, so the request could only ever answer
        // "nothing". The panel says so itself instead of spending a round trip
        // finding out.
        page.row = RUNNING_ROW;

        openPanel('outcome');

        expect(posted).toHaveLength(0);
        expect(section('outcome').body.textContent).toBe('Still running.');
    });

    it('asks for the input of a running workflow anyway', () => {
        // The asymmetry is deliberate, not an oversight: an input event exists
        // from the moment the workflow starts, running or not. Only Output has a
        // "nothing to fetch yet" case.
        page.row = RUNNING_ROW;

        openPanel('input');

        expect(posted.map((request) => request.kind)).toEqual(['input']);
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
        const second = addSecondButton();

        pointerOver(button('input'));
        vi.advanceTimersByTime(PART_WAY_MS);
        pointerOver(second.input);
        vi.advanceTimersByTime(GRACE_MS);

        // Exactly one request, and it is about the second row: the first row's timer
        // was cancelled rather than left to fire. Asserting the id as well as the
        // length is what makes this fail against the old code, which asked once too —
        // about the wrong workflow.
        expect(posted.map((request) => request.workflowId)).toEqual([SECOND_ROW.workflowId]);
        expect(panel('input').hidden).toBe(false);
        expect(panel('input').textContent).toContain(SECOND_ROW.workflowId);
    });

    it('still opens while the pointer sits on one button and pointerover repeats', () => {
        // The other half of the same fix, and the reason it is not simply "cancel and
        // re-arm every time". pointerover fires for every element entered and a button
        // has children, so a handler that re-armed unconditionally would push the
        // opening one delay further into the future on every event — a panel that
        // never opens while the pointer is moving inside its own button.
        for (let tick = 0; tick < 5; tick++) {
            pointerOver(button('input'));
            vi.advanceTimersByTime(PART_WAY_MS);
        }

        expect(panel('input').hidden).toBe(false);
        expect(posted).toHaveLength(1);
    });

    it('asks nothing when the row cannot be identified', () => {
        // No run id, no history request. Neither panel opens either, because an
        // empty panel over a row reads as "this workflow has no input" (or result).
        page.row = null;

        pointerOver(button('input'));
        pointerOver(button('outcome'));
        vi.advanceTimersByTime(GRACE_MS);

        expect(posted).toHaveLength(0);
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(0);
    });
});

// ── Rule 4: a late answer does not paint into the panel that replaced it ──────

describe('an answer arriving after its hover is over', () => {
    it('does not paint into the panel a second hover opened', async () => {
        // The generation gate, driven the way a pointer drives it: two rows, two
        // requests in flight, and the FIRST one answers last. Nothing about that
        // answer is malformed — it names the run it was asked about, so invariant 1
        // accepts it. The only thing wrong with it is that its hover is over.
        const second = addSecondButton();

        openPanel('input');
        const first = posted[0]!;

        pointerOver(second.input);
        vi.advanceTimersByTime(GRACE_MS);
        const current = posted[1]!;

        deliver(answerTo(first, { text: 'the row you have already left' }));
        await settled();

        expect(panel('input').textContent).not.toContain('the row you have already left');

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
        openPanel('input');
        const asked = posted[0]!;

        pointerOver(document.querySelector('table')!);
        vi.advanceTimersByTime(GRACE_MS);
        expect(panel('input').hidden).toBe(true);

        deliver(answerTo(asked, { text: 'late, for a panel you closed' }));
        await settled();

        expect(panel('input').hidden).toBe(true);
        expect(panel('input').textContent).not.toContain('late, for a panel you closed');
    });
});

// ── The row itself can change while an answer is in flight ───────────────────
// The generation gate above catches a NEWER hover or a close of OURS
// superseding this one. It says nothing when neither happens and the row
// changes anyway — Temporal's own render pass detaching a button's <tr>, or
// RECYCLING the same connected one to a different workflow, moves neither
// `generation` nor `mine`. matchesCurrentRow() in tooltip.ts is the second,
// independent check that catches exactly that; these three cases are what it
// exists for.

describe('an answer arriving after the row underneath it has changed', () => {
    it('closes the panel rather than paint into a row that is gone', async () => {
        openPanel('input');
        const asked = posted[0]!;

        button('input').closest('tr')!.remove();
        deliver(answerTo(asked, { text: 'for a row no longer on the page' }));
        await settled();

        expect(panel().hidden).toBe(true);
        expect(panel().textContent).not.toContain('for a row no longer on the page');
    });

    it('closes the panel rather than paint beside a row recycled to a different workflow', async () => {
        openPanel('input');
        const asked = posted[0]!;

        // The button and its <tr> stay connected — this is the half of the
        // failure the generation counter cannot see at all, because nothing
        // about it looks like a hover or a close. Only the identity
        // findRow() resolves for this row changes, exactly as a render pass
        // recycling a <tr> to a different workflow would change it.
        page.row = { ...ROW, workflowId: 'recycled-workflow' };
        deliver(answerTo(asked, { text: 'the row you left behind' }));
        await settled();

        expect(panel().hidden).toBe(true);
        expect(panel().textContent).not.toContain('the row you left behind');
    });

    it('positive control: an answer for a row that has not changed still renders', async () => {
        openPanel('input');
        const asked = posted[0]!;

        deliver(answerTo(asked));
        await settled();

        expect(panel('input').hidden).toBe(false);
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });
});

// ── Rule 5: switching it off takes the node, the reference and the text ───────

describe('switching the panel off', () => {
    it('takes the panel off the page, not merely out of the render pass', async () => {
        // The buttons are in the table, so the render pass stops drawing them.
        // The panel is on <body>, where no render pass looks — so before this
        // existed, turning the feature off while a panel was open left a decoded
        // payload sitting on screen underneath a switch that said the feature was off.
        await hoverAndAnswer({}, 'input');
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);

        removePayloadTooltip();

        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(0);
    });

    it('forgets what it had decoded, so switching it back on does not reprint it', async () => {
        // The half a user cannot see, and the reason this is not just `panel.remove()`:
        // the cache holds the decoded payloads themselves. "Off" has to mean the text
        // is gone as well as the node.
        await hoverAndAnswer({}, 'input');
        expect(posted).toHaveLength(1);

        removePayloadTooltip();
        await hoverAndAnswer({}, 'input');

        expect(posted).toHaveLength(2);
    });

    it('drops an answer that arrives after it was switched off', async () => {
        // Nothing can recall a request already sent — the history event was fetched
        // and any codec POST has happened. What this does control is the screen: a
        // reply landing after the switch moved must not reopen the panel or fill it.
        openPanel('input');
        const asked = posted[0]!;

        removePayloadTooltip();
        deliver(answerTo(asked));
        await settled();

        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(0);
    });
});

// ── The same rules, mirrored for the Output panel ─────────────────────────────
// Not a duplicate of every case above: the two kinds run the exact same functions
// parameterized by `kind`, so the risk worth guarding is a copy-paste slip that
// reads or writes the wrong half of `states`, not a second independent bug. One
// case per rule is enough to catch that.

describe('the same rules, for Output', () => {
    it('rule 2: remembers which button the pending Output hover is for', () => {
        const second = addSecondButton({ ...SECOND_ROW, status: 'Completed' });

        pointerOver(button('outcome'));
        vi.advanceTimersByTime(PART_WAY_MS);
        pointerOver(second.output);
        vi.advanceTimersByTime(GRACE_MS);

        expect(posted.map((request) => request.workflowId)).toEqual([SECOND_ROW.workflowId]);
        expect(panel('outcome').hidden).toBe(false);
    });

    it('rule 3: does not close under the pointer', () => {
        openPanel('outcome');

        pointerOver(panel('outcome').querySelector(`.${PANEL_CLASS}-body`)!);
        vi.advanceTimersByTime(GRACE_MS);

        expect(panel('outcome').hidden).toBe(false);
    });

    it('rule 4: a late answer does not paint into a panel closed since', async () => {
        openPanel('outcome');
        const asked = posted[0]!;

        pointerOver(document.querySelector('table')!);
        vi.advanceTimersByTime(GRACE_MS);
        expect(panel('outcome').hidden).toBe(true);

        deliver(answerTo(asked, { text: 'late, for the Output panel you closed' }));
        await settled();

        expect(panel('outcome').textContent).not.toContain('late, for the Output panel you closed');
    });

    it('rule 5: switching off forgets the Output cache too', async () => {
        await hoverAndAnswer({}, 'outcome');
        expect(posted).toHaveLength(1);

        removePayloadTooltip();
        await hoverAndAnswer({}, 'outcome');

        expect(posted).toHaveLength(2);
    });
});

// ── The property that only exists because two buttons share one panel ────────
// See the top-of-file note in src/payloads/tooltip.ts: an earlier version gave
// each kind its own panel, on the theory that a reader comparing input to
// result wants both open at once. In practice the two buttons sit a few pixels
// apart, so two panels anchored under them mostly cover each other. Hovering
// the other kind now replaces what the one panel is showing.

describe('hovering the other kind replaces the panel, it does not add a second one', () => {
    it('opening one does not request the other', () => {
        openPanel('input');

        expect(posted).toHaveLength(1);
        expect(posted[0]!.kind).toBe('input');
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);
    });

    it('hovering Output after Input replaces the one panel rather than opening a second', async () => {
        await hoverAndAnswer({}, 'input');
        expect(section().body.textContent).toBe(`text for input of ${ROW.workflowId}`);

        await hoverAndAnswer({}, 'outcome');

        // One panel node throughout, not two overlapping ones.
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);
        expect(panel('outcome').hidden).toBe(false);
        expect(section('outcome').body.textContent).toBe(`text for outcome of ${ROW.workflowId}`);
        expect(posted.map((request) => request.kind)).toEqual(['input', 'outcome']);
    });

    it('a late answer for the kind the panel used to show does not paint over the kind it now shows', async () => {
        // Rule 4 still applies across a kind switch, not only across two hovers of
        // the same kind: the generation counter is shared by both buttons (see the
        // top-of-file note), so replacing Input with Output is exactly the kind of
        // "this hover is over" that rule exists to catch.
        openPanel('input');
        const staleRequest = posted[0]!;

        openPanel('outcome');
        const currentRequest = posted[1]!;

        deliver(answerTo(staleRequest, { text: 'the input you have since replaced with Output' }));
        await settled();
        expect(panel('outcome').textContent).not.toContain('the input you have since replaced with Output');

        deliver(answerTo(currentRequest));
        await settled();
        expect(section('outcome').body.textContent).toBe(`text for outcome of ${ROW.workflowId}`);
    });

    it('hovering Input again while Output is showing switches the panel back', () => {
        openPanel('outcome');

        openPanel('input');

        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);
        expect(panel('input').hidden).toBe(false);
    });

    it('Escape closes the one panel regardless of which kind it is showing', () => {
        openPanel('outcome');

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(panel().hidden).toBe(true);
    });

    // The body's `resize: both` (content.css) is native: a manual drag sets
    // `width`/`height` directly on the element, and the same element is reused
    // by every hover (ensurePanel()). Without a reset, one drag on either
    // button, on any row, would make every later hover open at that dragged
    // size for the rest of the page's life.
    it('a manual resize on one hover does not carry over to the next hover', async () => {
        openPanel('input');
        const draggedBody = panel('input').querySelector<HTMLElement>(`.${PANEL_CLASS}-body`)!;
        draggedBody.style.width = '900px';
        draggedBody.style.height = '700px';

        openPanel('outcome');

        const body = panel('outcome').querySelector<HTMLElement>(`.${PANEL_CLASS}-body`)!;
        expect(body.style.width).toBe('');
        expect(body.style.height).toBe('');
    });

    it('a manual resize does not carry over even when the next hover is the same kind again', async () => {
        openPanel('input');
        const draggedBody = panel('input').querySelector<HTMLElement>(`.${PANEL_CLASS}-body`)!;
        draggedBody.style.width = '900px';
        draggedBody.style.height = '700px';

        openPanel('outcome');
        openPanel('input');

        const body = panel('input').querySelector<HTMLElement>(`.${PANEL_CLASS}-body`)!;
        expect(body.style.width).toBe('');
        expect(body.style.height).toBe('');
    });

    // The title/heading-row half of the same carryover, one level up: ensurePanel()'s
    // width observer (untestable here — see tooltipResizeObserver.spec.ts) sets an
    // inline max-width to match the body's width as of whenever it last fired, which
    // is stale until that observer reacts to the reset above. openNow() clears it
    // directly for exactly the reason it clears body's width/height: without it, the
    // FIRST placement of a new hover would measure the title against a width left
    // over from a reader who had the previous hover's body dragged wide. jsdom's
    // layout is always zero, so a real drag cannot be reproduced here — set directly,
    // the same way the two specs above set body's width/height directly.
    it('clears a stale title/heading-row max-width from a previous hover before the next placement', () => {
        openPanel('input');
        const titleLine = panel('input').querySelector<HTMLElement>(`.${PANEL_CLASS}-title`)!;
        const headingRow = panel('input').querySelector<HTMLElement>(`.${PANEL_CLASS}-heading-row`)!;
        titleLine.style.maxWidth = '900px';
        headingRow.style.maxWidth = '900px';

        openPanel('outcome');

        expect(titleLine.style.maxWidth).toBe('');
        expect(headingRow.style.maxWidth).toBe('');
    });
});

// ── The Copy button ─────────────────────────────────────────────────────────

describe('Copy button', () => {
    function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        return { writeText };
    }

    it('copies exactly what the body is showing, not a fetch or a re-render of its own', async () => {
        const { writeText } = stubClipboard();
        await hoverAndAnswer();
        const { body } = section('input');

        panel('input').querySelector<HTMLButtonElement>(`.${PANEL_CLASS}-copy`)!.click();
        await settled();

        expect(writeText).toHaveBeenCalledWith(body.textContent);
    });

    it('is a click inside the panel, so it does not close the panel it is in', async () => {
        stubClipboard();
        await hoverAndAnswer();

        panel('input').querySelector<HTMLButtonElement>(`.${PANEL_CLASS}-copy`)!.click();
        await settled();

        expect(panel('input').hidden).toBe(false);
    });

    it('says "Copied" for a moment after a successful copy, then reverts', async () => {
        stubClipboard();
        await hoverAndAnswer();
        const copyButton = panel('input').querySelector<HTMLButtonElement>(`.${PANEL_CLASS}-copy`)!;

        copyButton.click();
        await settled();
        expect(copyButton.textContent).toBe('Copied');

        vi.advanceTimersByTime(GRACE_MS * 10);
        expect(copyButton.textContent).toBe('Copy');
    });

    it('says "Failed" rather than swallowing a clipboard refusal silently', async () => {
        // Clipboard access can be refused outside a user gesture or on an
        // insecure origin — see the comment in copyBodyText(). Silently doing
        // nothing reads as a broken button; this is what tells the reader why
        // nothing landed on their clipboard.
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
            configurable: true,
        });
        await hoverAndAnswer();
        const copyButton = panel('input').querySelector<HTMLButtonElement>(`.${PANEL_CLASS}-copy`)!;

        copyButton.click();
        await settled();

        expect(copyButton.textContent).toBe('Failed');
    });

    it('does not label the panel for a copy whose clipboard promise resolves after the panel has moved to the other kind', async () => {
        let resolveWrite: (() => void) | null = null;
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                writeText: vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; })),
            },
            configurable: true,
        });
        await hoverAndAnswer({}, 'input');
        const copyButton = panel('input').querySelector<HTMLButtonElement>(`.${PANEL_CLASS}-copy`)!;

        copyButton.click();
        await settled();
        // The clipboard promise has not resolved yet, so no feedback has shown.
        expect(copyButton.textContent).toBe('Copy');

        // The SAME button: switching kinds before the copy resolves is a new
        // generation on the one panel, not a second button to confuse with this one.
        await hoverAndAnswer({}, 'outcome');
        expect(copyButton.textContent).toBe('Copy');

        resolveWrite!();
        await settled();

        // A copy that belonged to Input must not paint "Copied" over a panel
        // that has since moved on to Output.
        expect(copyButton.textContent).toBe('Copy');
    });
});

// ── Rule 3, extended: placement is recomputed once real content exists ───────

describe('the panel is placed again once its real content is in', () => {
    it('re-measures the panel after the payload replaces the loading placeholder', async () => {
        const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');

        await hoverAndAnswer();

        // Once while showing "Loading…" — so an empty panel is at least clamped
        // into the viewport before anything is known about its real size — and
        // once again after the payload replaced it. A payload can be a very
        // different size than the placeholder, and placing the panel only the
        // first time would leave its final geometry stale near a viewport edge.
        // jsdom's rects are always zero-sized, so this pins that placement RAN
        // again, not what it computed — the pixel-accurate claim needs a real
        // browser, per the review this guards against.
        const panelMeasurements = rectSpy.mock.instances.filter((instance) => instance === panel()).length;
        expect(panelMeasurements).toBeGreaterThanOrEqual(2);
    });
});

// ── Rule 5: the JSON viewer is wired into the panel, not only tested alone ───

describe('the JSON viewer is wired into the panel', () => {
    it('renders a JSON result as the highlighted view, not as its own plain text', async () => {
        await hoverAndAnswer({ text: '{"account":12345678}' });

        const jsonView = section().body.querySelector(`.${JSON_VIEW_CLASS}`);
        expect(jsonView).not.toBeNull();
        expect(jsonView!.querySelector('.tuis-json-key')!.textContent).toBe('"account"');
        expect(jsonView!.querySelector('.tuis-json-number')!.textContent).toBe('12345678');
    });

    it('falls back to plain text in the panel for a result that is not valid JSON', async () => {
        await hoverAndAnswer({ text: 'not json at all' });

        const body = section().body;
        expect(body.querySelector(`.${JSON_VIEW_CLASS}`)).toBeNull();
        expect(body.querySelector(`.${JSON_FALLBACK_CLASS}`)).not.toBeNull();
        expect(body.textContent).toBe('not json at all');
    });

    it('renders a result past the historical 20,000-character clip as the highlighted view in the real panel', async () => {
        // apiInjectPayloadDisplay.spec.ts proves a payload this size reaches the
        // panel unclipped through the message-passing path; this proves the other
        // half — that once it arrives, THIS panel's own replaceChildren() draws it
        // as a tree, not the plain-text fallback a smaller, un-coordinated clip
        // used to force it into. See "The clip underneath the cap" in
        // docs/design-notes.md.
        const items: unknown[] = [];
        let text = '[]';
        let i = 0;
        while (text.length < 30_000) {
            items.push({ proposalId: `PROP-${i}`, amount: { value: 1000 + i, currency: 'USD' } });
            text = JSON.stringify(items);
            i++;
        }

        await hoverAndAnswer({ text });

        const body = section().body;
        const jsonView = body.querySelector(`.${JSON_VIEW_CLASS}`);
        expect(jsonView).not.toBeNull();
        expect(body.querySelector(`.${JSON_FALLBACK_CLASS}`)).toBeNull();
        expect(jsonView!.textContent).toContain('PROP-0');
    });
});

// ── Rule 6: interactive content is not exposed as an ARIA tooltip ────────────

describe('the panel is not an ARIA tooltip', () => {
    it('uses role="group", named by its own title line, not role="tooltip"', () => {
        openPanel();

        // An ARIA tooltip is non-interactive descriptive content; this panel
        // contains a focusable Copy button, so role="tooltip" would misreport it
        // to assistive tech.
        expect(panel().getAttribute('role')).toBe('group');
        const titleLine = panel().querySelector(`.${PANEL_CLASS}-title`)!;
        expect(panel().getAttribute('aria-labelledby')).toBe(titleLine.id);
        expect(titleLine.id).not.toBe('');
    });

    it('a click on the trigger moves focus onto the Copy button', () => {
        button('input').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        vi.advanceTimersByTime(GRACE_MS);

        expect(document.activeElement).toBe(panel('input').querySelector(`.${PANEL_CLASS}-copy`));
    });

    it('Escape returns focus to the trigger when focus was left on Copy inside the panel', () => {
        const trigger = button('input');
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        vi.advanceTimersByTime(GRACE_MS);
        expect(document.activeElement).toBe(panel('input').querySelector(`.${PANEL_CLASS}-copy`));

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        expect(panel().hidden).toBe(true);
        expect(document.activeElement).toBe(trigger);
    });

    it('a plain Tab landing on the trigger opens the panel but does not steal focus onto Copy', () => {
        // Symmetric with the rule that a pointer hover must not steal focus: Tab
        // merely landing on the button is not an explicit request to jump into
        // the panel the way a click or an Enter/Space activation is. Only the
        // click handler ever calls copyButton.focus() — see the test above.
        button('input').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

        expect(panel('input').hidden).toBe(false);
        expect(document.activeElement).not.toBe(panel('input').querySelector(`.${PANEL_CLASS}-copy`));
    });
});
