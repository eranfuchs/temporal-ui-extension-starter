// MAIN-world script. Runs at document_start, before Temporal's own JavaScript.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE IDEA WORTH COPYING FROM THIS REPOSITORY
//
// The Temporal UI already asks the server for exactly the data we want to draw.
// So instead of authenticating and asking for it again, we watch the page make
// its own call and read the answer over its shoulder.
//
// What that buys, and it is a lot:
//   • no host_permissions — we never issue a request, so we need no grant
//   • no credentials, anywhere — no API key, no token, no mTLS certificate
//   • no CORS, no proxy, no backend
//   • it works on Temporal Cloud and on a local `temporal server start-dev`
//     unchanged, because both drive the same API from the page
//   • it cannot show anyone data they could not already see: if the page was
//     not allowed to fetch it, there is nothing to observe
//
// What it costs, stated plainly:
//   • we see a list when the page asks for one. Nothing to observe means
//     nothing to draw, so the first paint is whatever the page fetched.
//   • we depend on a URL shape, `/api/v1/namespaces/{ns}/workflows` — declared
//     once, in rows.ts, and shared with the receiving side. If Temporal changes
//     it, this stops seeing rows — quietly. The console log below exists so that
//     failure is one devtools glance away.
// ─────────────────────────────────────────────────────────────────────────────

import { namespaceFromApiUrl } from './rows';
import { MESSAGE_SOURCE, type WorkflowsMessage } from './types';

(() => {
    const TAG = '[temporal-ui-starter]';

    // The fetch as it was before anyone wrapped anything: the one function we
    // know cannot lead back to us. The escape hatch wherever a cycle is possible.
    const originalFetch = window.fetch.bind(window);

    // Whoever currently owns window.fetch underneath our wrapper. It starts as
    // the native one and changes if the page assigns a new one — see the setter.
    let underlyingFetch: typeof fetch = originalFetch;

    const isWorkflowList = (url: string): boolean => namespaceFromApiUrl(url) !== null;

    const urlOf = (input: RequestInfo | URL): string => {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.toString();
        return input.url;
    };

    // Counts list requests in the order they are ISSUED. Stamped before the
    // await, so that two requests in flight at once can be told apart by which
    // one the user asked for last, rather than by which one answered first.
    let generation = 0;

    // True only for the synchronous part of a call into the fetch we adopted.
    //
    // That window is exactly when the ordinary way of wrapping fetch bites:
    //   const next = window.fetch;            // ← this reads OUR wrapper
    //   window.fetch = (…) => next(…);        // ← and we then adopt this
    // which is a cycle — we call theirs, theirs calls ours. The flag lets the
    // re-entry be recognised for what it is. It does not misfire on concurrent
    // fetches, because each call's synchronous portion runs to completion before
    // the next one starts.
    let delegating = false;

    // How many calls are inside this wrapper right now — in total, and for this
    // one url — and the two points at which we stop delegating.
    //
    // Both are backstops for the one shape the flag above cannot see: a wrapper
    // that awaits something (a token refresh, say) BEFORE calling back in. By
    // then the synchronous window has closed, the call is indistinguishable from
    // a fresh one — from inside a browser there is no way to tell them apart —
    // and left alone it recurses without end. Past either cap we call the fetch
    // captured at document_start, which nobody can have wrapped, so the chain
    // terminates and the page still gets its response.
    //
    // THE PER-URL CAP IS THE ONE THAT DOES THE WORK, and the global one is not a
    // substitute for it. A recursion re-requests the SAME url, so counting per
    // url bounds it at three re-entries rather than fifty — and those fifty are
    // not free: the wrapper being re-entered is the page's own, or another
    // extension's, and if it logs, traces, reports or refreshes a token it does
    // all of that fifty times for one call the page made once.
    //
    // The global cap stays, for the shape the per-url count cannot see: a wrapper
    // that REWRITES the url on each hop — a cache-buster, a retry with a changed
    // query — is a different url every time, and something still has to stop it.
    //
    // The trade, stated plainly: a page with more than three IDENTICAL requests
    // genuinely in flight at once has its own wrapper skipped for the fourth,
    // because from in here that is indistinguishable from a recursion. That costs
    // its wrapper one call. The alternative costs it forty-seven.
    const MAX_IN_FLIGHT = 50;
    const MAX_IN_FLIGHT_PER_URL = 3;
    let inFlight = 0;
    const inFlightByUrl = new Map<string, number>();

    // Responses we have already posted rows for — see the check in wrappedFetch.
    const observed = new WeakSet<Response>();

    const callUnderlying = (input: RequestInfo, init: RequestInit | undefined, depth: number): Promise<Response> => {
        if (inFlight > MAX_IN_FLIGHT || depth > MAX_IN_FLIGHT_PER_URL) return originalFetch(input, init);
        delegating = true;
        try {
            return underlyingFetch(input, init);
        } finally {
            delegating = false;
        }
    };

    const wrappedFetch = async function wrappedFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        // A wrapper we adopted, calling back in with the reference it read from
        // window.fetch. Send it to the untouched fetch: it breaks the cycle, and
        // it stops us observing one response twice — which would parse the same
        // megabyte body again and post the same rows under two generations.
        if (delegating) return originalFetch(input as RequestInfo, init);

        const url = urlOf(input);
        const watched = isWorkflowList(url);
        const issued = watched ? ++generation : 0;
        inFlight++;
        const depth = (inFlightByUrl.get(url) ?? 0) + 1;
        inFlightByUrl.set(url, depth);
        let response: Response;
        try {
            response = await callUnderlying(input as RequestInfo, init, depth);
        } finally {
            inFlight--;
            // Removed at zero rather than left there: a long-lived tab fetches a
            // great many distinct urls, and a per-url counter that is never
            // deleted is a leak with the lifetime of the page.
            const remaining = (inFlightByUrl.get(url) ?? 1) - 1;
            if (remaining > 0) inFlightByUrl.set(url, remaining);
            else inFlightByUrl.delete(url);
        }
        if (!response.ok || !watched) return response;

        // One response, posted once. In any cycle the SAME Response object
        // travels back up through every level we were re-entered at, and without
        // this each of them re-reads a megabyte body and posts the same rows
        // again under a different generation. Weak, so it holds nothing alive.
        if (observed.has(response)) return response;
        observed.add(response);

        // Read a CLONE, and read it in a microtask.
        //
        // The clone is not optional: a Response body can be consumed once, and
        // consuming it here would hand the application an empty stream.
        //
        // The microtask is not cosmetic either. On a busy namespace this JSON
        // runs to megabytes; parsing it inline blocks the application's own
        // await on the fetch, and the page visibly janks on every list load.
        const clone = response.clone();
        queueMicrotask(async () => {
            try {
                const json = JSON.parse(await clone.text());
                if (!Array.isArray(json?.executions)) return;
                console.log(TAG, `observed ${json.executions.length} workflows at`, url);
                const message: WorkflowsMessage = {
                    source: MESSAGE_SOURCE,
                    type: 'workflows',
                    url,
                    generation: issued,
                    executions: json.executions,
                };
                // Target the page's own origin, never '*'. With '*' any iframe
                // on the page could read the rows out of the message.
                window.postMessage(message, location.origin);
            } catch (err) {
                // An AbortError here is the user navigating away mid-request,
                // not a fault. Everything else is worth seeing.
                if ((err as { name?: string } | null)?.name !== 'AbortError') {
                    console.warn(TAG, 'could not parse a workflow list response', err);
                }
            }
        });

        return response;
    };

    // Install the wrapper behind a GETTER, not a plain assignment.
    //
    // Temporal's UI (SvelteKit) reassigns window.fetch AFTER document_start. A
    // plain `window.fetch = wrapped` is therefore silently evicted moments after
    // it lands, and the failure looks exactly like "the extension doesn't work
    // on this page": no error, no log, just no rows. A getter that always
    // returns our wrapper survives that, because the framework reads
    // window.fetch fresh on every call.
    //
    // The setter ADOPTS the assignment rather than discarding it.
    //
    // Discarding was the first version, and it is the more selfish one: it keeps
    // our wrapper outermost by making `window.fetch = …` a silent no-op for
    // everyone else on the page. window.fetch is a shared global with a contract,
    // and any legitimate wrapper installed after us — the app's own retry or
    // tracing layer, an error reporter, a test harness, another extension — then
    // fails to install with no error and no symptom other than its own feature
    // quietly not working. Adopting keeps us outermost AND keeps their wrapper in
    // the chain, so both work; the guard in callUnderlying() is what makes that
    // safe when their wrapper was built by reading ours.
    let adopted = false;
    try {
        Object.defineProperty(window, 'fetch', {
            configurable: true,
            get: () => wrappedFetch,
            set: (next: unknown) => {
                // Adopting our own wrapper would be a guaranteed cycle, and
                // adopting a non-function would break every fetch on the page.
                if (typeof next !== 'function' || next === wrappedFetch) return;
                // Bound to window because that is how the page would have called
                // it: `window.fetch(…)`.
                underlyingFetch = (next as typeof fetch).bind(window);
                if (!adopted) {
                    adopted = true;
                    console.log(TAG, 'another script replaced window.fetch — adopted it, still watching');
                }
            },
        });
    } catch {
        // Exotic environments may refuse defineProperty. A plain assignment is
        // better than nothing: we may be evicted, but until then we work.
        (window as { fetch: typeof fetch }).fetch = wrappedFetch;
    }

    console.log(TAG, 'watching this page’s own Temporal API calls on', location.origin);
})();
