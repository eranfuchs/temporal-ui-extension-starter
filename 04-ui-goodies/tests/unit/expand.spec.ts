// src/family/expand.ts: no DOM here, just root collection and the three edge
// cases the brief calls out by name — none, too many, and unquotable.

import { describe, expect, it } from 'vitest';

import { buildExpandVerdict, collectFamilyRoots, MAX_EXPAND_ROOTS } from '../../src/family/expand';
import { normalizeExecutions } from '../../src/family/rows';
import { apiWorkflow } from '../helpers';

describe('collectFamilyRoots', () => {
    it('dedupes to one root per family, first-seen order', () => {
        const rows = normalizeExecutions([
            apiWorkflow({ workflowId: 'a', root: { workflowId: 'root-1' } }),
            apiWorkflow({ workflowId: 'b', root: { workflowId: 'root-2' } }),
            apiWorkflow({ workflowId: 'c', root: { workflowId: 'root-1' } }),
        ]);
        expect(collectFamilyRoots(rows)).toEqual(['root-1', 'root-2']);
    });

    it('is empty for an empty page', () => {
        expect(collectFamilyRoots([])).toEqual([]);
    });
});

describe('buildExpandVerdict', () => {
    it('reports no-roots for an empty page rather than building a query for nothing', () => {
        expect(buildExpandVerdict('ExecutionStatus = "Failed"', [])).toEqual({ kind: 'no-roots' });
    });

    it('ORs an IN-clause of the roots onto whatever query was already there', () => {
        expect(buildExpandVerdict('ExecutionStatus = "Failed"', ['root-1', 'root-2'])).toEqual({
            kind: 'query',
            query: '(ExecutionStatus = "Failed") OR (RootWorkflowId IN ("root-1", "root-2"))',
            rootCount: 2,
        });
    });

    it('is just the IN-clause when there was no existing query to widen', () => {
        expect(buildExpandVerdict('', ['root-1'])).toEqual({
            kind: 'query',
            query: 'RootWorkflowId IN ("root-1")',
            rootCount: 1,
        });
    });

    it('refuses at one root past the cap, naming the count', () => {
        const roots = Array.from({ length: MAX_EXPAND_ROOTS + 1 }, (_, i) => `root-${i}`);
        expect(buildExpandVerdict('', roots)).toEqual({ kind: 'too-many', rootCount: MAX_EXPAND_ROOTS + 1 });
    });

    it('accepts exactly the cap', () => {
        const roots = Array.from({ length: MAX_EXPAND_ROOTS }, (_, i) => `root-${i}`);
        const verdict = buildExpandVerdict('', roots);
        expect(verdict.kind).toBe('query');
    });

    it('declines rather than silently drop the one unquotable root', () => {
        expect(buildExpandVerdict('', ['fine', `both ' and " here`])).toEqual({ kind: 'unquotable' });
    });
});
