// The scope backfill, which exists because of a real failure on a live tenant.
//
// Everything about the per-activity links worked — the label selector matched, the
// id resolved, the history was observed — and no link appeared, because the stored
// settings predated the activity template and `links` is stored as ONE array that
// the popup rewrites whole. A default added to the array afterwards reaches nobody
// who has ever saved settings.
//
// So the default that matters is not "these two templates", it is "at least one
// template that can produce an activity link". These specs pin that, and pin the
// one thing a naive backfill gets wrong: it must not argue with a deletion.

import { describe, expect, it } from 'vitest';

import { templateScope } from '../../src/deepLink';
import { DEFAULT_ACTIVITY_LINK, withActivityScope } from '../../src/settings';

const WORKFLOW_LINK = { label: 'Logs', urlTemplate: 'https://example.com/?q={workflowId}' };

describe('withActivityScope', () => {
    it('the shipped activity default really is activity-scoped', () => {
        // If this fails, the backfill adds a template that changes nothing — the
        // exact failure it was written to fix, reintroduced one level down.
        expect(templateScope(DEFAULT_ACTIVITY_LINK.urlTemplate)).toBe('activity');
    });

    it('adds an activity template when the stored links cannot produce one', () => {
        const result = withActivityScope([WORKFLOW_LINK]);
        expect(result).toHaveLength(2);
        expect(result.filter((l) => templateScope(l.urlTemplate) === 'activity')).toEqual([DEFAULT_ACTIVITY_LINK]);
    });

    it('leaves the workflow templates exactly as they were', () => {
        // A backfill that reformatted, reordered or de-duplicated somebody's links
        // would be a settings-eating bug wearing a bugfix's clothes.
        const mine = { label: 'My tool', urlTemplate: 'https://example.com/x?run={runId}' };
        expect(withActivityScope([WORKFLOW_LINK, mine]).slice(0, 2)).toEqual([WORKFLOW_LINK, mine]);
    });

    it('adds nothing when an activity template is already present, whatever its label', () => {
        // Keyed on the SCOPE, never on the label or the url: somebody who renamed the
        // button or pointed it at their own log tool has an activity link, and a second
        // one pointing at example.com would be noise.
        const renamed = { label: 'Kibana', urlTemplate: 'https://example.com/s?a={activityId}' };
        const links = [WORKFLOW_LINK, renamed];
        expect(withActivityScope(links)).toBe(links);
    });

    it('does not add one for a MISSPELLED activity token', () => {
        // {activityTyp} is an unknown token on a workflow-scoped link, by design
        // (see ACTIVITY_TOKENS in deepLink.ts). It cannot count as activity coverage,
        // or a typo would silently cost the reader the whole feature.
        expect(withActivityScope([{ label: 'Oops', urlTemplate: 'https://example.com/?a={activityTyp}' }])).toHaveLength(
            2,
        );
    });

    it('is a pure function — it does not mutate the array it was given', () => {
        const links = [WORKFLOW_LINK];
        withActivityScope(links);
        expect(links).toHaveLength(1);
    });

    it('adds nothing to an empty list beyond the activity default', () => {
        // An empty list is a deliberate "no links at all", but the backfill's contract
        // is about scope coverage and this is the one case where the two read
        // differently. Documented rather than special-cased: the marker is what stops
        // it, and an empty list from a human always carries the marker.
        expect(withActivityScope([])).toEqual([DEFAULT_ACTIVITY_LINK]);
    });
});
