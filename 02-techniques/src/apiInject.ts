// MAIN-world script, part two: every message this extension accepts from the
// page, in one switch. Loaded straight after inject.ts, in the page's own world.
//
// It is deliberately this small. Importing pageApi.ts is what installs the fetch
// wrapper and the ledger — see the trust-boundary note at the top of that file —
// and each handler below holds no access of its own, so the list of things a page
// script can ask this extension to do is the list of `if`s in one function. A
// reviewer should be able to enumerate the attack surface by reading this file and
// then reading pageApi.ts, in that order, and nothing else.
//
// `event.source !== window` is a cheap filter and NOT a check: it only means the
// message came from this page rather than an iframe, and every script in this page
// passes it. The gate is in pageApi.ts.

import { installDetailWatch } from './detailWatch';
import { TAG } from './pageApi';
import { isRowInfoRequest } from './rowInfo';
import { serveRowInfo } from './rowInfoServe';

window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    // A shape-only parser: it says the message is well-formed and nothing
    // whatever about who sent it. There is exactly one accepted message in this
    // build, and adding a second is the moment to re-read pageApi.ts.
    if (isRowInfoRequest(data)) {
        serveRowInfo(data);
        return;
    }
});

// Not a message handler: it asks pageApi.ts to hand over the history and describe
// responses a single workflow's own page fetches, and posts a payload-free fold of
// them across. It answers no message and it fetches nothing, so it adds nothing to
// the switch above — which is the list a reviewer enumerates.
installDetailWatch();

console.log(TAG, 'ready — nothing is fetched until a row asks for it');
