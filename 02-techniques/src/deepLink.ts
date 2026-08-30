// Templated deep-links: "open this workflow in OUR log tool".
//
// This is the part of the extension most teams will actually adopt first.
// Everyone correlates a Temporal workflow against logs, and everyone does it by
// copying an id out of the UI and pasting it into a different tab. A per-row
// button that carries the id AND the workflow's time window removes that step.
//
// The template is a string in extension settings, so pointing this at Splunk,
// Loki/Grafana, Datadog, CloudWatch, Kibana or an internal tool is a settings
// change and not a code change.
//
// Token syntax:  {name}  {name:raw}  {name-10m}  {name:raw+1h}
//
//   {workflowId}      percent-encoded, ready to drop into a query string
//   {workflowId:raw}  verbatim — for the rare tool that wants it unencoded
//   {startTimeIso-10m}  the start time, shifted 10 minutes earlier
//
// The offset exists because a log query needs a WINDOW, and the useful window
// is almost never exactly the workflow's own start and end: the request that
// triggered it was logged before it started, and the failure you are chasing is
// often logged after it closed.

import type { WorkflowRow } from './types';

export interface DeepLinkTemplate {
    label: string;
    urlTemplate: string;
}

export interface DeepLinkContext {
    namespace: string;
    row: WorkflowRow;
    // Injected rather than read from Date.now() so this stays pure and the
    // tests do not depend on the clock.
    nowMs: number;
}

export interface ExpandResult {
    url: string;
    // Tokens in the template that we do not know how to fill. Surfaced in the
    // popup instead of being silently left in the URL, where they turn into a
    // log search for the literal text "{workflowid}" and zero results.
    unknownTokens: string[];
}

const TOKEN_RE = /\{([A-Za-z]+)(:raw)?([+-]\d+[smhd])?\}/g;

const OFFSET_UNIT_MS: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};

export function expandTemplate(template: string, ctx: DeepLinkContext): ExpandResult {
    const unknownTokens: string[] = [];
    const url = template.replace(TOKEN_RE, (whole, name: string, raw: string | undefined, offset: string | undefined) => {
        const value = resolveToken(name, offset, ctx);
        if (value === null) {
            unknownTokens.push(whole);
            return whole;
        }
        return raw ? value : encodeURIComponent(value);
    });
    return { url, unknownTokens };
}

function resolveToken(name: string, offset: string | undefined, ctx: DeepLinkContext): string | null {
    const { row } = ctx;
    const shift = offsetMs(offset);

    // A still-running workflow has no close time. Treating "now" as its end is
    // the only answer that produces a usable log window; the alternative —
    // an empty `to` — silently truncates the search at the start time.
    const endMs = row.endTimeMs ?? ctx.nowMs;

    switch (name) {
        case 'workflowId':
            return row.workflowId;
        case 'runId':
            return row.runId;
        case 'workflowType':
            return row.workflowType;
        case 'namespace':
            return ctx.namespace;
        case 'taskQueue':
            return row.taskQueue ?? '';
        case 'status':
            return row.status;
        case 'startTimeMs':
            return String(row.startTimeMs + shift);
        case 'startTimeIso':
            return new Date(row.startTimeMs + shift).toISOString();
        case 'startTimeSec':
            return String(Math.floor((row.startTimeMs + shift) / 1000));
        case 'endTimeMs':
            return String(endMs + shift);
        case 'endTimeIso':
            return new Date(endMs + shift).toISOString();
        case 'endTimeSec':
            return String(Math.floor((endMs + shift) / 1000));
        default:
            return null;
    }
}

function offsetMs(offset: string | undefined): number {
    if (!offset) return 0;
    const sign = offset[0] === '-' ? -1 : 1;
    const amount = Number(offset.slice(1, -1));
    const unit = offset[offset.length - 1]!;
    const unitMs = OFFSET_UNIT_MS[unit];
    if (!Number.isFinite(amount) || unitMs === undefined) return 0;
    return sign * amount * unitMs;
}

// Every token this build understands, for the popup's help text. Kept next to
// the switch above so the two cannot drift apart unnoticed.
export const KNOWN_TOKENS = [
    'workflowId',
    'runId',
    'workflowType',
    'namespace',
    'taskQueue',
    'status',
    'startTimeIso',
    'startTimeMs',
    'startTimeSec',
    'endTimeIso',
    'endTimeMs',
    'endTimeSec',
] as const;
