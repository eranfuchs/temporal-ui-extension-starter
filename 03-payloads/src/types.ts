// The two shapes that matter: what Temporal's API returns, and the row we draw.

// A single entry of `executions[]` in the list-workflows response. Only the
// fields this extension actually reads are declared — the real payload has many
// more, and declaring them all would be a maintenance burden for no benefit.
export interface TemporalApiWorkflow {
    execution: { workflowId: string; runId: string };
    type?: { name?: string } | null;
    // "WORKFLOW_EXECUTION_STATUS_RUNNING", "…_COMPLETED", …
    status?: string | null;
    startTime?: string | null;
    closeTime?: string | null;
    // Present only on child workflows. This one field is the entire basis of
    // the family tree.
    parentExecution?: { workflowId?: string; runId?: string } | null;
    taskQueue?: string | null;
}

// One column of the tree drawing, left to right.
//   cont   │   an ancestor below us still has more children
//   pad        an ancestor was the last child — blank column
//   branch ├─  we are a child with siblings after us
//   last   └─  we are the last child
export type SegmentKind = 'cont' | 'pad' | 'branch' | 'last';

export interface WorkflowRow {
    workflowId: string;
    runId: string;
    workflowType: string;
    // Simplified status: "Running", "Completed", "TimedOut", …
    status: string;
    startTimeMs: number;
    endTimeMs: number | null;
    parentWorkflowId: string | null;
    parentRunId: string | null;
    taskQueue: string | null;
    // Filled in by buildTree(). Depth 0 = a root of a family on this page.
    depth: number;
    segments: SegmentKind[];
}

// What the MAIN-world script posts to the ISOLATED-world script. The `source`
// field is the only thing that distinguishes our messages from every other
// postMessage on the page, so it is checked on receipt.
export const MESSAGE_SOURCE = 'temporal-ui-starter';

export interface WorkflowsMessage {
    source: typeof MESSAGE_SOURCE;
    type: 'workflows';
    url: string;
    // Which request this is the answer to, counted from 1 in the order the
    // requests were ISSUED — not the order they came back in. Two list requests
    // can be in flight at once (change a filter twice quickly), they can answer
    // in either order, and without this the older answer wins whenever it is
    // slower. See judgeListResponse() in rows.ts.
    generation: number;
    executions: TemporalApiWorkflow[];
}
