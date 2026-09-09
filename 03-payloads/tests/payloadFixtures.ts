// Fixtures for the payload specs — shared by payloads.spec.ts, codec.spec.ts and
// payloadMessages.spec.ts.
//
// RESPONSIBILITY: build inputs in the shape the SERVER sends, not in the shape the
// code under test would find convenient. That distinction is the whole value of this
// file: both payload fields are base64 in Temporal's JSON, and a fixture that skips
// the encoding would let every decode path pass without decoding anything.
//
// It is not in tests/helpers.ts because every project carries that file, and 02 has
// no payload path to build fixtures for.

import { fakeRunId } from './helpers';

// Via TextEncoder, so a non-ASCII fixture is real UTF-8 rather than one byte per
// character. `btoa` alone would throw on 'café'.
export function b64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    return btoa(String.fromCharCode(...bytes));
}

export interface FixturePayload {
    metadata?: Record<string, string> | null;
    data?: string | null;
}

export function payload(encoding: string, data: string): FixturePayload {
    return { metadata: { encoding: b64(encoding) }, data: b64(data) };
}

// A history event, in the shape the API returns: the attributes hang off a key
// named after the event type. `eventType` is included because the real response
// has it — and deliberately never read.
export function event(attributesKey: string, attributes: Record<string, unknown>, eventType = 'Whatever'): unknown {
    return { eventId: '1', eventType, [attributesKey]: attributes };
}

export const FIXTURE_RUN_ID = fakeRunId(1);
