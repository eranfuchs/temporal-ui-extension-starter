// ONE pacer for the whole extension, and the decoder for a refusal.
//
// THIS FILE IS THE DIFFERENCE BETWEEN 02 AND 03 THAT IS NOT A FEATURE.
//
// In 02 there is exactly one feature that issues requests, so the pacer instance
// lives in the file that issues them (`rowInfoServe.ts`) and the argument is easy
// to check by reading that one file: four at a time, and there is nowhere else a
// fetch can be added from.
//
// 03 has a second one. If the payload fetch had built its own `makePacer(…)` —
// the obvious thing to do, and it type-checks — the extension would hold TWO
// independent limits of four, so a user hovering rows while a hundred-row list
// filled its last-event column would put eight requests in the air against a
// cap the README calls four. Neither module would look wrong on its own. That is
// the failure mode this file exists to remove: the instance is a module-level
// const HERE, imported by both servers, so "four at a time" is a property of the
// EXTENSION rather than of a feature.
//
// WHAT THE NUMBER COVERS, stated here because this is the file a reader opens to
// check it: requests to TEMPORAL. Both servers' history, list and describe calls go
// through pacer.run() and nothing else can reach the API without one. The CODEC POST
// is deliberately outside the cap — a 429 from a decoder is its own business (see
// viaCodecServer in payloadServe.ts), and letting a slow codec server hold one of
// four Temporal slots would make the page's own columns wait on someone's laptop. So
// the honest ceiling is four Temporal requests in flight, plus one codec request per
// payload panel that has already got past its history fetch — in practice one,
// because a hover is a hand.
//
// The generic, testable machinery is still src/pacer.ts, with the clock and the
// sleep injected. This file is only the instance and its limits.

import { TAG } from './pageApi';
import { makePacer } from './pacer';

export const pacer = makePacer(
    { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    {
        // A hundred running rows is two hundred requests; fired at once they arrive
        // as a burst that looks, from the server's side, exactly like an attack.
        // Four at a time turns it into a queue that drains in seconds.
        maxConcurrent: 4,
        backoffStartMs: 2_000,
        backoffCeilingMs: 60_000,
        // A Retry-After longer than this is honoured up to here and no further; see
        // PacerLimits for why a server-supplied wait needs a ceiling of its own.
        advisedCeilingMs: 300_000,
    },
);

// Turns a non-OK response into the error that will be shown, and applies backoff
// when the server said to slow down.
//
// 429 and 503 are the two that mean "later, not never". Everything else (403 on a
// namespace the token cannot read, 404 on a run that has been archived) is a
// permanent answer for this run, and pausing every other row because of it would
// be wrong.
//
// Shared with the pacer for the same reason: a 429 arrives on whichever request
// happened to be in flight, and the pause it buys has to apply to all of them.
// Two copies of this function would each have paused their own feature.
export function refuse(response: Response, what: string): never {
    if (response.status === 429 || response.status === 503) {
        const wait = pacer.noteRateLimit(response.headers.get('retry-after'));
        console.warn(TAG, `rate-limited by the Temporal API — pausing requests for ${Math.round(wait / 1000)}s`);
        throw new Error(`Temporal is rate-limiting this page; ${what} will be retried shortly.`);
    }
    throw new Error(`${what} failed: HTTP ${response.status}`);
}
