// The two questions this extension asks of an unknown value inside a TEMPORAL API
// RESPONSE.
//
// RESPONSIBILITY: narrow `unknown` without asserting. Each of these returns
// something the caller can branch on; none of them throws, and none of them casts
// a value it has not checked.
//
// NOT for our own messages. Those have schemas — payloadRequestSchema and
// payloadResultSchema in payloadMessages.ts — because we own both ends of a
// postMessage and can therefore describe every field of it. A server response is the
// opposite case: the useful parts are three levels down inside a union of event
// attributes, most of the shape is never read, and a schema for it would be a
// transcription of somebody else's proto. These readers walk it instead.
//
// They are here rather than inlined because that walk happens in three files — the
// history reader, the codec planner and the formatter — and all three need the same
// "is this an object I can index?" test.
//
// src/rowInfo/rowInfo.ts and src/detail/detail.ts still carry their own copies. That is
// deliberate and not an oversight: both files exist in 02 as well, so a helper imported
// into them would have to exist in 02 too, and 02 does not have this file. The
// duplication is one three-line function.

export function asObject(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

// Non-empty, deliberately: every caller here treats '' as absent, and a field
// present but blank has never meant anything different in these messages.
export function asText(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}
