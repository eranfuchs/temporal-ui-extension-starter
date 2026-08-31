// MAIN world: notice when the page fetches ONE workflow's history or description,
// fold it (src/detail.ts), and post the result across.
//
// This is the whole MAIN-world half of the detail-page feature, and it is short
// because it borrows: the fetch wrapper is already installed by pageApi.ts, the
// URL rules and the folds are pure functions in detail.ts, and the answer travels
// on the same postMessage channel every other feature uses.
//
// IT FETCHES NOTHING. Compare rowInfoServe.ts, which is four times this size
// entirely because it makes requests of its own and therefore needs a cache, a
// concurrency cap and a backoff. The difference between piggybacking and asking is
// most of that file.
//
// WHY THE WATCHER IS REGISTERED UNCONDITIONALLY, even when the card is switched
// off. It costs one clone and one deferred JSON.parse per history page the user
// loads — small, but not nothing on a workflow with a hundred thousand events.
//
// The alternative was an "enable" message from the ISOLATED world, so that a user
// with the feature off pays zero. It was rejected because it loses data: the
// ISOLATED script has to read settings out of chrome.storage first, and the page's
// own history fetch can easily land before that read returns. The watcher would
// then miss the only history response the page makes for that workflow, and the
// card would sit half-empty until the user navigated again — an intermittent,
// timing-dependent failure, which is the kind this project spends its comments
// trying to avoid.
//
// inject.ts already sets the precedent: it watches the page's list calls whether
// or not the tree is enabled. Observation is unconditional here too, and what the
// settings gate is the RENDERING.
//
// FOLD BEFORE POSTING, NEVER AFTER. A raw history event carries `input`, `result`
// and `failure` — application data, some of it encrypted — and posting the events
// across for the ISOLATED side to reduce would put all of it on the page's message
// bus. detail.ts's fold keeps ids, type names, timestamps and attempt counts and
// nothing else. Reduce at the boundary.

import {
    detailRefFromApiUrl,
    readDescribeFacts,
    readHistoryFacts,
    type DetailFacts,
    type DetailFactsMessage,
} from './detail';
import { replyToPage, watchPageResponses } from './pageApi';
import { MESSAGE_SOURCE } from './types';

export function installDetailWatch(): void {
    watchPageResponses(
        // The URL is parsed twice — here to decide, and again below to use the
        // result. Deliberate: the seam in pageApi.ts takes a URL and nothing else,
        // so it stays a general "watch responses matching this" rather than
        // learning the shape of this one feature. The cost is a regex over a short
        // string.
        (url) => detailRefFromApiUrl(url) !== null,
        (url, body) => {
            const ref = detailRefFromApiUrl(url);
            if (!ref) return;
            const facts = ref.from === 'history' ? readHistoryFacts(body) : readDescribeFacts(body);
            // Nothing to say is not worth a message: the ISOLATED side would merge
            // it into what it already has, redraw the same card, and log a round
            // trip that never changed anything.
            if (!worthPosting(facts)) return;

            // NOT filtered against location.pathname here, on purpose. The page may
            // have navigated between the request and the response, and deciding
            // whether an answer belongs on screen is the receiver's job — it is the
            // one holding the DOM. Doing it in both places would be two rules to
            // keep in agreement; see acceptFactsFor() in detail.ts for the one that
            // counts. Nothing is leaked by posting it either way: these facts came
            // out of a response the page itself received.
            const message: DetailFactsMessage = {
                source: MESSAGE_SOURCE,
                type: 'detail-facts',
                from: ref.from,
                namespace: ref.namespace,
                workflowId: ref.workflowId,
                runId: ref.runId,
                facts,
            };
            replyToPage(message);
        },
    );
}

function worthPosting(facts: DetailFacts): boolean {
    if (facts.activities.length > 0) return true;
    return (
        facts.workflowType !== null ||
        facts.taskQueue !== null ||
        facts.status !== null ||
        facts.startTimeMs !== null ||
        facts.endTimeMs !== null
    );
}
