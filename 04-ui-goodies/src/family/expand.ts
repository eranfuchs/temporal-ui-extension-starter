// "Expand to families" — pure logic for turning what is ALREADY on screen into a
// query that also pulls in the rest of each visible row's family: workflows that
// share its root but did not themselves match whatever is filtered right now.
// family/expandButton.ts decides where the button goes and what a click does to
// the page; this file only ever turns (existing query, known rows) into a verdict.
//
// BOUNDED TO THE LOADED PAGE, ON PURPOSE. The private extension this starter
// reimplements re-queries the API across every matching row, paginated, to
// discover roots the current page never showed — a real network scan this starter
// does not attempt (see the Stage 04 brief's own scope for Phase E). What is here
// works only from rows this tab has already learned about from the last list
// response — WorkflowRow.rootWorkflowId (family/rows.ts), which is ALWAYS
// populated by then. That degrades honestly rather than doing nothing: on an older
// server, or when a page's true root is off-page, rootWorkflowId is a page-local
// stand-in rather than the namespace-wide one — but two rows that agree on it
// still belong to the same query, which is the only thing this feature promises.
//
// THE FIELD NAME ITSELF IS UNCONFIRMED AS A QUERYABLE SEARCH ATTRIBUTE against
// docs.temporal.io's own default-search-attribute table (checked directly, see
// /tmp/temporal-ui-stage04-progress.md) — only ParentWorkflowId and RootWorkflowId's
// sibling `root_execution` PROTO FIELD are confirmed there (temporalio/api,
// message.proto field 18). ParentWorkflowId, absent from that same table, is
// LIVE-VERIFIED queryable in this project's own history (the root-count feature's
// Count API calls). That is the balance of evidence this extension proceeds on,
// stated plainly rather than silently assumed. If a server rejects the field, the
// failure is a normal Temporal UI query-error state — this file sends a query, not
// a request of its own, and never renders an error banner of its own for one.

import { buildInClause, combineQueryOr } from '../list/query';
import type { WorkflowRow } from '../types';

export const ROOT_FIELD = 'RootWorkflowId';

// The brief's own cap. Fifty roots is already a wide family-of-families; more than
// that on one page is a filter that would be better narrowed first, not a bigger
// query this extension should build without being asked.
export const MAX_EXPAND_ROOTS = 50;

export type ExpandVerdict =
    | { kind: 'query'; query: string; rootCount: number }
    | { kind: 'no-roots' }
    | { kind: 'too-many'; rootCount: number }
    | { kind: 'unquotable' };

// First-seen order, deduplicated. Order only matters for making this testable
// without sorting the output first — the query itself is an IN-list, which does
// not care what order its members arrive in.
export function collectFamilyRoots(rows: readonly WorkflowRow[]): string[] {
    const seen = new Set<string>();
    for (const row of rows) seen.add(row.rootWorkflowId);
    return [...seen];
}

export function buildExpandVerdict(existingQuery: string, roots: readonly string[]): ExpandVerdict {
    if (roots.length === 0) return { kind: 'no-roots' };
    if (roots.length > MAX_EXPAND_ROOTS) return { kind: 'too-many', rootCount: roots.length };
    const clause = buildInClause(ROOT_FIELD, roots);
    // Root ids come straight off the table, never user-typed, but the same
    // "decline rather than guess" rule as every other query-builder here still
    // applies: an id containing BOTH quote characters cannot be safely quoted, and
    // saying so plainly beats sending a clause that means something other than
    // what it looks like.
    if (clause === null) return { kind: 'unquotable' };
    return { kind: 'query', query: combineQueryOr(existingQuery, clause), rootCount: roots.length };
}
