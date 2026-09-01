// Serves one `payload-request`: fetch a single history event, decode what can be
// decoded in the browser, and send only what cannot to the codec server named in
// the request.
//
// Runs in the MAIN world. It holds no access of its own — every request it makes
// goes through pageApi.ts, which decides whether the run may be fetched at all
// and chooses the origin. Read the trust-boundary note at the top of that file
// before changing anything here; this file is one of its callers, not the gate.
//
// The history fetch is paced by the SAME instance as the per-row questions (see
// src/requestPacing.ts). A second pacer here would have been the natural thing to
// write and would have quietly doubled the concurrency cap the README declares.
//
// The codec POST is NOT inside that slot, and the README says four TEMPORAL
// requests for that reason. `pacer.run()` wraps the history fetch only; by the time
// render() posts to the codec server the slot is released, so N open panels against
// one codec destination can be N POSTs. Fine for a codec server on your own
// machine, which is the case this stage is built for; a note in the project README
// says what a shared one would need.
//
// WHAT IS NOT CLOSED. `postMessage` carries no sender identity, so a hostile script
// on the page can post a well-formed request and get an answer: no gesture, any run
// the ledger still retains rather than only the row under the cursor, the
// locally-decodable payloads back as readable plaintext, and the unreadable ones
// POSTed to a codec host the message itself names. The ledger keeps that from being
// an arbitrary-history read and no credential of ours is attached anywhere on the
// path, but an unauthenticated bus cannot tell an honest hover from a forged one and
// no amount of validation in this file changes that. Closing it needs the request to
// arrive by a channel a page script cannot write — chrome.scripting.executeScript,
// and therefore host_permissions, which this project deliberately does not take.
//
// Stated once at full width, with the argument for accepting it and the reason an
// earlier flattering version of it was wrong: the security card in README.md,
// "The weakness, and what closing most of it took". One copy on purpose — this used
// to be a second full-length version of the same argument, which is three places to
// keep true and reads as anxiety rather than as a bound.

import { fetchFailureMessage, fetchForListedRun, fetchFromPageWorld, replyToPage } from './pageApi';
import {
    codecDecodeCall,
    extractInput,
    extractOutcome,
    formatPayloads,
    mergeDecoded,
    planCodecCall,
    readCodecResponse,
    safeCodecEndpoint,
    type Extracted,
    type PayloadRequest,
    type PayloadResult,
    type RawPayload,
} from './payloads';
import { pacer, refuse } from './requestPacing';
import { historyUrl } from './temporalApi';
import { MESSAGE_SOURCE } from './types';

export async function servePayloadRequest(request: PayloadRequest): Promise<void> {
    try {
        replyToPage({ ...blank(request), ...(await answer(request)) });
    } catch (err) {
        replyToPage({ ...blank(request), error: fetchFailureMessage(err) });
    }
}

async function answer(request: PayloadRequest): Promise<Partial<PayloadResult>> {
    // Input is the FIRST event of the history; the outcome is the LAST, which is
    // what the reverse route exists for. One event either way — historyUrl defaults
    // maximumPageSize to 1, which is what keeps a hover off a hundred-thousand-event
    // workflow from being a hundred-thousand-event download.
    const history = await pacer.run(async () => {
        const response = await fetchForListedRun(request.namespace, request, (target) =>
            historyUrl({ ...target, direction: request.kind === 'input' ? 'forward' : 'reverse' }),
        );
        // The same refusal decoder as the per-row questions: a 429 pauses everything
        // this extension is doing, not just the hovers.
        if (!response.ok) refuse(response, `reading the ${request.kind === 'input' ? 'input' : 'result'}`);
        pacer.noteSuccess();
        return (await response.json()) as unknown;
    });

    const found = request.kind === 'input' ? extractInput(history) : extractOutcome(history);
    if (!found) {
        return {
            label: request.kind === 'input' ? 'Input' : 'Result',
            text: request.kind === 'input' ? 'No start event in the history.' : 'No close event yet.',
        };
    }
    return await render(found, request);
}

async function render(found: Extracted, request: PayloadRequest): Promise<Partial<PayloadResult>> {
    let payloads = found.payloads;
    let decodedBy: string | null = null;

    // safeCodecEndpoint, not the raw setting: an endpoint that would put decrypted
    // payloads on the wire in the clear is treated as no endpoint at all. And no
    // endpoint is not an error — decodePayload() says so per payload, in place, and
    // nothing leaves the machine.
    const endpoint = safeCodecEndpoint(request.codec.endpoint);
    const plan = planCodecCall(payloads);
    if (endpoint && plan.send.length > 0) {
        payloads = mergeDecoded(payloads, plan, await viaCodecServer(endpoint, plan.send, request));
        decodedBy = new URL(endpoint).host;
    }

    const body = formatPayloads(payloads);
    const text = [found.note, body].filter((part) => part).join('\n\n');
    return { label: found.label, text: text || '(nothing recorded)', decodedBy };
}

async function viaCodecServer(
    endpoint: string,
    payloads: RawPayload[],
    request: PayloadRequest,
): Promise<RawPayload[]> {
    // `payloads` here is plan.send — only what could not be read in the browser.
    // No credential is a parameter of this call and none can be made one from a
    // message: codecDecodeCall has no Authorization parameter, and the call it
    // returns is typed so that it cannot carry `credentials` at all —
    // fetchFromPageWorld, which sends it, sets that to 'omit' itself and rejects a
    // credential-bearing header. Enforced at the boundary rather than here, so it
    // stays true for the next caller. See the CodecConfig note in payloads.ts.
    const { url, init } = codecDecodeCall({
        endpoint,
        namespace: request.namespace,
        payloads,
    });
    const response = await fetchFromPageWorld(url, init);
    if (!response.ok) {
        // A codec server that is up but refusing is the common case here, and "it
        // says nothing" would send someone to the wrong place. 401/403 means the
        // server authenticates its callers, and this extension cannot satisfy that:
        // it sends no token and no cookies, by deletion rather than by default.
        // There is no popup switch to suggest, so the message says what to change
        // instead of naming one. A failure with no status at all is usually the
        // server's CORS headers, which the browser reports only to the console.
        //
        // NOT refuse(): a codec server's 429 is its own business, and pausing every
        // Temporal request in the tab because a decoder is busy would be wrong.
        const hint =
            response.status === 401 || response.status === 403
                ? ' It authenticates its callers; this extension sends no credentials of any kind, so point it at a codec server that does not require them.'
                : ' Check its CORS headers.';
        throw new Error(`Codec server ${new URL(endpoint).host} answered HTTP ${response.status}.${hint}`);
    }
    return readCodecResponse(await response.json(), payloads.length);
}

// The envelope every answer is built on, correlation fields included.
//
// The three run fields are echoed from the request rather than looked up anywhere,
// exactly as rowInfoServe.ts does it: the answer names the question it answers, and
// the isolated world keeps it only if that is a question it asked. A payload answer
// reaching the wrong row is worse than a wrong event type — it is somebody else's
// data on screen.
function blank(request: PayloadRequest): PayloadResult {
    return {
        source: MESSAGE_SOURCE,
        type: 'payload-result',
        id: request.id,
        namespace: request.namespace,
        workflowId: request.workflowId,
        runId: request.runId,
        kind: request.kind,
        label: request.kind === 'input' ? 'Input' : 'Result',
        text: '',
        error: null,
        decodedBy: null,
    };
}
