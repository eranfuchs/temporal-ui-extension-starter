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
import { isPayloadRequest } from './payloads';
import { servePayloadRequest } from './payloadServe';
import { isRowInfoRequest } from './rowInfo';
import { serveRowInfo } from './rowInfoServe';

window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    // Shape-only parsers, each of which says the message is well-formed and
    // nothing whatever about who sent it.
    //
    // TWO accepted messages in this build, where 02 had one. The second is the more
    // consequential one and it is the reason the trust-boundary note at the top of
    // pageApi.ts is worth re-reading before a third is added: this one names an
    // outbound host of its own, so its handler is the only place in the extension
    // where a message can influence WHERE a request goes rather than only what it
    // asks about. What bounds it is written up in payloadServe.ts, including the
    // part that is not closed.
    if (isPayloadRequest(data)) {
        void servePayloadRequest(data);
        return;
    }
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
