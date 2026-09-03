// The codec server: which endpoints may be used, what is sent to one, and what is
// believed of the answer.
//
// RESPONSIBILITY: plan the one request in this repository that leaves the browser
// for a host the user named, and check its reply. Pure — every function here is a
// value in and a value out. The fetch itself is src/payloads/payloadServe.ts's, through
// fetchFromPageWorld() in src/page/pageApi.ts.
//
// This is the file to read if the question is "what can this extension send, and
// where?". It is short on purpose.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE FETCH HAPPENS IN THE PAGE'S WORLD, NOT THE EXTENSION'S
//
// A content script cannot make this request. Chrome's own documentation:
// "Cross-origin requests are always treated as such in content scripts, even if
// the extension has host permissions." The request would carry the extension's
// origin, which nobody has allowed:
//
//   • On Temporal Cloud the API is NOT on cloud.temporal.io — it is on the
//     tenant host, so this is a cross-origin request even for the page itself.
//     It succeeds for the page because the tenant host sends the page's origin
//     back in Access-Control-Allow-Origin. It would fail for us.
//   • A codec server is configured with
//     `Access-Control-Allow-Origin: https://cloud.temporal.io` because that is
//     what the Temporal UI needs. Again: the page's origin, not ours.
//
// So the fetch is made from the MAIN world, where our request is
// indistinguishable from one the Temporal UI would have made itself. The
// consequence is the thing worth copying: **an already-working codec server needs
// no reconfiguration for this extension**, and we still declare no
// host_permissions, because a page-world fetch is the page's request, not ours.
// ─────────────────────────────────────────────────────────────────────────────
//
// NO CREDENTIAL IS REACHABLE FROM ANY FUNCTION HERE, and that is enforced one layer
// down rather than promised here: codecDecodeCall() returns an
// UnauthenticatedPost, a type with no `credentials` field, and
// fetchFromPageWorld() writes `credentials: 'omit'` as a literal and refuses an
// Authorization, Cookie or Proxy-Authorization header outright. The rule lives with
// the function that SENDS the request rather than the one that describes it, so it
// holds for the next caller too. The two switches that were deleted to get here are
// in docs/design-notes.md.
//
// The consequence, stated plainly because it is a real limitation: a codec server
// that authenticates its callers cannot be used from this extension. That is the
// intended trade at this rung of the ladder. An unauthenticated codec server on
// your own machine is the case this stage is built for.

import * as v from 'valibot';

import type { UnauthenticatedPost } from '../page/pageApi';
import { needsCodec, rawPayloadsSchema, type RawPayload } from './payloads';
import { asObject } from './valueGuards';

// ── Which endpoints may be used ─────────────────────────────────────────────

// The rule is about the payloads, not about the URL. A codec server's whole job
// is to hand back DECRYPTED data — the account numbers, the customer records,
// the tokens — so plain http to anywhere but this machine would put exactly that
// on the wire in the clear, one typo away from doing it to a host on the public
// internet. https, or loopback where there is no wire.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// The ONLY source for this value is the popup. An earlier version read it out of
// the Temporal UI's own settings, which was a nicer first run and three extra trust
// questions; see "The endpoint used to come from the page" in docs/design-notes.md.
//
// Returns the endpoint with trailing slashes removed, or null. The postcondition is
// what the rest of this file relies on: **whatever comes back is a URL whose path
// is the last thing in it**, so `${endpoint}/decode` is a path join and not a
// surprise. That is why a query and a fragment are refused rather than stripped —
// see the spec, which asserts the postcondition rather than listing rejections.
export function safeCodecEndpoint(raw: string): string | null {
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch {
        return null;
    }
    // A QUERY OR A FRAGMENT IS NOT A BASE. Accepting one sent the POST to a URL a
    // server answers and answers WRONGLY, which is a failure nobody notices —
    // docs/design-notes.md, "A query string is not a base URL".
    //
    // Checked by round-trip rather than by reading .search and .hash, because the URL
    // API spells an EMPTY delimiter as an empty string: a trailing `?` and a trailing
    // `#` each report search === '' and hash === '', identical to having neither. So
    // the obvious truthiness check accepted both, and `${endpoint}/decode` came out as
    // `…/base?/decode` — /decode as a QUERY STRING, which is the same silently wrong
    // destination this guard exists to prevent. Clearing both and comparing the
    // normalised href catches the empty delimiter and the populated one on one line,
    // and still accepts an encoded '?' inside the path, a legitimate path segment.
    const beforeClearing = parsed.href;
    parsed.search = '';
    parsed.hash = '';
    if (parsed.href !== beforeClearing) return null;
    // Userinfo is a credential, and one the browser would apply for us. fetch()
    // throws on it anyway, so accepting it only bought a popup that promised an
    // endpoint would be used and a panel that failed at the moment of use.
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') return trimmed;
    if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return trimmed;
    return null;
}

// ── What gets sent, and how the answer comes back ───────────────────────────

// ONLY THE PAYLOADS THAT CANNOT BE READ HERE. Never the rest: a workflow started
// with a plaintext customer record and one encrypted blob must post only the blob,
// and the first version posted both. `positions` is what makes a subset
// re-attachable, so sending a subset without it is what would mislabel data.
export interface CodecPlan {
    // Indexes into the original array, ascending, of the payloads being sent.
    positions: number[];
    // Exactly those payloads, in the same order: the whole request body.
    send: RawPayload[];
}

export function planCodecCall(payloads: RawPayload[]): CodecPlan {
    const plan: CodecPlan = { positions: [], send: [] };
    payloads.forEach((payload, index) => {
        if (!needsCodec(payload)) return;
        plan.positions.push(index);
        plan.send.push(payload);
    });
    return plan;
}

// The decoded payloads back in their original positions, everything else
// untouched. Length-checked for the same reason readCodecResponse counts: the
// panel pairs answer N with argument N, and mislabelled decrypted data is worse
// than an error message.
export function mergeDecoded(original: RawPayload[], plan: CodecPlan, decoded: RawPayload[]): RawPayload[] {
    if (decoded.length !== plan.positions.length) {
        throw new Error(`Codec server returned ${decoded.length} payloads for ${plan.positions.length} sent.`);
    }
    const merged = [...original];
    plan.positions.forEach((position, index) => {
        merged[position] = decoded[index]!;
    });
    return merged;
}

export interface CodecCall {
    url: string;
    // NOT a RequestInit. This is the type fetchFromPageWorld accepts, and it has no
    // `credentials` field — so this builder cannot ask for an ambient credential even
    // by accident, and neither can whatever calls it next.
    init: UnauthenticatedPost;
}

// The request Temporal's own UI makes, minus its two credential options: POST
// {endpoint}/decode, the namespace in X-Namespace, and `{"payloads": […]}` in and
// out. Route, header and body match exactly, which is the point — a codec server
// already serving the Temporal UI needs no change to serve this.
export function codecDecodeCall(input: { endpoint: string; namespace: string; payloads: RawPayload[] }): CodecCall {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Namespace': input.namespace,
    };
    return {
        url: `${input.endpoint}/decode`,
        init: {
            method: 'POST',
            headers,
            body: JSON.stringify({ payloads: input.payloads }),
        },
    };
}

// What came back, checked before it is believed.
//
// The count check is not pedantry. The panel pairs answer N with argument N, so
// a server that returns three payloads for two arguments would relabel data
// rather than fail — and mislabelled decrypted data is worse than an error
// message.
export function readCodecResponse(body: unknown, sent: number): RawPayload[] {
    const payloads = asObject(body)?.['payloads'];
    if (!Array.isArray(payloads)) throw new Error('Codec server did not return a payloads array.');
    if (payloads.length !== sent) {
        throw new Error(`Codec server returned ${payloads.length} payloads for ${sent} sent.`);
    }
    // The COUNT was never the whole check. A server that returns the right number of
    // wrong-shaped objects passed the test above and then handed `{data: {}}` to
    // `atob()` and `null` to `encodingOf()`, inside a tooltip. The elements are the
    // decoded form of somebody's data, arriving from a host the reader typed in, so
    // they are validated to the leaves like every other message from outside.
    //
    // Whole or nothing, and an error rather than a filter: dropping element 2 of 3
    // would pair answer 3 with argument 2 and label one workflow's data with
    // another's, which is precisely what the count check above exists to stop.
    const checked = v.safeParse(rawPayloadsSchema, payloads);
    if (!checked.success) {
        throw new Error('Codec server returned a payload that is not shaped like one.');
    }
    return checked.output;
}
