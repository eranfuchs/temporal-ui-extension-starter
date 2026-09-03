// The shapes that matter: what Temporal's API returns, what crosses between our
// two worlds, and the row we draw.
//
// WHY THE FIRST TWO ARE SCHEMAS AND NOT INTERFACES
//
// An interface is a promise the compiler checks at BUILD time about data that
// arrives at RUN time. For our own row type that is exactly right — we build it,
// so the compiler can hold us to it. For the other two it is not: one comes off
// the network and one comes from a postMessage on a page we do not own. Writing
// `data as WorkflowsMessage` tells the compiler to stop asking questions at the
// one point where the answers were never checked.
//
// So the boundary shapes are schemas, parsed on arrival, and their TypeScript
// types are INFERRED from them — one description instead of a declaration and a
// validator that can disagree.
//
// SHAPE IS NOT PROVENANCE. This is the sentence to keep. Parsing proves the data
// LOOKS right; it says nothing about who sent it. Any script on the page can post
// a perfectly well-formed message and these schemas will accept it — which is why
// content.ts checks `event.source` as well, and why nothing here is described as
// authentication or authorisation.
//
// THE UNKNOWN-KEY POLICY: unknown keys are STRIPPED, which is what valibot's
// object() does, and what this repository wants in both directions. Temporal may
// add fields without breaking us — it does, regularly — and a field we no longer
// read cannot come back into reach just because some producer still sends it. What
// comes out of a parse is only what is declared below, so a message carrying an
// `authorization` key does not leave one lying around for later code to find.
//
// INVARIANT: the schema library stays small enough that a reader can still
// account for everything in dist/content.js by opening it.
// Breaking it: zod was tried first and dominated every bundle it entered. Run
// `npm run measure` for today's figures; the measured four-library comparison,
// and why bundle size is a first-class criterion in a teaching repository, is at
// docs/design-notes.md#two-schema-libraries-measured.

import * as v from 'valibot';

// A single entry of `executions[]` in the list-workflows response. Only the
// fields this extension actually reads are declared — the real response has many
// more, and declaring them all would be a maintenance burden for no benefit.
//
// `execution` is the strict part: an entry with no ids is not something we can
// place in a tree or match to a table row. Everything else is nullish because
// Temporal genuinely omits it (a root workflow has no parentExecution, a running
// one has no closeTime), and it sends some of those as null and some not at all.
export const temporalApiWorkflowSchema = v.object({
    execution: v.object({
        workflowId: v.pipe(v.string(), v.minLength(1)),
        runId: v.pipe(v.string(), v.minLength(1)),
    }),
    type: v.nullish(v.object({ name: v.optional(v.string()) })),
    // "WORKFLOW_EXECUTION_STATUS_RUNNING", "…_COMPLETED", …
    status: v.nullish(v.string()),
    startTime: v.nullish(v.string()),
    closeTime: v.nullish(v.string()),
    // Present only on child workflows. This one field is the entire basis of
    // the family tree.
    parentExecution: v.nullish(
        v.object({ workflowId: v.optional(v.string()), runId: v.optional(v.string()) }),
    ),
    taskQueue: v.nullish(v.string()),
});

export type TemporalApiWorkflow = v.InferOutput<typeof temporalApiWorkflowSchema>;

// The list response as a whole, as much of it as inject.ts needs to decide
// whether it saw a workflow list at all. The entries stay `unknown` here on
// purpose: they are checked one at a time in normalizeExecutions(), because one
// malformed entry must cost one row and not the whole table.
export const workflowListEnvelopeSchema = v.object({ executions: v.array(v.unknown()) });

// One column of the tree drawing, left to right.
//   cont   │   an ancestor below us still has more children
//   pad        an ancestor was the last child — blank column
//   branch ├─  we are a child with siblings after us
//   last   └─  we are the last child
export type SegmentKind = 'cont' | 'pad' | 'branch' | 'last';

// Our own shape, built by us, so an interface is the honest description.
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

export const workflowsMessageSchema = v.object({
    source: v.literal(MESSAGE_SOURCE),
    type: v.literal('workflows'),
    url: v.string(),
    // Which request this is the answer to, counted from 1 in the order the
    // requests were ISSUED — not the order they came back in. Two list requests
    // can be in flight at once (change a filter twice quickly), they can answer
    // in either order, and without this the older answer wins whenever it is
    // slower. See judgeListResponse() in family/rows.ts.
    //
    // finite() is the part not to drop. Every comparison against NaN is false, so
    // a NaN generation is neither newer nor older than the one already applied: a
    // forged one would freeze the table for the rest of the page's life, with no
    // error anywhere. Infinity is the same bug from the other end — it pins
    // appliedGeneration at Infinity and every real answer afterwards is stale.
    generation: v.pipe(v.number(), v.finite()),
    executions: v.array(v.unknown()),
});

export type WorkflowsMessage = v.InferOutput<typeof workflowsMessageSchema>;
