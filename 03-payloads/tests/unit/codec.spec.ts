// src/payloads/codec.ts — the one request in this repository that leaves the browser for a
// host the user named.
//
// EVERY SPEC IN THIS FILE IS ABOUT EGRESS: which endpoints may be used, what is
// sent to one, and what is believed of the answer. That is why it is a file of its
// own rather than a section of payloads.spec.ts — "what can this extension send, and
// where?" should be answerable by reading one source file and one spec file.
//
// Two of the failure modes here produce confident wrong output rather than an error,
// which is the only kind worth a test this long:
//   • an endpoint carrying a query string sent the POST somewhere a server ANSWERS,
//     wrongly;
//   • a codec server returning the wrong number of payloads would relabel decrypted
//     data instead of failing.

import { describe, expect, it } from 'vitest';

import {
    codecDecodeCall,
    mergeDecoded,
    planCodecCall,
    readCodecResponse,
    safeCodecEndpoint,
} from '../../src/payloads/codec';
import { payload } from '../payloadFixtures';

describe('safeCodecEndpoint', () => {
    it('accepts https anywhere', () => {
        expect(safeCodecEndpoint('https://codec.example.com')).toBe('https://codec.example.com');
        expect(safeCodecEndpoint('  https://codec.example.com/base/  ')).toBe('https://codec.example.com/base');
    });

    it('accepts plain http only on this machine', () => {
        expect(safeCodecEndpoint('http://localhost:8081')).toBe('http://localhost:8081');
        expect(safeCodecEndpoint('http://127.0.0.1:8081')).toBe('http://127.0.0.1:8081');
    });

    it('rejects plain http to anywhere else', () => {
        // A codec server hands back DECRYPTED data. This is the rule that keeps
        // it off the wire in the clear.
        expect(safeCodecEndpoint('http://codec.example.com')).toBeNull();
        // Near-misses, which is where a hostname check written with `includes`
        // or `startsWith` would let a remote host through.
        expect(safeCodecEndpoint('http://localhost.example.com')).toBeNull();
        expect(safeCodecEndpoint('http://127.0.0.1.example.com')).toBeNull();
    });

    it('rejects everything that is not an absolute http(s) URL', () => {
        for (const bad of [
            '',
            '   ',
            'codec.example.com',
            '/decode',
            'javascript:alert(1)',
            'ftp://codec.example.com/y',
        ]) {
            expect(safeCodecEndpoint(bad)).toBeNull();
        }
    });

    it('rejects a query or a fragment, because /decode is appended to a PATH', () => {
        // The bug this pins is not a rejection that was missing — it is a request
        // that went to the wrong place and got an answer. codecDecodeCall() appends
        // `/decode`, so an accepted `…/base?tenant=a` produced a POST to `/base`
        // with `tenant=a/decode` in the query: a plausible URL, a real response, and
        // the wrong endpoint. A `#fragment` is not even sent to the server.
        expect(safeCodecEndpoint('https://codec.example.com/base?tenant=a')).toBeNull();
        expect(safeCodecEndpoint('https://codec.example.com/base#frag')).toBeNull();
        expect(safeCodecEndpoint('http://localhost:8081/?x=1')).toBeNull();
        // A BARE DELIMITER IS THE CASE THE FIRST VERSION MISSED, and it is the one a
        // person actually types, by pasting a URL out of an address bar. The URL API
        // reports search === '' and hash === '' for all four of these, so `if
        // (parsed.search || parsed.hash)` let every one of them through and built
        // `https://codec.example.com/?/decode`: /decode in the query, path still `/`.
        expect(safeCodecEndpoint('https://codec.example.com/?')).toBeNull();
        expect(safeCodecEndpoint('https://codec.example.com/#')).toBeNull();
        expect(safeCodecEndpoint('https://codec.example.com/base?')).toBeNull();
        expect(safeCodecEndpoint('https://codec.example.com/base#')).toBeNull();
    });

    it('accepts an encoded question mark inside the path', () => {
        // The negative control for the round-trip check above: %3F is a path
        // character, not a delimiter, so clearing search and hash leaves the href
        // untouched and the endpoint is still a base. A guard that rejected this
        // would be rejecting a legal path.
        expect(safeCodecEndpoint('https://codec.example.com/pa%3Fth')).toBe('https://codec.example.com/pa%3Fth');
    });

    it('rejects credentials embedded in the URL', () => {
        // The same rule as the absent Authorization header, one layer down: userinfo
        // is a credential the browser would apply on our behalf. fetch() throws on it
        // regardless, so accepting it only produced a popup that said the endpoint was
        // usable and a panel that failed when it was used.
        expect(safeCodecEndpoint('https://user:pass@codec.example.com')).toBeNull();
        expect(safeCodecEndpoint('https://user@codec.example.com')).toBeNull();
    });

    it('keeps every accepted endpoint safe to append /decode to', () => {
        // The invariant behind the two specs above, asserted as one property rather
        // than as a list of rejections: whatever comes back out of here is a URL whose
        // path is the last thing in it, so `${endpoint}/decode` is a path join.
        //
        // THE INPUT LIST IS THE TEST. A first version of this spec fed it three
        // endpoints that are accepted anyway, which made it a tautology: deleting the
        // query/fragment guard from safeCodecEndpoint left this spec GREEN, because no
        // input it tried had a query in it. A property that never sees a value which
        // could break it is not asserting the property — it is asserting that the
        // examples chosen to pass, pass. So the list below deliberately mixes the
        // accepted shapes with every shape that breaks the join, and the assertion is
        // conditional on acceptance rather than on which row this is.
        const candidates = [
            'https://codec.example.com',
            'https://codec.example.com/base/',
            'http://localhost:8081',
            // An encoded '?' is a path character. It belongs in this list as an
            // ACCEPTED shape, so a guard that over-rejects fails the witness count.
            'https://codec.example.com/pa%3Fth',
            'https://codec.example.com/base?tenant=a',
            'https://codec.example.com/base#frag',
            'http://localhost:8081/?x=1',
            // The bare delimiters, which the first version of the guard accepted and
            // this property therefore certified as safe to append /decode to. They are
            // here because the list IS the test: with them absent, the guard could go
            // back to reading .search and .hash and this spec would stay green.
            'https://codec.example.com/?',
            'https://codec.example.com/#',
            'https://codec.example.com/base?',
            'https://codec.example.com/base#',
            'https://user:pass@codec.example.com',
        ];
        let accepted = 0;
        for (const raw of candidates) {
            const endpoint = safeCodecEndpoint(raw);
            if (endpoint === null) continue;
            accepted++;
            const url = new URL(`${endpoint}/decode`);
            expect(url.pathname.endsWith('/decode')).toBe(true);
            expect(url.search).toBe('');
            expect(url.hash).toBe('');
        }
        // Without this, a safeCodecEndpoint() that rejected EVERYTHING would satisfy
        // the loop above by never entering it. The property needs a witness — and now
        // also guards the other direction, since the encoded-'?' path is an accepted
        // shape that a heavier-handed guard would drop.
        expect(accepted).toBe(4);
    });
});

describe('codecDecodeCall', () => {
    const payloads = [payload('binary/encrypted', 'opaque')];

    it('makes exactly the call Temporal’s own UI makes', () => {
        const call = codecDecodeCall({ endpoint: 'https://codec.example.com', namespace: 'ns', payloads });
        expect(call.url).toBe('https://codec.example.com/decode');
        expect(call.init.method).toBe('POST');
        expect(call.init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Namespace': 'ns' });
        expect(JSON.parse(String(call.init.body))).toEqual({ payloads });
        // The namespace goes out in a header. Named here because it is the one field
        // of the request that is not a payload and is easy to forget when listing
        // what this call discloses to a third party.
        expect(call.init.headers).toHaveProperty('X-Namespace');
    });

    it('carries no credential, and has no parameter that could add one', () => {
        // BOTH of these used to be settings — "pass my access token" and "send
        // cookies". They were deleted rather than defaulted off, because the endpoint
        // arrives over postMessage: see the CodecConfig note in payloadMessages.ts.
        //
        // Asserting the ABSENT PARAMETERS as well as the absent header is the whole
        // point of this test. A default-off flag passes an assertion about the
        // header; only the absence of the parameter makes a forged `true` unreachable.
        const call = codecDecodeCall({ endpoint: 'https://codec.example.com', namespace: 'ns', payloads });
        expect(call.init.headers).not.toHaveProperty('Authorization');
        expect(Object.keys(call.init.headers as Record<string, string>)).toEqual(['Content-Type', 'X-Namespace']);
        // NOT `credentials: 'omit'` — this call used to carry that literal, and the
        // review that removed it was right: on a RequestInit, 'omit' is one caller
        // being careful. `credentials` is now not a field of the type this returns at
        // all, and fetchFromPageWorld sets it. What reached the wire is asserted from
        // outside the extension in apiInject.spec.ts, which is where a claim about
        // egress belongs; what this line pins is that the builder cannot name one.
        expect(call.init).not.toHaveProperty('credentials');

        // A build that still tried to pass either would not compile. This is the
        // other half: a message or a stored setting from such a build, arriving at
        // runtime where the compiler cannot see it, must not reach the wire either.
        const withExtras = codecDecodeCall({
            endpoint: 'https://codec.example.com',
            namespace: 'ns',
            payloads,
            ...({
                token: 'Bearer not-a-real-token',
                passToken: true,
                includeCredentials: true,
                credentials: 'include',
            } as object),
        });
        expect(withExtras.init.headers).not.toHaveProperty('Authorization');
        expect(withExtras.init).not.toHaveProperty('credentials');
    });

    it('describes the whole request in three fields, none of which is a credential', () => {
        // The request is a POST, a header map and a string. That is the entire type
        // fetchFromPageWorld accepts, and this is the assertion that notices if it
        // grows a fourth field — which is how a `credentials` or an `auth` would come
        // back, quietly, in a diff about something else.
        //
        // The positive control is the assertion above that the same call DOES carry
        // X-Namespace and the payload body: the request is fully formed, so the short
        // list is a decision rather than an artefact of an empty init.
        for (const namespace of ['ns', 'another-ns']) {
            const call = codecDecodeCall({ endpoint: 'http://localhost:8081', namespace, payloads });
            expect(Object.keys(call.init).sort()).toEqual(['body', 'headers', 'method']);
            expect(call.init.headers).toEqual({ 'Content-Type': 'application/json', 'X-Namespace': namespace });
        }
    });
});

// ── What is allowed to leave the browser ─────────────────────────────────────
//
// planCodecCall is the difference between "a payload needed decoding" and "every
// payload on that row was posted to a third party". It exists because the first
// version sent the whole array whenever any member of it needed a codec.
describe('planCodecCall and mergeDecoded', () => {
    const readable = payload('json/plain', '{"customer":"plaintext"}');
    const encrypted = payload('binary/encrypted', 'opaque');

    it('sends only the payloads that cannot be read here', () => {
        const plan = planCodecCall([readable, encrypted, readable]);

        expect(plan.send).toEqual([encrypted]);
        expect(plan.positions).toEqual([1]);
    });

    it('sends nothing at all when every payload is readable', () => {
        // The caller reads plan.send.length to decide whether to make a request,
        // so an empty plan is what "no egress" is made of.
        expect(planCodecCall([readable, readable]).send).toEqual([]);
        expect(planCodecCall([]).send).toEqual([]);
    });

    it('treats binary/null as readable rather than shipping it', () => {
        expect(planCodecCall([payload('binary/null', '')]).send).toEqual([]);
    });

    it('puts the answers back in their original positions', () => {
        const decoded = payload('json/plain', '"decrypted"');
        const plan = planCodecCall([readable, encrypted, readable]);

        const merged = mergeDecoded([readable, encrypted, readable], plan, [decoded]);

        expect(merged).toEqual([readable, decoded, readable]);
    });

    it('refuses a count that does not match the plan', () => {
        // Same reason readCodecResponse counts: pairing answer N with a different
        // argument N would relabel decrypted data instead of failing.
        const plan = planCodecCall([encrypted, encrypted]);

        expect(() => mergeDecoded([encrypted, encrypted], plan, [payload('json/plain', '"one"')])).toThrow(
            /1 payloads for 2/,
        );
    });
});

describe('readCodecResponse', () => {
    it('returns the decoded payloads when the count matches', () => {
        const decoded = [payload('json/plain', '{"a":1}')];
        expect(readCodecResponse({ payloads: decoded }, 1)).toEqual(decoded);
    });

    it('refuses a response with the wrong number of payloads', () => {
        // The panel pairs answer N with argument N. A silent mismatch would
        // relabel decrypted data, which is worse than showing an error.
        expect(() => readCodecResponse({ payloads: [] }, 2)).toThrow(/0 payloads for 2/);
    });

    it('refuses a response that is not a payloads array', () => {
        for (const bad of [{}, { payloads: 'nope' }, null, 'error']) {
            expect(() => readCodecResponse(bad, 1)).toThrow(/payloads array/);
        }
    });
});
