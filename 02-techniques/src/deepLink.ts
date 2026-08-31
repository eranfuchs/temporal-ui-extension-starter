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
//
// ── TWO SCOPES, ONE VOCABULARY ───────────────────────────────────────────────
//
// A template that mentions an ACTIVITY token is a link about one activity, and a
// template that does not is a link about the whole workflow. That is the only
// difference between them, and it is DERIVED from the template's own text
// (templateScope below) rather than declared in a second settings field.
//
// The alternative — a `scope: 'workflow' | 'activity'` dropdown beside every
// template — was written first and thrown away. It could disagree with the
// template, so every consumer needed a rule for "activity-scoped but uses no
// activity token" and for its opposite, and the popup grew a control whose only
// job was to be kept in sync with a string the user had already typed.
//
// The workflow list therefore shows workflow-scoped links only (an activity token
// has nothing to fill from a table row), and a workflow's own page shows both:
// the workflow-scoped ones once, and the activity-scoped ones per activity. Add
// `{activityType}` to a template and it moves between the two, with nothing else
// to change.

import type { WorkflowRow } from './types';

export interface DeepLinkTemplate {
    label: string;
    urlTemplate: string;
}

// One activity, reduced to the four things a link can be built from. Everything
// here comes out of the workflow's own history — see src/detail.ts, which folds
// it — and none of it is a payload.
export interface DeepLinkActivity {
    // Caller-chosen, and often built out of a business identifier, which is why
    // the LIST page's retry badge deliberately does not show one (see the note at
    // the top of src/rowInfo.ts). Here it is different: it is the operator's own
    // template that names this token, on the page whose event history is already
    // showing the same string.
    activityId: string;
    activityType: string;
    // null while the activity is still running, and that is not a gap in the fold.
    // Temporal does not write ActivityTaskStarted into the history until the
    // activity has completed or failed for the last time, so a pending activity's
    // attempt count is simply not in the history yet — the Describe API is where
    // it lives, which is exactly why the list page's retry badge calls that
    // instead. https://docs.temporal.io/encyclopedia/retry-policies
    attempt: number | null;
    scheduledAtMs: number | null;
}

export interface DeepLinkContext {
    namespace: string;
    row: WorkflowRow;
    // Injected rather than read from Date.now() so this stays pure and the
    // tests do not depend on the clock.
    nowMs: number;
    // Set only for an activity-scoped link. Absent leaves every activity token
    // unresolved — reported as an unknown token rather than filled with a guess,
    // which is what makes a template pasted into the wrong scope say so.
    activity?: DeepLinkActivity | null;
}

export interface ExpandResult {
    // The expanded template, exactly as it came out. Shown to the user; NEVER
    // assigned to an href without going through `href` below.
    url: string;
    // The same string when it is safe to open, null when it is not. See
    // safeHref() for what "safe" means and why the check cannot live in the
    // popup alone.
    href: string | null;
    // Tokens in the template that we do not know how to fill. Surfaced in the
    // popup instead of being silently left in the URL, where they turn into a
    // log search for the literal text "{workflowid}" and zero results.
    unknownTokens: string[];
}

// ── Which URLs may be opened ─────────────────────────────────────────────────

// The only two schemes that reach an href.
//
// The others are not hypothetical. `javascript:` in an href runs script inside
// the Temporal page on click — same origin, same session, full access to
// whatever the page can see. `data:` and `blob:` open a document that can
// impersonate one. `file:` reads the user's disk. Each is a template one typo
// away from something that still looks like a URL in a settings field.
//
// And the scheme is not always the user's to choose. A template of just
// `{workflowId}` puts data the extension does not control in the scheme
// position, so a workflow named `javascript:…` would become the href — which is
// why this runs on the EXPANDED url on every render, not once on the template.
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// The URL if it may be opened, otherwise null.
//
// Deliberately a validator and not a normaliser: it returns the caller's own
// string untouched, because re-serialising a URL silently re-encodes parts of
// the query and some log tools are particular about that. The parse is only used
// to answer the scheme question — and it answers it correctly for the tricks the
// href setter would otherwise fall for, because both use the same URL parser.
// `java\nscript:alert(1)` parses as `javascript:` here for exactly the reason
// the browser would treat it as script: the parser strips those characters.
export function safeHref(url: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // Not an absolute URL. A relative one would resolve against Temporal's
        // own origin, which is never where anyone's log tool lives, so there is
        // nothing to be gained by guessing a base for it.
        return null;
    }
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? url : null;
}

// Could this template ever produce an openable link? For the popup, so a bad
// template is caught where it is typed instead of becoming a dead button. The
// per-row check on the expanded URL still runs regardless — see above.
export function templateIsSafe(template: string): boolean {
    return safeHref(template) !== null;
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
    return { url, href: safeHref(url), unknownTokens };
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

        // The activity tokens. Each returns null when there is no activity in
        // context, and null again when the activity has that field but Temporal
        // has not filled it — an unknown token is the honest answer for both, and
        // it is the one the popup and the link's own title report.
        case 'activityId':
            return ctx.activity?.activityId ?? null;
        case 'activityType':
            return ctx.activity?.activityType ?? null;
        case 'activityAttempt':
            return ctx.activity?.attempt == null ? null : String(ctx.activity.attempt);
        case 'activityScheduledMs':
            return ctx.activity?.scheduledAtMs == null ? null : String(ctx.activity.scheduledAtMs + shift);
        case 'activityScheduledIso':
            return ctx.activity?.scheduledAtMs == null
                ? null
                : new Date(ctx.activity.scheduledAtMs + shift).toISOString();
        case 'activityScheduledSec':
            return ctx.activity?.scheduledAtMs == null
                ? null
                : String(Math.floor((ctx.activity.scheduledAtMs + shift) / 1000));

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

// The tokens that need an activity. Membership in this list is what makes a
// template activity-scoped, so it is a list and not a `startsWith('activity')`
// test: a misspelled `{activityTyp}` then stays an unknown token on a
// workflow-scoped link — visible, in the popup and in the link's title — instead
// of silently moving the whole template to a page the user was not editing.
const ACTIVITY_TOKENS = new Set([
    'activityId',
    'activityType',
    'activityAttempt',
    'activityScheduledIso',
    'activityScheduledMs',
    'activityScheduledSec',
]);

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
    ...ACTIVITY_TOKENS,
] as const;

// The token NAMES a template mentions, in order, without duplicates. Uses the
// same regex the expansion does, so "which tokens are in this template" cannot
// answer differently from "which tokens get filled".
export function tokensIn(template: string): string[] {
    const names: string[] = [];
    // matchAll works on a clone of the regex, so the shared TOKEN_RE's lastIndex
    // is not carried between calls here and in expandTemplate.
    for (const match of template.matchAll(TOKEN_RE)) {
        const name = match[1]!;
        if (!names.includes(name)) names.push(name);
    }
    return names;
}

export type TemplateScope = 'workflow' | 'activity';

// WHERE this template's button belongs, read off the template itself. See the
// note at the top of this file for why it is derived rather than stored.
export function templateScope(template: string): TemplateScope {
    return tokensIn(template).some((name) => ACTIVITY_TOKENS.has(name)) ? 'activity' : 'workflow';
}

export function templatesInScope(templates: DeepLinkTemplate[], scope: TemplateScope): DeepLinkTemplate[] {
    return templates.filter((template) => templateScope(template.urlTemplate) === scope);
}
