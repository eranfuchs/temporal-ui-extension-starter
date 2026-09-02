// The two messages the payload feature sends across the world boundary, and the
// guards that validate them.
//
// RESPONSIBILITY: the protocol, and nothing else. No fetch, no DOM, no history
// reading, no codec. Both worlds import this file — src/payloads/payloadClient.ts and
// src/payloads/tooltip.ts in the ISOLATED world, src/apiInject.ts and src/payloads/payloadServe.ts
// in the MAIN world — which is exactly why it is its own file: a fork of it would
// be a fork of the protocol, and the two halves would disagree about what a
// well-formed message is.
//
// It is the payload equivalent of src/rowInfo/rowInfo.ts, which does the same job for the
// per-row questions.
//
// BOTH GUARDS ARE SHAPE CHECKS AND NEITHER IS AUTHENTICATION. `window.postMessage`
// carries no sender identity that cannot be forged, and every field below is
// attacker-chooseable — `source` and `type` are two string literals published in
// this repository. What these functions buy is that a malformed message is rejected
// in one place instead of throwing halfway through a fetch or a render.
//
// The real authorisation is elsewhere, and differs by direction:
//
//   • Into the MAIN world: pageApi.ts answers the ids in a request only if the PAGE
//     ITSELF listed that run. Read the ledger note there before adding a field to
//     PayloadRequest.
//   • Into the ISOLATED world: payloadClient.ts keeps an answer only for a question
//     this side asked, about the run it asked about.

import { asObject, isText } from './valueGuards';
import { MESSAGE_SOURCE } from '../types';

export type PayloadKind = 'input' | 'outcome';

// A codec server, as the user typed it in the popup. Sent with every request
// rather than read from storage in the page world: the MAIN world holds no
// extension APIs, and it should not learn about settings it does not need.
//
// ONE FIELD, AND THE ABSENCES ARE THE DESIGN. Temporal's own UI offers to pass your
// access token to the codec server and to send cookies with the call. Both were
// built here and then deleted, not defaulted off, because this object arrives over
// postMessage: a credential flag beside a caller-chosen host is a credential a
// forged message can aim, and it would be aimed from the world that holds the live
// bearer. See "The credential switches that were deleted rather than defaulted off"
// in docs/design-notes.md.
export interface CodecConfig {
    endpoint: string;
}

export interface PayloadRequest {
    source: typeof MESSAGE_SOURCE;
    type: 'payload-request';
    // Correlates the answer with the hover that asked for it. Two hovers in
    // quick succession are two requests in flight, and the slower one must not
    // be rendered into the panel the faster one now owns.
    id: number;
    namespace: string;
    workflowId: string;
    runId: string;
    kind: PayloadKind;
    codec: CodecConfig;
}

export interface PayloadResult {
    source: typeof MESSAGE_SOURCE;
    type: 'payload-result';
    id: number;
    // Echoed back from the request, and checked by the asker before a word of
    // this reaches the screen — see answersTheQuestion() in payloadClient.ts.
    //
    // The id alone is not enough, and the reason is specific to THIS stage. In 02
    // a mismatched answer put a wrong event type in a cell; here the body of the
    // message is somebody's payload, so an answer landing in the wrong panel is
    // one customer's data displayed under another customer's workflow. The id is
    // a small integer starting at 1 in every tab, which makes it exactly the
    // thing a forged message guesses right by accident. All four fields have to
    // agree.
    namespace: string;
    workflowId: string;
    runId: string;
    kind: PayloadKind;
    // "Input", "Completed", "Failed" — the heading, not the body.
    label: string;
    text: string;
    // Set instead of text when we could not answer at all. Rendered as-is, so
    // every message here is written for a human looking at a tooltip.
    error: string | null;
    // The HOST of the codec server that decoded part of this answer, or null when
    // nothing was sent anywhere. Named in the panel, because "decrypted by a
    // server you configured" and "was never encrypted" must not look identical.
    decodedBy: string | null;
}

export function isPayloadRequest(value: unknown): value is PayloadRequest {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'payload-request') return false;
    if (typeof message['id'] !== 'number' || !Number.isFinite(message['id'])) return false;
    if (!isText(message['namespace']) || !isText(message['workflowId']) || !isText(message['runId'])) return false;
    if (!isKind(message['kind'])) return false;
    const codec = asObject(message['codec']);
    // `endpoint` is the whole config. Any other key a sender bothers to attach —
    // `includeCredentials`, `token` — is ignored here and unreadable downstream,
    // because nothing in the codec path takes a second parameter. See CodecConfig.
    return typeof codec?.['endpoint'] === 'string';
}

// TOTAL — every field, to the leaves — because this message travels INTO the
// isolated world, which is the side that renders. Validating to the leaves is what
// makes the panel's rendering honest: before it, the declared `text: string` was
// never checked, so `{text: {}}` reached `textContent = …` as "[object Object]",
// and an `error` of `0` rendered as a panel with no error and no body.
export function isPayloadResult(value: unknown): value is PayloadResult {
    const message = asObject(value);
    if (!message) return false;
    if (message['source'] !== MESSAGE_SOURCE || message['type'] !== 'payload-result') return false;
    if (typeof message['id'] !== 'number' || !Number.isFinite(message['id'])) return false;
    if (!isText(message['namespace']) || !isText(message['workflowId']) || !isText(message['runId'])) return false;
    if (!isKind(message['kind'])) return false;
    if (typeof message['label'] !== 'string' || typeof message['text'] !== 'string') return false;
    // `null` and only null for both, never `undefined`: an absent field is a
    // different message from one that says "asked, and there is nothing", and
    // every answer this repository builds sends the explicit null.
    if (!isNullOr(message['error'], (error) => typeof error === 'string')) return false;
    return isNullOr(message['decodedBy'], (host) => typeof host === 'string');
}

function isKind(value: unknown): value is PayloadKind {
    return value === 'input' || value === 'outcome';
}

function isNullOr(value: unknown, ok: (value: unknown) => boolean): boolean {
    return value === null || ok(value);
}
