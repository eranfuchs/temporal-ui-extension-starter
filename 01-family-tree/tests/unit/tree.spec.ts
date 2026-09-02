import { describe, expect, it } from 'vitest';

import { buildTree, countFamilies } from '../../src/family/tree';
import { normalizeExecutions } from '../../src/family/rows';
import { apiWorkflow, fakeRunId } from '../helpers';

const ids = (rows: { workflowId: string }[]) => rows.map((r) => r.workflowId);

describe('buildTree', () => {
    it('leaves a flat page flat', () => {
        const rows = normalizeExecutions([
            apiWorkflow({ workflowId: 'a', startTime: '2026-01-01T00:00:00Z', closeTime: '2026-01-01T00:05:00Z' }),
            apiWorkflow({ workflowId: 'b', startTime: '2026-01-01T00:01:00Z', closeTime: '2026-01-01T00:09:00Z' }),
        ]);
        const ordered = buildTree(rows);
        expect(ordered).toHaveLength(2);
        expect(ordered.every((r) => r.depth === 0)).toBe(true);
        expect(ordered.every((r) => r.segments.length === 0)).toBe(true);
        expect(countFamilies(ordered)).toBe(0);
    });

    it('puts children after their parent, oldest first', () => {
        const parentRun = fakeRunId(1);
        const ordered = buildTree(
            normalizeExecutions([
                // Deliberately out of order in the input.
                apiWorkflow({
                    workflowId: 'child-late',
                    startTime: '2026-01-01T00:03:00Z',
                    parent: { workflowId: 'parent', runId: parentRun },
                }),
                apiWorkflow({ workflowId: 'parent', runId: parentRun, startTime: '2026-01-01T00:00:00Z' }),
                apiWorkflow({
                    workflowId: 'child-early',
                    startTime: '2026-01-01T00:01:00Z',
                    parent: { workflowId: 'parent', runId: parentRun },
                }),
            ]),
        );

        expect(ids(ordered)).toEqual(['parent', 'child-early', 'child-late']);
        expect(ordered.map((r) => r.depth)).toEqual([0, 1, 1]);
        expect(ordered[1]!.segments).toEqual(['branch']);
        expect(ordered[2]!.segments).toEqual(['last']);
        expect(countFamilies(ordered)).toBe(1);
    });

    it('draws the right columns three levels deep', () => {
        const root = fakeRunId(10);
        const first = fakeRunId(11);
        const second = fakeRunId(12);
        const ordered = buildTree(
            normalizeExecutions([
                apiWorkflow({ workflowId: 'root', runId: root, startTime: '2026-01-01T00:00:00Z' }),
                apiWorkflow({
                    workflowId: 'first',
                    runId: first,
                    startTime: '2026-01-01T00:01:00Z',
                    parent: { workflowId: 'root', runId: root },
                }),
                apiWorkflow({
                    workflowId: 'first-kid',
                    startTime: '2026-01-01T00:02:00Z',
                    parent: { workflowId: 'first', runId: first },
                }),
                apiWorkflow({
                    workflowId: 'second',
                    runId: second,
                    startTime: '2026-01-01T00:03:00Z',
                    parent: { workflowId: 'root', runId: root },
                }),
                apiWorkflow({
                    workflowId: 'second-kid',
                    startTime: '2026-01-01T00:04:00Z',
                    parent: { workflowId: 'second', runId: second },
                }),
            ]),
        );

        expect(ids(ordered)).toEqual(['root', 'first', 'first-kid', 'second', 'second-kid']);
        // 'first' has a sibling below it, so its child carries the trunk through.
        expect(ordered[2]!.segments).toEqual(['cont', 'last']);
        // 'second' is the last child, so its own child's column is blank.
        expect(ordered[4]!.segments).toEqual(['pad', 'last']);
    });

    it('keeps two runs of one workflow id apart', () => {
        // The failure this guards against is not cosmetic: keying by workflowId
        // alone attaches every child to every run of the id, which duplicates
        // rows and makes the whole table render flat.
        const runA = fakeRunId(20);
        const runB = fakeRunId(21);
        const ordered = buildTree(
            normalizeExecutions([
                apiWorkflow({ workflowId: 'cron', runId: runA, startTime: '2026-01-01T00:00:00Z' }),
                apiWorkflow({ workflowId: 'cron', runId: runB, startTime: '2026-01-01T01:00:00Z' }),
                apiWorkflow({
                    workflowId: 'kid-of-a',
                    startTime: '2026-01-01T00:10:00Z',
                    parent: { workflowId: 'cron', runId: runA },
                }),
                apiWorkflow({
                    workflowId: 'kid-of-b',
                    startTime: '2026-01-01T01:10:00Z',
                    parent: { workflowId: 'cron', runId: runB },
                }),
            ]),
        );

        expect(ordered).toHaveLength(4);
        const kidOfA = ordered.findIndex((r) => r.workflowId === 'kid-of-a');
        const kidOfB = ordered.findIndex((r) => r.workflowId === 'kid-of-b');
        expect(ordered[kidOfA - 1]!.runId).toBe(runA);
        expect(ordered[kidOfB - 1]!.runId).toBe(runB);
        expect(countFamilies(ordered)).toBe(2);
    });

    it('treats a child as a root when its parent is not on the page', () => {
        const ordered = buildTree(
            normalizeExecutions([
                apiWorkflow({
                    workflowId: 'orphan',
                    parent: { workflowId: 'parent-filtered-out', runId: fakeRunId(30) },
                }),
            ]),
        );
        expect(ordered).toHaveLength(1);
        expect(ordered[0]!.depth).toBe(0);
        expect(countFamilies(ordered)).toBe(0);
    });

    it('refuses to guess when a parent id matches more than one run', () => {
        // Two runs of 'ambiguous' are on the page and the child names no parent
        // run. Attaching it to either one would assert a lineage that may never
        // have happened, so it stays a root.
        const ordered = buildTree(
            normalizeExecutions([
                apiWorkflow({ workflowId: 'ambiguous', runId: fakeRunId(40) }),
                apiWorkflow({ workflowId: 'ambiguous', runId: fakeRunId(41) }),
                apiWorkflow({ workflowId: 'kid', parent: { workflowId: 'ambiguous' } }),
            ]),
        );
        expect(ordered.find((r) => r.workflowId === 'kid')!.depth).toBe(0);
    });

    it('attaches to the only run of a parent id when no parent run is named', () => {
        const ordered = buildTree(
            normalizeExecutions([
                apiWorkflow({ workflowId: 'sole', runId: fakeRunId(50), startTime: '2026-01-01T00:00:00Z' }),
                apiWorkflow({
                    workflowId: 'kid',
                    startTime: '2026-01-01T00:01:00Z',
                    parent: { workflowId: 'sole' },
                }),
            ]),
        );
        expect(ids(ordered)).toEqual(['sole', 'kid']);
        expect(ordered[1]!.depth).toBe(1);
    });

    it('sorts a family with a running member above a finished one', () => {
        const ordered = buildTree(
            normalizeExecutions([
                // Finished most recently — would sort first on recency alone.
                apiWorkflow({
                    workflowId: 'done',
                    status: 'COMPLETED',
                    startTime: '2026-01-01T05:00:00Z',
                    closeTime: '2026-01-01T06:00:00Z',
                }),
                apiWorkflow({
                    workflowId: 'has-running-child',
                    status: 'COMPLETED',
                    startTime: '2026-01-01T00:00:00Z',
                    closeTime: '2026-01-01T00:30:00Z',
                    runId: fakeRunId(60),
                }),
                // A finished parent with a still-running child is exactly the case
                // you open this list to find, so the family ranks first.
                apiWorkflow({
                    workflowId: 'still-running',
                    status: 'RUNNING',
                    startTime: '2026-01-01T00:10:00Z',
                    closeTime: null,
                    parent: { workflowId: 'has-running-child', runId: fakeRunId(60) },
                }),
            ]),
        );
        expect(ids(ordered)).toEqual(['has-running-child', 'still-running', 'done']);
    });

    it('counts only families that actually have children', () => {
        const parentRun = fakeRunId(70);
        const ordered = buildTree(
            normalizeExecutions([
                apiWorkflow({ workflowId: 'lonely' }),
                apiWorkflow({ workflowId: 'family', runId: parentRun }),
                apiWorkflow({ workflowId: 'kid', parent: { workflowId: 'family', runId: parentRun } }),
            ]),
        );
        expect(countFamilies(ordered)).toBe(1);
    });
});
