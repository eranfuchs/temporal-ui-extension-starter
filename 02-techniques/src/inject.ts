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
//   • we depend on a URL shape, `/api/v1/namespaces/{ns}/workflows`. If
//     Temporal changes it, this stops seeing rows — quietly. The console log
//     below exists so that failure is one devtools glance away.
// ─────────────────────────────────────────────────────────────────────────────

import { MESSAGE_SOURCE, type WorkflowsMessage } from './types';

(() => {
    const TAG = '[temporal-ui-starter]';
    const originalFetch = window.fetch.bind(window);

    const isWorkflowList = (url: string): boolean =>
        /\/api\/v1\/namespaces\/[^/]+\/workflows(\?|$)/.test(url);

    const urlOf = (input: RequestInfo | URL): string => {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.toString();
        return input.url;
    };

    const wrappedFetch = async function wrappedFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
    ): Promise<Response> {
        const response = await originalFetch(input as RequestInfo, init);
        const url = urlOf(input);
        if (!response.ok || !isWorkflowList(url)) return response;

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
    try {
        Object.defineProperty(window, 'fetch', {
            configurable: true,
            get: () => wrappedFetch,
            set: () => {
                /* swallow reassignment — keep our wrapper outermost */
            },
        });
    } catch {
        // Exotic environments may refuse defineProperty. A plain assignment is
        // better than nothing: we may be evicted, but until then we work.
        (window as { fetch: typeof fetch }).fetch = wrappedFetch;
    }

    console.log(TAG, 'watching this page’s own Temporal API calls on', location.origin);
})();
