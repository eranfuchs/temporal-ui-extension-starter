// API shape → our row shape. Pure, so it can be unit-tested without a browser.

import type { TemporalApiWorkflow, WorkflowRow } from './types';

// Identity of a single RUN, length-prefixed rather than joined with a separator.
//
// Workflow ids in the wild contain punctuation — pipes, slashes, colons — so any
// literal separator risks two different (workflowId, runId) pairs producing the
// same key. `12:my|wf|id:abc-123` cannot collide with a different split.
export function runKey(workflowId: string, runId: string): string {
    return `${workflowId.length}:${workflowId}:${runId}`;
}

export function normalizeExecutions(executions: TemporalApiWorkflow[]): WorkflowRow[] {
    const rows: WorkflowRow[] = [];
    for (const w of executions) {
        // A row without an execution id is not something we can place in a
        // tree or match to a table row; skip rather than invent an id.
        if (!w?.execution?.workflowId || !w.execution.runId) continue;
        const startMs = w.startTime ? Date.parse(w.startTime) : NaN;
        const endMs = w.closeTime ? Date.parse(w.closeTime) : NaN;
        rows.push({
            workflowId: w.execution.workflowId,
            runId: w.execution.runId,
            workflowType: w.type?.name ?? '(unknown)',
            status: simplifyStatus(w.status ?? ''),
            startTimeMs: Number.isFinite(startMs) ? startMs : 0,
            endTimeMs: Number.isFinite(endMs) ? endMs : null,
            parentWorkflowId: w.parentExecution?.workflowId ?? null,
            parentRunId: w.parentExecution?.runId ?? null,
            taskQueue: w.taskQueue ?? null,
            depth: 0,
            segments: [],
        });
    }
    return rows;
}

// "WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW" → "ContinuedAsNew".
export function simplifyStatus(status: string): string {
    const bare = status.replace(/^WORKFLOW_EXECUTION_STATUS_/, '');
    if (!bare) return 'Unknown';
    return bare
        .toLowerCase()
        .split('_')
        .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
        .join('');
}
