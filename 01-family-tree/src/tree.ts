// buildTree — the whole feature, in one pure function.
//
// In: the rows the page is showing, in whatever order the API returned them.
// Out: the same row objects, re-ordered so children follow their parent, each
//      annotated with a depth and the connector columns to draw.
//
// Nothing here touches the DOM or the network. That is deliberate: the ordering
// rules are where the judgement calls live, and judgement calls deserve unit
// tests (see tests/unit/tree.spec.ts) rather than a browser and a screenshot.

import type { SegmentKind, WorkflowRow } from './types';
import { runKey } from './rows';

export function buildTree(rows: WorkflowRow[]): WorkflowRow[] {
    // Index by (workflowId, runId), NOT by workflowId alone.
    //
    // A single page can show SEVERAL RUNS of one workflow id — a workflow that
    // was terminated and re-run, or a cron. Keying by workflowId collapses
    // them: the last one wins, and every child naming that id gets attached to
    // every run of it. The visible symptom is not a slightly-wrong tree, it is
    // a tree with duplicated rows that no longer maps onto the table, which
    // makes the whole list render flat.
    const byRun = new Map<string, WorkflowRow>();
    for (const r of rows) byRun.set(runKey(r.workflowId, r.runId), r);

    // Fallback index, used only when a row names a parent id but no parent run.
    const byWorkflowId = new Map<string, WorkflowRow[]>();
    for (const r of rows) {
        const list = byWorkflowId.get(r.workflowId) ?? [];
        list.push(r);
        byWorkflowId.set(r.workflowId, list);
    }

    // Resolve a row's parent to a SPECIFIC run, or null when it cannot be
    // pinned down. Returning null makes the row a root, which is the honest
    // outcome: attaching it to an arbitrary run asserts a lineage that never
    // happened.
    const parentKeyOf = (r: WorkflowRow): string | null => {
        if (!r.parentWorkflowId) return null;
        if (r.parentRunId) {
            const key = runKey(r.parentWorkflowId, r.parentRunId);
            return byRun.has(key) ? key : null;
        }
        const candidates = byWorkflowId.get(r.parentWorkflowId);
        if (candidates && candidates.length === 1) {
            const only = candidates[0]!;
            return runKey(only.workflowId, only.runId);
        }
        return null;
    };

    const children = new Map<string, WorkflowRow[]>();
    const roots: WorkflowRow[] = [];
    for (const r of rows) {
        const parentKey = parentKeyOf(r);
        if (parentKey === null) {
            roots.push(r);
            continue;
        }
        const list = children.get(parentKey) ?? [];
        list.push(r);
        children.set(parentKey, list);
    }

    // Order families by "what should I look at first": anything still running,
    // then whatever was most recently active. A family counts as running if ANY
    // member is — a finished parent with a stuck child is exactly the case you
    // opened this list to find.
    const familyHasRunning = new Map<string, boolean>();
    const familyLastActivity = new Map<string, number>();
    for (const root of roots) {
        const key = runKey(root.workflowId, root.runId);
        let hasRunning = false;
        let lastActivity = -Infinity;
        const stack: WorkflowRow[] = [root];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (node.status === 'Running') hasRunning = true;
            lastActivity = Math.max(lastActivity, node.endTimeMs ?? node.startTimeMs);
            const kids = children.get(runKey(node.workflowId, node.runId));
            if (kids) stack.push(...kids);
        }
        familyHasRunning.set(key, hasRunning);
        familyLastActivity.set(key, lastActivity);
    }
    roots.sort((a, b) => {
        const ka = runKey(a.workflowId, a.runId);
        const kb = runKey(b.workflowId, b.runId);
        const ra = familyHasRunning.get(ka) ? 0 : 1;
        const rb = familyHasRunning.get(kb) ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return (familyLastActivity.get(kb) ?? 0) - (familyLastActivity.get(ka) ?? 0);
    });

    const ordered: WorkflowRow[] = [];
    const walk = (
        node: WorkflowRow,
        depth: number,
        isLastChild: boolean,
        ancestorHasMoreSiblings: boolean[],
    ): void => {
        node.depth = depth;
        if (depth === 0) {
            node.segments = [];
        } else {
            const segments: SegmentKind[] = [];
            for (let i = 0; i < depth - 1; i++) {
                segments.push(ancestorHasMoreSiblings[i] ? 'cont' : 'pad');
            }
            segments.push(isLastChild ? 'last' : 'branch');
            node.segments = segments;
        }
        ordered.push(node);

        // Children oldest-first: a child list reads as a sequence of steps, and
        // steps run forwards.
        const kids = (children.get(runKey(node.workflowId, node.runId)) ?? [])
            .slice()
            .sort((a, b) => a.startTimeMs - b.startTimeMs);
        kids.forEach((kid, i) => {
            const last = i === kids.length - 1;
            walk(kid, depth + 1, last, [...ancestorHasMoreSiblings, !last]);
        });
    };
    for (const root of roots) walk(root, 0, true, []);

    return ordered;
}

// How many families on this page actually have a parent-child pair in them.
//
// The popup shows this, because "the tree does nothing" is nearly always "your
// filter returned children whose parents are not on this page", and a count of
// 0 says that far better than an empty-looking table does.
//
// Takes buildTree's OUTPUT: in a pre-order walk, a family with children is a
// depth-0 row immediately followed by a deeper one. That makes this exact and
// O(n) instead of a re-derivation of the ancestry.
export function countFamilies(orderedRows: WorkflowRow[]): number {
    let families = 0;
    for (let i = 0; i < orderedRows.length - 1; i++) {
        if (orderedRows[i]!.depth === 0 && orderedRows[i + 1]!.depth > 0) families++;
    }
    return families;
}
