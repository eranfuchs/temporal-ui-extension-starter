// Fixtures shared by the specs.
//
// Every workflow id, run id and type here is invented for the test. Nothing in
// this repository — code, tests, screenshots or docs — carries an identifier
// from a real deployment.

import type { TemporalApiWorkflow } from '../src/types';

let runIdCounter = 0;

// Deterministic, obviously-fake run ids with the right SHAPE, because the row
// parser rejects a run segment that is not UUID-shaped.
export function fakeRunId(seed?: number): string {
    const n = seed ?? ++runIdCounter;
    const hex = n.toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${hex}`;
}

export interface WorkflowSpec {
    workflowId: string;
    runId?: string;
    type?: string;
    status?: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'TERMINATED' | 'CONTINUED_AS_NEW';
    startTime?: string;
    closeTime?: string | null;
    parent?: { workflowId: string; runId?: string };
    taskQueue?: string;
}

export function apiWorkflow(spec: WorkflowSpec): TemporalApiWorkflow {
    return {
        execution: { workflowId: spec.workflowId, runId: spec.runId ?? fakeRunId() },
        type: { name: spec.type ?? 'SampleWorkflow' },
        status: `WORKFLOW_EXECUTION_STATUS_${spec.status ?? 'COMPLETED'}`,
        startTime: spec.startTime ?? '2026-01-01T00:00:00Z',
        closeTime: spec.closeTime === undefined ? '2026-01-01T00:01:00Z' : spec.closeTime,
        parentExecution: spec.parent
            ? { workflowId: spec.parent.workflowId, runId: spec.parent.runId }
            : null,
        taskQueue: spec.taskQueue ?? 'sample-task-queue',
    };
}

// A table shaped like the one the Temporal UI renders: a <tbody> of rows whose
// first cell holds a link to /namespaces/{ns}/workflows/{id}/{run}/history.
//
// Deliberately NOT a copy of the real markup. The renderer anchors on the link
// and nothing else, so a test that reproduced Temporal's exact class names would
// assert a coupling the code does not have.
export function buildWorkflowTable(
    doc: Document,
    rows: Array<{ workflowId: string; runId?: string | null; namespace?: string }>,
): HTMLTableSectionElement {
    const table = doc.createElement('table');
    const tbody = doc.createElement('tbody');
    for (const row of rows) {
        tbody.appendChild(workflowTr(doc, row));
    }
    table.appendChild(tbody);
    doc.body.appendChild(table);
    return tbody;
}

export function workflowTr(
    doc: Document,
    row: { workflowId: string; runId?: string | null; namespace?: string },
): HTMLTableRowElement {
    const tr = doc.createElement('tr');
    const idCell = doc.createElement('td');
    // ~8px of padding is what the real cell has, and what .tuis-prefix's left
    // offset compensates for.
    idCell.style.paddingLeft = '8px';
    idCell.appendChild(workflowLink(doc, row));
    const statusCell = doc.createElement('td');
    statusCell.textContent = 'Completed';
    tr.append(idCell, statusCell);
    return tr;
}

export function workflowLink(
    doc: Document,
    row: { workflowId: string; runId?: string | null; namespace?: string },
): HTMLAnchorElement {
    const anchor = doc.createElement('a');
    const namespace = row.namespace ?? 'sample-namespace';
    const tail = row.runId ? `/${encodeURIComponent(row.runId)}/history` : '/timeline';
    anchor.setAttribute(
        'href',
        `/namespaces/${namespace}/workflows/${encodeURIComponent(row.workflowId)}${tail}`,
    );
    anchor.textContent = row.workflowId;
    return anchor;
}

export function rowOrder(tbody: HTMLTableSectionElement): string[] {
    return Array.from(tbody.querySelectorAll('tr')).map(
        (tr) => tr.querySelector('a')?.textContent ?? '',
    );
}
