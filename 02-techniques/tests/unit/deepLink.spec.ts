import { describe, expect, it } from 'vitest';

import { expandTemplate, KNOWN_TOKENS } from '../../src/deepLink';
import { normalizeExecutions } from '../../src/rows';
import { apiWorkflow, fakeRunId } from '../helpers';
import type { WorkflowRow } from '../../src/types';

const NOW_MS = Date.parse('2026-01-01T12:00:00Z');

function row(overrides: Parameters<typeof apiWorkflow>[0] = { workflowId: 'order-42' }): WorkflowRow {
    return normalizeExecutions([apiWorkflow(overrides)])[0]!;
}

const context = (r: WorkflowRow) => ({ namespace: 'sample-namespace', row: r, nowMs: NOW_MS });

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
        const r = row({ workflowId: 'x', runId: fakeRunId(1), taskQueue: 'q' });
        for (const token of KNOWN_TOKENS) {
            const result = expandTemplate(`{${token}}`, context(r));
            expect(result.unknownTokens, `token {${token}}`).toEqual([]);
        }
    });

    it('ignores an unparseable offset rather than shifting by a wrong amount', () => {
        const r = row({ workflowId: 'x', startTime: '2026-01-01T00:00:00Z' });
        // '{startTimeMs+99}' has no unit, so the token regex does not match it at
        // all: it stays verbatim and is not silently treated as milliseconds.
        expect(expandTemplate('{startTimeMs+99}', context(r)).url).toBe('{startTimeMs+99}');
    });
});
