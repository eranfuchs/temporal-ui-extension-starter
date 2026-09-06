// @vitest-environment jsdom
//
// src/payloads/payloadClient.ts — WHICH ANSWER MAY BE BELIEVED. One spec section per invariant
// at the top of that file: an answer names the question it answers (1), one question is
// one request (2), an answer never outlives the setting it was decoded under (3), and a
// request that never comes back still answers (4).
//
// The five rules about the element and the gesture are tooltip.ts's, and their specs are
// in tooltip.spec.ts. Both files drive the same installed panel through
// tests/tooltipHarness.ts.
//
// DRIVEN THROUGH THE PANEL, NOT THROUGH requestPayload() DIRECTLY, and that is the
// point: the client's job is to keep a wrong answer off the screen, so the assertion
// worth making is about what is on the screen. Invariant 1 in particular fails in a way
// that looks like nothing at all — a panel captioned with this workflow's id, showing
// another workflow's decrypted input — so a spec that only checked a return value would
// leave the interesting half untested.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    GRACE_MS,
    NAMESPACE,
    ROW,
    RUNNING_ROW,
    RUN_ID,
    answerTo,
    button,
    deliver,
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
} from '../tooltipHarness';
import { MAX_CACHED_PAYLOAD_CHARS, MAX_CACHED_PAYLOADS, REQUEST_TIMEOUT_MS } from '../../src/payloads/payloadClient';
import { PANEL_CLASS } from '../../src/decoration';
import { resetPayloadState } from '../../src/payloads/tooltip';
import { MESSAGE_SOURCE } from '../../src/types';
import { fakeRunId } from '../helpers';

beforeAll(installHarness);
beforeEach(resetHarness);

// ── Invariant 1: an answer has to name the question it answers ───────────────
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
        // payloadResultSchema describes the leaves. This is the spec that says its CALL
        // SITE is load-bearing, and it is asserted through the panel because that is
        // where the wrong thing would appear. The schema's own truth table is in
        // tests/unit/payloadMessages.spec.ts.
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

// ── Invariant 2: one question is one request ─────────────────────────────────

describe('asking once', () => {
    it('asks once when a click on the button also fires focusin', async () => {
        // A real click on the `{ }` button fires focusin AND click, and both open the
        // panel. The cache cannot help: it is still empty while the first request is in
        // flight, so each entry point found nothing, posted its own message and waited
        // for its own reply. Two history events for one click — and, with a codec server
        // configured, two copies of the same payload leaving the machine.
        page.row = RUNNING_ROW;

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

    it('does not let a settling request cancel the join for the one that replaced it', async () => {
        // Invariant 2 across a settings change. A → reset → B for the same key → A
        // settles. A's cleanup used to delete whatever the key held, which by then was
        // B, so C posted a third request instead of joining B for free. Nothing about it
        // looks wrong on screen; it is visible only as request count.
        page.row = RUNNING_ROW;
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
});

// ── Invariant 3: an answer never outlives the setting it was decoded under ───
//
// The cache is also the ordinary "do not ask twice" cache, so the first specs here
// are about what it is allowed to KEEP and the rest are about what a reset has to
// take away from it.

describe('caching answers', () => {
    it('does not ask twice about the same run', async () => {
        page.row = RUNNING_ROW;
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
        page.row = RUNNING_ROW;
        await hoverAndAnswer();

        page.namespace = 'another-namespace';
        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
        expect(posted[1]!.namespace).toBe('another-namespace');
    });

    it('does not cache an error, because it is usually a setting about to be fixed', async () => {
        page.row = RUNNING_ROW;
        await hoverAndAnswer({ error: 'No codec server configured.', text: '', label: '' });

        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('forgets everything when the codec settings change', async () => {
        // Configuring a codec server has to make the panel re-ask, or the answer
        // that says "not decoded here" is the answer forever and the setting looks
        // like it did nothing.
        page.row = RUNNING_ROW;
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
        page.row = RUNNING_ROW;
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
        page.row = RUNNING_ROW;
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

    it('erases an answer that had already finished rendering before the reset', async () => {
        // THE THIRD HOLDER, and the one the two specs above do not cover: both of them
        // reset while the answer was still IN FLIGHT, so the text never reached the DOM
        // and "holding nothing from the old setting" was cheap to satisfy. The case a
        // user actually hits is the opposite one — they read a decoded payload, THEN
        // change the codec endpoint — and for that one close() was the whole response,
        // which sets `hidden` and leaves every character in place.
        //
        // It matters because this panel is on document.body, in the DOM the page shares
        // with us: an ISOLATED world gets its own JS heap, not its own document. Hidden
        // decrypted text is still text any script in the page can read.
        page.row = RUNNING_ROW;
        await hoverAndAnswer({ text: 'account 12345678 · decoded by the old server' });
        expect(panel().textContent).toContain('account 12345678');

        resetPayloadState();

        expect(panel().hidden).toBe(true);
        expect(panel().textContent).not.toContain('account 12345678');
        expect(section('input').body.textContent).toBe('');

        // There is exactly one panel node on the page — the one Input and Output
        // share — and it is the one just erased, not a second node holding a stale
        // answer of its own. See the top-of-file note in src/payloads/tooltip.ts.
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);
    });

    it('is bounded, because what it holds is decoded personal data', async () => {
        // The per-row cache is bounded for memory. This one is bounded for memory
        // AND because its values are the payloads themselves: a tab left open all
        // afternoon would otherwise hold every customer record its owner had
        // glanced at, long after the panel closed.
        page.row = RUNNING_ROW;
        for (let index = 0; index < MAX_CACHED_PAYLOADS; index++) {
            page.row = { ...RUNNING_ROW, runId: fakeRunId(1_000 + index) };
            await hoverAndAnswer();
        }
        expect(posted).toHaveLength(MAX_CACHED_PAYLOADS);

        // Still cached at the limit: eviction has not happened yet.
        page.row = { ...RUNNING_ROW, runId: fakeRunId(1_000) };
        await hoverAndAnswer();
        expect(posted).toHaveLength(MAX_CACHED_PAYLOADS);

        // One more distinct run tips it over, and the whole map goes — so the run
        // that was cached first has to be asked about again.
        page.row = { ...RUNNING_ROW, runId: fakeRunId(2_000) };
        await hoverAndAnswer();
        page.row = { ...RUNNING_ROW, runId: fakeRunId(1_000) };
        await hoverAndAnswer();

        // Two requests beyond the loop: the run that tipped the map over, and the
        // re-ask for the run that was evicted with it.
        expect(posted).toHaveLength(MAX_CACHED_PAYLOADS + 2);
    });

    it('also evicts by total retained size, so a handful of large answers cannot dwarf the count limit', async () => {
        // MAX_DISPLAY_CHARS (payloads.ts) bounds one answer at up to 2,000,000
        // characters — a size at which the count-only bound above would let
        // MAX_CACHED_PAYLOADS of them (200) accumulate before evicting anything.
        // Two answers each half of MAX_CACHED_PAYLOAD_CHARS is enough to exercise
        // the size trigger at a small fraction of that count.
        const big = 'x'.repeat(Math.floor(MAX_CACHED_PAYLOAD_CHARS / 2));

        page.row = { ...RUNNING_ROW, runId: fakeRunId(3_000) };
        await hoverAndAnswer({ text: big });
        expect(posted).toHaveLength(1);

        // Still cached: one more of these exactly fills the budget, not exceeds it.
        page.row = { ...RUNNING_ROW, runId: fakeRunId(3_001) };
        await hoverAndAnswer({ text: big });
        expect(posted).toHaveLength(2);

        // Both still cached at the size limit.
        page.row = { ...RUNNING_ROW, runId: fakeRunId(3_000) };
        await hoverAndAnswer({ text: big });
        expect(posted).toHaveLength(2);

        // A THIRD one this size tips the total over the budget at only 3 entries —
        // nowhere near MAX_CACHED_PAYLOADS — so the whole map is cleared and the
        // first run has to be asked about again.
        page.row = { ...RUNNING_ROW, runId: fakeRunId(3_002) };
        await hoverAndAnswer({ text: big });
        expect(posted).toHaveLength(3);
        page.row = { ...RUNNING_ROW, runId: fakeRunId(3_000) };
        await hoverAndAnswer({ text: big });
        expect(posted).toHaveLength(4);
    });

    it('does not cache a single result already bigger than the whole size budget', async () => {
        // The formatter (payloads.ts) normally clips well under this, but
        // `text` is only validated as a string, so a page-world response that
        // does not go through that formatter — malformed or forged — is not
        // guaranteed to. Caching it anyway would put the cache over its own
        // declared bound on the very first insert.
        const huge = 'x'.repeat(MAX_CACHED_PAYLOAD_CHARS + 1);
        page.row = { ...RUNNING_ROW, runId: fakeRunId(3_100) };

        await hoverAndAnswer({ text: huge });
        expect(posted).toHaveLength(1);
        expect(section('input').body.textContent).toBe(huge);

        // Not cached: the same run is asked about again rather than served
        // from a cache entry that should not exist.
        await hoverAndAnswer({ text: huge });
        expect(posted).toHaveLength(2);
    });
});

// ── Invariant 4: a request that never comes back still answers ───────────────

describe('a question nobody answers', () => {
    it('says so in the panel instead of reading Loading… for ever', async () => {
        // The MAIN-world script can be absent entirely: an older build of the
        // extension, or a page it never ran on. Nothing rejects — the request is
        // posted into a page where nothing is listening, so the only thing that can
        // end it is the clock.
        page.row = RUNNING_ROW;
        openPanel();
        expect(section('input').body.textContent).toBe('Loading…');

        vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
        await settled();

        // Rendered as an error, because rendering `error` is the panel's only way to
        // say "this did not work" — and it names the recovery, since a reload is what
        // gets the MAIN-world script in place.
        expect(section('input').body.textContent).toContain('⚠');
        expect(section('input').body.textContent).toContain('Reload the tab.');
    });

    it('does not time out a question that was answered in time', async () => {
        // The negative control: without it, a timeout that fired unconditionally
        // would pass the spec above and overwrite every real answer a moment later.
        page.row = RUNNING_ROW;
        await hoverAndAnswer();
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);

        vi.advanceTimersByTime(REQUEST_TIMEOUT_MS * 2);
        await settled();

        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });

    it('is not cached, so hovering again asks again', async () => {
        // A timeout arrives with `error` set, and errors are not cached. Caching one
        // would make a single missing-script moment permanent for the tab.
        page.row = RUNNING_ROW;
        openPanel();
        vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
        await settled();
        expect(posted).toHaveLength(1);

        await hoverAndAnswer();

        expect(posted).toHaveLength(2);
        expect(section('input').body.textContent).toBe(`text for input of ${ROW.workflowId}`);
    });
});
