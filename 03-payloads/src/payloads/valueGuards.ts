// The three questions every guard in the payload path asks of an unknown value.
//
// RESPONSIBILITY: narrow `unknown` without asserting. Each of these returns
// something the caller can branch on; none of them throws, and none of them casts
// a value it has not checked.
//
// They are here rather than inlined because the payload path splits across four
// files — the message guards, the history reader, the codec planner and the
// formatter — and all four need the same "is this an object I can index?" test.
//
// src/rowInfo/rowInfo.ts and src/detail/detail.ts still carry their own copies. That is
// deliberate and not an oversight: both are registered as lineage-SHARED files, so
// a helper imported into them would have to be imported into 02's copies too, and
// 02 does not have this file. The duplication is one three-line function, and the
// lineage gate is what keeps the copies honest.

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

export function isText(value: unknown): value is string {
    return typeof value === 'string' && value !== '';
}
