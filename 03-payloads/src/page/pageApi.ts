// MAIN-world module: the page's own Temporal API, as observed — and the gate in
// front of it. Every request this extension makes goes through this file.
//
// It exists because of a constraint, not a preference: none of these requests can
// be made from the extension's world at all. Cloud's API authorizes the bearer the
// PAGE sent, on the tenant host the page fetched — and a content-script fetch
// carries neither the page's origin nor its Authorization header. Asking from here
// is the only way to ask at all; see "the technique" in README.md.
//
// The same constraint, for a different reason, is why the CODEC call goes out from
// here too: a codec server is configured with the Temporal UI's origin in its
// Access-Control-Allow-Origin, and a content-script fetch does not carry that
// origin either. The reasoning is set out at length at the top of codec.ts.
// That call is fetchFromPageWorld() in section 2, and the one thing to hold onto
// while reading this file is that it deliberately does NOT go through the gate
// below, because it carries none of the authority the gate protects.
//
// Three things it does, and nothing else:
//
//   1. WATCHES the page's own workflow-list calls, to learn the API prefix, the
//      Authorization header, and which runs the server has handed this page.
//      Neither of the first two is guessable — Cloud's API is on a per-tenant
//      host, and a credentials-only request to it is rejected.
//   2. LENDS that access out, one run at a time, and only for a run the page was
//      itself handed.
//   3. HANDS OVER other responses the page fetched, to a watcher that asked for
//      them by URL — and that is all it does with them: a watched response reaches
//      neither the ledger nor the credentials. See section 1b for why those two
//      are kept apart even though the parsing is identical.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS FILE IS A TRUST BOUNDARY, AND IT IS THE INTERESTING ONE IN THIS REPO
//
// It holds authority its callers do not: the page's origin and the page's own
// Authorization header. Its callers take instructions over window.postMessage,
// which carries NO sender identity that cannot be forged — `event.source ===
// window` only means "this page", and any script in this page can say that: the
// Temporal UI itself, an npm dependency of it, or another installed extension's
// content script, which shares the DOM and the message bus with ours.
// `MESSAGE_SOURCE` and every field of every request are published in this
// repository.
//
// A component that holds authority and applies it to whatever it is asked to do
// is a confused deputy. The first version of this was one: it answered any
// (namespace, workflowId, runId) in a message, so a forged message could read ANY
// workflow's input or result with the page's bearer and receive the DECODED text
// back on a channel the forger is listening to — including workflows the user
// never opened, in another namespace they happen to have access to.
//
// Two things close that, and neither is a shape check:
//
//   • THE LEDGER. We fetch only for a run the PAGE ITSELF listed, in the
//     namespace it listed it under, learned by parsing the list RESPONSE here.
//     The bound is "what this page already fetched", which is exactly the bound
//     the piggyback claims everywhere else in this repository.
//   • NO TOKEN EGRESS. The bearer is attached to Temporal's own API and to
//     nothing else, ever; there is no setting that changes that. It is reachable
//     only through fetchForListedRun() below, which chooses the URL's origin
//     itself and takes only a ROUTE from its caller.
//
// The Authorization header never leaves this module: not stored, not posted in
// any message, not readable from the extension's own world.
//
// Note what is NOT claimed. This gate cannot be *forgotten* — there is no other
// way to reach the bearer, so a new feature that fetches must pass it. It does
// not sandbox its callers, who are our own code in the same bundle. Those are
// different properties and only the first one is enforced here.
// ─────────────────────────────────────────────────────────────────────────────

import { safeParse } from 'valibot';

import { namespaceFromApiUrl, normalizeExecutions, runKey } from '../family/rows';
import { apiPrefixOf, type ApiTarget, type RunRef } from './temporalApi';
import { workflowListEnvelopeSchema } from '../types';

export const TAG = '[temporal-ui-starter]';

// Whatever owned window.fetch when this module loaded — which is inject.ts's
// wrapper, since the manifest lists it first. Captured, then replaced below.
//
// Calling THIS rather than the native fetch is deliberate: our own requests then
// travel through inject.ts too, which is harmless (they are not list URLs, so
// nothing is observed) and keeps a single chain instead of two.
//
// It also means our own requests never pass through the wrapper installed below,
// so anything that watches the page's traffic here is watching the PAGE, never
// its own echo. Nothing has to be marked or filtered to make that true.
let pageFetch = window.fetch.bind(window);

// The property descriptor inject.ts installed, kept so that a later assignment
// by the page can be handed ON to it instead of landing on us.
const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'fetch');

// What the page told us about its own API, learned by watching its own calls.
//
// PER NAMESPACE, not one global record. A Temporal UI page fetches lists for more
// than one namespace — the namespace picker and the counts on it do — and a single
// record was simply overwritten by whichever answered last. Two consequences,
// both silent: a request could be served with another namespace's API prefix, and
// (once the ledger below existed) the ledger for the namespace on screen would be
// replaced by the picker's.
interface PageApi {
    apiPrefix: string;
    // The page's own Authorization header, as last seen on a list call for THIS
    // namespace. Last-seen wins, deliberately: an access token rotates, and the
    // page's own most recent call is the best evidence of the current one. A page
    // that authenticates by cookie sends none, and null is then the correct
    // answer rather than a missing one.
    auth: string | null;
    // THE LEDGER: runKey(workflowId, runId) for every run this page has been
    // handed by the server, in this namespace. It is the authorisation list — see
    // the trust-boundary note at the top of this file.
    executions: Set<string>;
    // EVERY list-response parse that is still running, not just the newest one.
    //
    // A request is authorised from the ledger, and the ledger is filled off the
    // response body a moment after the response arrives. Without something to
    // wait on, a hover that lands inside that window is refused for a row that IS
    // on the page — a correctness bug that would present as the feature being
    // flaky, which is the worst kind.
    //
    // WHY A SET AND NOT ONE PROMISE. This was a single `filling` field, and a
    // second list response overwrote it: the Temporal UI polls its list and
    // fetches more than one namespace's, so two parses overlap routinely, and
    // they finish in whatever order their bodies happen to parse in. A hover then
    // awaited only the LAST-ARRIVED parse and could be refused for a row that the
    // FIRST one was in the middle of adding — a false refusal, in the one code
    // path whose whole job is to decide what may be fetched. Waiting on all of
    // them is a few microtasks and removes the race outright.
    //
    // Entries remove themselves when they settle, so this is "parses in flight"
    // and not a log. None of them ever rejects: see the try/catch.
    fills: Set<Promise<void>>;
}
const byNamespace = new Map<string, PageApi>();

// A page that scrolls through a large namespace for a long time would otherwise
// accumulate one key per run it has ever seen. Keys are small and this is
// generous — several pages of a list — but unbounded growth in a long-lived tab
// is not something to leave for someone else to find.
const MAX_LEDGER_ENTRIES = 5_000;

// ── 1. Watching ─────────────────────────────────────────────────────────────

const recordingFetch = function recordingFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = urlOf(input);
    let namespace: string | null = null;
    try {
        namespace = remember(url, input, init);
    } catch (err) {
        // Never let the bookkeeping break the page's own request.
        console.warn(TAG, 'could not inspect a request', err);
    }
    // Chosen BEFORE the request is made, so a watcher registered while a response
    // was in flight cannot receive part of a page load it was not there for. A
    // list call is never offered to a watcher: the two paths read different routes
    // and keeping them exclusive means "who saw this response" has one answer.
    const interested = namespace === null ? watchersFor(url) : [];
    const pending = pageFetch(input as RequestInfo, init);
    if (namespace === null && interested.length === 0) return pending;
    const listed = namespace;
    return pending.then((response) => {
        if (listed !== null) {
            try {
                recordListedRuns(response, listed);
            } catch (err) {
                console.warn(TAG, 'could not read a workflow list response', err);
            }
        }
        for (const watcher of interested) deliverObserved(response, url, watcher);
        return response;
    });
};

function urlOf(input: RequestInfo | URL): string {
    return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

// Returns the namespace this call is a list request for, or null if it is not
// one — which is also the signal not to look at its response.
function remember(url: string, input: RequestInfo | URL, init?: RequestInit): string | null {
    // Only list calls reach the ledger and the credentials below. It is the one
    // call guaranteed to happen on the page we care about, and narrowing to it
    // means this half of the wrapper looks at as little of the page's traffic as
    // the feature can get away with.
    const namespace = namespaceFromApiUrl(url);
    if (namespace === null) return null;
    const apiPrefix = apiPrefixOf(url);
    if (apiPrefix === null) return null;
    const existing = byNamespace.get(namespace);
    const auth = authorizationOf(input, init);
    if (existing) {
        existing.apiPrefix = apiPrefix;
        existing.auth = auth;
    } else {
        byNamespace.set(namespace, { apiPrefix, auth, executions: new Set(), fills: new Set() });
    }
    return namespace;
}

// THE LEDGER IS BUILT FROM THE RESPONSE, HERE, AND NOT FROM A MESSAGE.
//
// inject.ts has already parsed this same body and posted the rows to the page,
// and reusing that would cost nothing — which is exactly the trap. A message is
// forgeable by anything on the page, so a ledger built from one would authorise
// whatever an attacker put in it: it would look like a check and be none. The
// cost of doing it properly is one extra clone and parse of a body we have
// already parsed once, in a microtask, per list load.
//
// Cloning is not optional (a body is consumed once, and the page needs it), and
// the parse is deferred for the same reason inject.ts defers its own: on a busy
// namespace this JSON runs to megabytes and parsing it inline janks the page on
// every list load. `await clone.text()` is what defers it — the body of this
// function past that line does not run in the page's own turn.
function recordListedRuns(response: Response, namespace: string): void {
    if (!response.ok) return;
    const record = byNamespace.get(namespace);
    if (!record) return;
    const clone = response.clone();
    const fill = (async () => {
        try {
            // The same envelope schema inject.ts parses, on the same body, for a
            // different purpose. Parsed rather than cast: a cast here would have
            // been a cast on the input to an AUTHORISATION list, which is the
            // last place to tell the compiler to stop asking.
            const body = safeParse(workflowListEnvelopeSchema, JSON.parse(await clone.text()));
            if (!body.success) return;
            // normalizeExecutions is the shared, tested reader of this shape; it
            // parses each entry and drops any without both ids, which is what
            // keeps a half-formed row out of an authorisation list.
            const rows = normalizeExecutions(body.output.executions);
            // Eviction is the whole set, before the refill, and never a slice of
            // this response. A list body is self-sufficient — everything the user
            // can now see is in it — so forgetting older pages cannot refuse a row
            // that is on screen, whereas evicting mid-refill could, and would look
            // exactly like the feature being broken.
            if (record.executions.size + rows.length > MAX_LEDGER_ENTRIES) record.executions.clear();
            for (const row of rows) record.executions.add(runKey(row.workflowId, row.runId));
        } catch (err) {
            if ((err as { name?: string } | null)?.name !== 'AbortError') {
                console.warn(TAG, 'could not read a workflow list response', err);
            }
        }
    })();
    record.fills.add(fill);
    // Drops out the moment it settles: the set means "still running", and a parse
    // that has finished must not make a later hover wait on it.
    void fill.finally(() => record.fills.delete(fill));
}

// ── 1b. Watching one more thing, with NONE of the authority ─────────────────
//
// A seam for reading a response the page fetched that is NOT a workflow list —
// the one caller is src/detail/detailWatch.ts, which reads a single workflow's own
// history and describe calls to draw its deep-link card.
//
// OBSERVATION IS NOT AUTHORITY, and that is the whole reason this is a second,
// weaker path instead of a couple of extra branches inside remember():
//
//   • a watched response DOES NOT TOUCH THE LEDGER. The ledger means "the server
//     handed this page this run in a list", and it is what authorises spending the
//     bearer. A run merely mentioned in some other response has not been listed,
//     and letting one in would quietly widen the bound this repository claims
//     everywhere else — for the sake of a feature that fetches nothing.
//   • it DOES NOT LEARN apiPrefix OR auth. A watcher cannot cause a request, so it
//     has no use for either; not learning them means an observed URL can never
//     extend where the page's bearer may be spent.
//   • there is nothing to wait on, no `fills` entry, because nothing is authorised
//     off a watched response. It arrives when it arrives, and the card redraws.
//
// The cost is one clone and one deferred JSON.parse per matching response — the
// same bill inject.ts pays for the list, and paid on a body the page has just
// parsed itself.
export type PageResponseWatcher = (url: string, body: unknown) => void;

interface ResponseWatcher {
    wants(url: string): boolean;
    take: PageResponseWatcher;
}

const watchers: ResponseWatcher[] = [];

export function watchPageResponses(wants: (url: string) => boolean, take: PageResponseWatcher): void {
    watchers.push({ wants, take });
}

function watchersFor(url: string): ResponseWatcher[] {
    return watchers.filter((watcher) => {
        try {
            return watcher.wants(url);
        } catch (err) {
            // A watcher that throws while deciding is a broken watcher, not a
            // reason to break the page's request.
            console.warn(TAG, 'a response watcher failed to decide', err);
            return false;
        }
    });
}

function deliverObserved(response: Response, url: string, watcher: ResponseWatcher): void {
    if (!response.ok) return;
    const clone = response.clone();
    // Deferred for the reason recordListedRuns() explains: a history page runs to
    // megabytes on a long workflow, and parsing it in the page's own turn janks
    // the UI on every scroll of the event list.
    void (async () => {
        try {
            watcher.take(url, JSON.parse(await clone.text()));
        } catch (err) {
            if ((err as { name?: string } | null)?.name !== 'AbortError') {
                console.warn(TAG, 'could not read an observed response', err);
            }
        }
    })();
}

function authorizationOf(input: RequestInfo | URL, init?: RequestInit): string | null {
    if (init?.headers) {
        const fromInit = new Headers(init.headers).get('authorization');
        if (fromInit) return fromInit;
    }
    // The page may have built a Request object instead of passing an init.
    if (typeof Request !== 'undefined' && input instanceof Request) return input.headers.get('authorization');
    return null;
}

// Take the property, and hand any LATER assignment down to inject.ts.
//
// This used to be a plain `window.fetch = recordingFetch`, relying on inject.ts's
// setter to adopt it. That works — right up to the moment the page installs a
// wrapper of its own, which the Temporal UI does. inject.ts keeps ONE adopted
// reference, so the app's assignment replaced ours and this file stopped seeing
// any traffic at all.
//
// Nothing announced it. inject.ts stays outermost through its own getter, so rows
// kept arriving and the tree kept drawing; only the second observer went deaf, and
// every per-row question answered "nothing observed on this page yet" for the life
// of the tab. That is the failure mode this whole repository keeps warning about:
// two observers of one global, one of them silently unhooked.
//
// Owning the property fixes it, PROVIDED the assignment is forwarded to the
// previous owner's setter rather than swallowed — inject.ts's adoption is what
// keeps the app's own wrapper in the chain. Nobody is dropped: the page calls us,
// we call inject.ts, inject.ts calls whatever the page installed.
// tests/unit/apiInject.spec.ts pins each of those three.
try {
    Object.defineProperty(window, 'fetch', {
        configurable: true,
        get: () => recordingFetch,
        set: (next: unknown) => {
            if (typeof next !== 'function' || next === recordingFetch) return;
            if (previousDescriptor?.set) previousDescriptor.set.call(window, next);
            // No setter to forward to means inject.ts is not installed (or
            // defineProperty was refused there): keep the new wrapper as our own
            // inner chain, so the page's assignment still takes effect.
            else pageFetch = (next as typeof fetch).bind(window);
        },
    });
} catch {
    // Same fallback as inject.ts: worse, but better than not installing.
    (window as { fetch: typeof fetch }).fetch = recordingFetch;
}

// ── 2. Lending it out ───────────────────────────────────────────────────────

// A route, given a target this module has already authorised. See temporalApi.ts
// for the builders that satisfy it.
//
// The caller supplies the ROUTE and never the origin, so there is no way to spend
// the page's bearer on a host of the caller's choosing — and no way to spend it on
// a different run than the one that passed the check, because the target it is
// handed is frozen.
export type RouteBuilder = (target: ApiTarget) => string;

// THE AUTHORISATION CHECK, and the only path to the page's bearer.
//
// Both halves of it run before anything is fetched. Neither refusal quotes the
// request back: these strings are rendered into a tooltip, and a forged request's
// `namespace` is an arbitrary attacker-chosen string of arbitrary length. Nothing
// is echoed, so there is nothing to echo wrongly.
export async function fetchForListedRun(namespace: string, run: RunRef, route: RouteBuilder): Promise<Response> {
    const page = byNamespace.get(namespace);
    if (!page) {
        // The honest reading of this is "we have not watched this page ask about
        // that namespace", which for a real request means the tab was opened
        // before the extension was loaded.
        throw new Error('Nothing observed on this page yet — reload the workflow list and try again.');
    }
    // A list response that is still being read is not yet a refusal. Hovering
    // that fast takes a machine rather than a hand, but the panel is also opened
    // programmatically by this project's own tests.
    //
    // ALL of the parses in flight, and a SNAPSHOT of them: a list poll that starts
    // after this line must not be able to keep a hover waiting, and on a busy page
    // there is always another one about to start.
    if (page.fills.size > 0) await Promise.all(Array.from(page.fills));
    if (!page.executions.has(runKey(run.workflowId, run.runId))) {
        // A real hover cannot reach this: the row was hovered because the page
        // listed it. A forged message asking about some other workflow can, and
        // this is where it stops — before the page's bearer is spent on it.
        throw new Error(
            'That run is not in a workflow list this page has loaded, so this extension will not fetch it. Reload the workflow list and try again.',
        );
    }

    const target: ApiTarget = Object.freeze({
        apiPrefix: page.apiPrefix,
        namespace,
        workflowId: run.workflowId,
        runId: run.runId,
    });
    return await pageFetch(route(target), {
        // Both are needed, and for different servers: the OSS UI authenticates by
        // cookie, and Cloud's tenant host authorizes by the bearer the page itself
        // used — it answers 403 to a request that carries only credentials.
        credentials: 'include',
        headers: page.auth ? { accept: 'application/json', authorization: page.auth } : { accept: 'application/json' },
    });
}

// THE SECOND EXPORTED FETCH, and the reason there are two rather than one with a
// flag. 02 had only the one above and said in this spot that the other kind would
// arrive with the payload stage; this is it.
//
// It carries NO credential of ours and performs no authorisation check, because
// there is nothing here to authorise: this posts to a server that is not Temporal
// and holds no session of the user's.
//
// The two must never converge, and the difference is exactly one word — WHO CHOOSES
// THE ORIGIN. fetchForListedRun() posts to an origin this module learned from the
// page and attaches the page's bearer, so it has to check what it is asked for.
// This one posts to an origin its CALLER chose, which in practice means an origin
// that arrived in a postMessage, so it must carry nothing worth stealing. Adding an
// `auth: true` parameter here — or reusing this function for a Temporal route —
// would collapse both halves of that sentence at once, and it would type-check.
//
// WHY THE PARAMETER IS NOT A RequestInit. It was one, and that made "this call
// carries no credential" a true statement about today's only caller rather than a
// property of this function: a RequestInit HAS a `credentials` field, so the next
// caller could set it here and nothing in this file would notice. Both credential
// routes are closed now where the request is spent, not where it is built:
//
//   • `credentials` — the ambient one, which the BROWSER attaches. Not a field of
//     the type below, and a literal 'omit' further down. No parameter can change it.
//   • `Authorization` — the explicit one, which a caller hands over. The type cannot
//     ban it, because a case-insensitive key ban is not something TypeScript says
//     cheaply, so it is refused at run time instead. (`Cookie` and
//     `Proxy-Authorization` are in that list for the reader; fetch already forbids
//     both.)
//
// The narrowing is the point rather than the tidiness: a codec server that
// authenticates its callers is now UNIMPLEMENTABLE from here, which is the trade
// this rung of the ladder makes on purpose.
export interface UnauthenticatedPost {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
}

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

// `async`, like fetchForListedRun(), so both boundary functions refuse the same way
// — a rejected promise. One that throws synchronously and one that rejects is the
// kind of difference a caller discovers in production.
export async function fetchFromPageWorld(url: string, request: UnauthenticatedPost): Promise<Response> {
    for (const name of Object.keys(request.headers)) {
        if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
            throw new Error(`This extension does not send a ${name} header to a host it was told about in a message.`);
        }
    }
    return await pageFetch(url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        credentials: 'omit',
    });
}

// ── 3. Answering ────────────────────────────────────────────────────────────

export function replyToPage(message: object): void {
    // location.origin, never '*' — the same rule as inject.ts, and on this rung it
    // is no longer a precaution about habits. 02 said a wildcard post here was "the
    // habit that becomes a leak in a later stage, where the same channel carries
    // decoded input and result"; this is that stage. Every payload answer goes
    // through this function, so a wildcard would hand a cross-origin iframe on the
    // page a copy of every workflow input and result the user hovers, decrypted.
    window.postMessage(message, location.origin);
}

export function fetchFailureMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    // A cross-origin failure arrives as a bare "Failed to fetch"; the actual
    // reason is in the console and nowhere else, so say where to look rather than
    // repeating a message that explains nothing.
    return raw === 'Failed to fetch'
        ? 'Request blocked by the browser (CORS, or the server is unreachable). The page console has the reason.'
        : raw;
}
