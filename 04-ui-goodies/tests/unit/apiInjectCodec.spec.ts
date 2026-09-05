// @vitest-environment jsdom
//
// The one path in this repository that sends anything to a server the extension was
// told about rather than one the page was already talking to.
//
// Every assertion here is about what does NOT leave: a payload the browser can
// already read never reaches the codec endpoint, the request carries no ambient
// credential, and an endpoint the settings did not name is not called at all. The
// endpoint comes from the popup, so it is user-supplied — which is exactly why the
// egress it authorises is asserted rather than described.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type PayloadRequest } from '../../src/payloads/payloadMessages';
import {
    BEARER,
    ENCRYPTED_INPUT_BODY,
    INPUT_BODY,
    LIST_URL,
    askPayload,
    b64,
    decodeCalls,
    fake,
    forwardCalls,
    installApiInjectHarness,
    reachedNetwork,
    teardownApiInjectHarness,
} from '../apiInjectHarness';

beforeEach(installApiInjectHarness);
afterEach(teardownApiInjectHarness);

// ── The codec request ────────────────────────────────────────────────────────
//
// This is the only place in this repository where data can leave the machine, and
// the endpoint field is the only thing that can make it happen. NOTHING can make it
// carry a credential — not a header, and not a cookie the browser would attach on
// its own. Every half is asserted from the outside here, from what reached the fake
// network: the URL, the Authorization header, the BODY, and `credentials`. That is
// the claim the README and the popup make, and a claim about egress asserted from
// the inside is worth nothing.
//
// Watch for vacuous greens in this block. Most of the assertions are "N calls to
// nowhere", which is also what a hover that died early produces, so each one is
// paired with evidence that the hover really ran — usually the authenticated history
// call in the same round trip.
describe('sending an encrypted payload to the codec server in the popup', () => {
    const TYPED = 'https://codec.example.com';
    const via = (endpoint: string) => ({ codec: { endpoint } });

    beforeEach(async () => {
        fake.forwardHistoryBody = ENCRYPTED_INPUT_BODY;
        await window.fetch(LIST_URL, { headers: { authorization: BEARER } });
    });

    it('decodes through the typed endpoint and names the host it used', async () => {
        const result = await askPayload(via(TYPED));

        expect(result.error).toBeNull();
        expect(result.text).toContain('decrypted');
        expect(decodeCalls().map((seen) => seen.url)).toEqual([`${TYPED}/decode`]);
        // The panel is the only place this host is ever shown, and showing it is how
        // a user finds out that a hover went off their machine.
        expect(result.decodedBy).toBe('codec.example.com');
    });

    it('never sends a credential of any kind, and no request can ask it to', async () => {
        // BOTH of these were ticked boxes in the popup until the message bus was looked
        // at as a trust boundary. The endpoint arrives IN the request, so a box that
        // attached the bearer meant one forged message could send a live credential to
        // a host of the sender's choosing — and "send cookies" is the same hole with
        // the browser doing the attaching. Both were DELETED rather than defaulted off,
        // which is the property this test pins: the request below asks for them in the
        // old shape, with the cookie flag set to TRUE, and is simply ignored.
        //
        // A default-off flag would pass an assertion about the header. Only a deleted
        // parameter passes this one.
        const asOldBuildsWouldSay = {
            endpoint: TYPED,
            includeCredentials: true,
            passToken: true,
        } as unknown as PayloadRequest['codec'];

        const result = await askPayload({ codec: asOldBuildsWouldSay });

        expect(result.error).toBeNull();
        // The bearer WAS available — it went on the history request in the same hover
        // — so this is a decision, not an accident of the fixture.
        expect(forwardCalls()[0]!.authorization).toBe(BEARER);
        expect(decodeCalls()).toHaveLength(1);
        expect(decodeCalls()[0]!.authorization).toBeNull();
        // And no ambient credential either. The forged flag said include; what reached
        // the network says omit. A header-only assertion cannot see this at all, which
        // is why `credentials` is recorded — see the note on Seen.
        expect(decodeCalls()[0]!.credentials).toBe('omit');
    });

    it('refuses a credential handed straight to the boundary, not only one asked for in a message', async () => {
        // Every other test in this block goes through the message bus, so all of them
        // together assert what THIS build's codec path sends. That is a weaker claim
        // than the README makes: the sentence is "no credential can reach a
        // caller-chosen host", and the next feature to post to one will not go through
        // payloadServe.ts. So this one skips the bus and calls the boundary the way a
        // future caller would — same module instance the scripts above are using,
        // because loadMainWorldScripts() imported it and vi.resetModules() has run.
        const { fetchFromPageWorld } = await import('../../src/page/pageApi');

        // The honest call. `credentials` is not a field it can pass, so 'omit' here is
        // the function's own doing and not the caller's good manners.
        await fetchFromPageWorld(`${TYPED}/decode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{"payloads":[]}',
        });
        expect(decodeCalls()).toHaveLength(1);
        expect(decodeCalls()[0]!.credentials).toBe('omit');

        // The other route, and the one the type cannot close: a header. It type-checks
        // — `headers` is a plain string map, and no cast is needed below, which is
        // exactly why the check exists at run time.
        await expect(
            fetchFromPageWorld(`${TYPED}/decode`, {
                method: 'POST',
                headers: { Authorization: BEARER },
                body: '{"payloads":[]}',
            }),
        ).rejects.toThrow(/Authorization/);
        // Refused BEFORE the request, not filtered on the way out: a second call
        // reaching the network with the header stripped would also satisfy the
        // rejection above.
        expect(decodeCalls()).toHaveLength(1);
    });

    it('sends only the payloads it cannot read, and not the readable ones beside them', async () => {
        // One argument in plaintext, one encrypted. The whole array used to be posted
        // whenever ANY member of it needed a codec, so a customer record sitting next
        // to a ciphertext left the browser for no reason at all.
        fake.forwardHistoryBody = {
            history: {
                events: [
                    {
                        eventId: '1',
                        workflowExecutionStartedEventAttributes: {
                            input: {
                                payloads: [
                                    { metadata: { encoding: b64('json/plain') }, data: b64('"stays-here"') },
                                    { metadata: { encoding: b64('binary/encrypted') }, data: b64('opaque') },
                                ],
                            },
                        },
                    },
                ],
            },
        };

        const result = await askPayload(via(TYPED));

        expect(result.error).toBeNull();
        expect(decodeCalls()).toHaveLength(1);
        const sent = JSON.parse(decodeCalls()[0]!.body!) as { payloads: unknown[] };
        expect(sent.payloads).toHaveLength(1);
        // The assertion that matters: the readable one is nowhere in the body, in any
        // encoding of it.
        expect(decodeCalls()[0]!.body).not.toContain(b64('"stays-here"'));
        expect(decodeCalls()[0]!.body).not.toContain('stays-here');
        // And the answer came back into the slot it was taken from, rather than
        // shifting the array by one.
        expect(result.text.indexOf('stays-here')).toBeGreaterThan(-1);
        expect(result.text.indexOf('stays-here')).toBeLessThan(result.text.indexOf('decrypted'));
    });

    it('sends nothing anywhere with an empty endpoint', async () => {
        const result = await askPayload(via(''));

        expect(decodeCalls()).toHaveLength(0);
        expect(result.decodedBy).toBeNull();
        // And it says so in place, per payload, rather than looking empty — an empty
        // panel reads as a broken extension, which is how a user ends up reloading
        // the tab instead of filling in the setting.
        expect(result.text).toContain('binary/encrypted');
        expect(result.text).toContain('Set a codec server in the popup');
    });

    it('makes no codec request when every payload is readable', async () => {
        // The endpoint being set is not enough: a json/plain payload is decoded in the
        // browser and must cost no request at all. Otherwise filling the box in once
        // turns every later hover into egress.
        fake.forwardHistoryBody = INPUT_BODY;

        const result = await askPayload(via(TYPED));

        expect(result.text).toContain('hello');
        expect(decodeCalls()).toHaveLength(0);
        expect(result.decodedBy).toBeNull();
    });

    it('ignores an endpoint that would put decrypted data on the wire', async () => {
        // http, off this machine. The popup says the same thing in the same words;
        // this is the half that holds when the setting was written by storage sync or
        // by an older build rather than typed into the field.
        //
        // The two `toHaveLength(0)` lines below are the kind of assertion that passes
        // when NOTHING happened at all — a hover that failed before it reached the
        // codec decision would satisfy both. So the hover is proved to have run: the
        // history event was fetched with the page's bearer, the answer came back
        // without an error, and the panel says in place that no codec server is
        // configured. Only then does "no decode call" mean the endpoint was refused.
        const result = await askPayload(via('http://codec.example.com'));

        expect(result.error).toBeNull();
        expect(forwardCalls()).toHaveLength(1);
        expect(forwardCalls()[0]!.authorization).toBe(BEARER);
        expect(result.text).toContain('Set a codec server in the popup');

        expect(decodeCalls()).toHaveLength(0);
        expect(result.decodedBy).toBeNull();
        // Not "no request to that host" — no request to ANY host. A near-miss in the
        // safety check (localhost.example.com) would show up here as a call to
        // somewhere unexpected rather than as no call at all.
        expect(reachedNetwork.filter((seen) => seen.url.includes('codec'))).toHaveLength(0);
    });

    it('says a malformed history could not be read, rather than showing an empty panel', async () => {
        // THE PANEL IS ALREADY OPEN BY THE TIME THIS IS DECIDED, which is what the pure
        // extractor's first version got wrong: it returned no payloads for a history it
        // could not read, and render() turns no payloads and no note into
        // "(nothing recorded)" — the same words a workflow started with no arguments
        // gets. Asserted here rather than only in payloads.spec.ts because the claim is
        // about what the reader sees, and the extractor cannot see that far.
        fake.forwardHistoryBody = {
            history: {
                events: [
                    {
                        eventId: '1',
                        workflowExecutionStartedEventAttributes: { input: { payloads: [{ data: {} }] } },
                    },
                ],
            },
        };

        const result = await askPayload(via(TYPED));

        expect(result.error).toMatch(/cannot read/);
        expect(result.text).not.toContain('nothing recorded');
        // And nothing was sent anywhere on the way to failing. A response whose shape is
        // not the documented one is the last thing to forward to a host named in a
        // message: planCodecCall reads `metadata.encoding` to decide what leaves, and it
        // never got the chance to read this one.
        expect(decodeCalls()).toHaveLength(0);
        // Paired with evidence the hover really ran, so the line above is not the vacuous
        // green a hover that died earlier would also produce.
        expect(forwardCalls()).toHaveLength(1);
        expect(forwardCalls()[0]!.authorization).toBe(BEARER);
    });

    it('says the same about a payload container that is not a message at all', async () => {
        // The same claim one level up the response, and a separate test because the first
        // fix for the case above passed that one while still failing this one: it looked
        // inside the container for a malformed LIST, so a container that was not an object
        // never reached the check and `input: "bad"` was reported as "(nothing recorded)"
        // by this very path. The panel is the only place that distinction is visible,
        // which is why it is pinned here and not only in payloads.spec.ts.
        fake.forwardHistoryBody = {
            history: { events: [{ eventId: '1', workflowExecutionStartedEventAttributes: { input: 'bad' } }] },
        };

        const result = await askPayload(via(TYPED));

        expect(result.error).toMatch(/cannot read/);
        expect(result.text).not.toContain('nothing recorded');
        expect(decodeCalls()).toHaveLength(0);
        expect(forwardCalls()).toHaveLength(1);
        expect(forwardCalls()[0]!.authorization).toBe(BEARER);
    });

    it('will not send a payload for a run the page never listed', async () => {
        // The residual weakness, bounded — and bounded is not the same as small, which
        // is why the note in payloadServe.ts states the width instead of this test's
        // happier half. A forged message CAN name a codec host of its choosing, and can
        // do it for any run the page has ever listed in this tab, with no gesture.
        //
        // What the ledger buys is the line this test draws: a run the page never listed
        // cannot be asked about at all, so this is not an arbitrary-history read.
        // Nothing is fetched, so there is nothing to forward either.
        const result = await askPayload({ ...via(TYPED), runId: '00000000-0000-4000-8000-00000000dead' });

        expect(result.error).toMatch(/not in a workflow list this page has loaded/);
        expect(decodeCalls()).toHaveLength(0);
        expect(forwardCalls()).toHaveLength(0);
    });
});
