// Pure construction of a Temporal List Filter clause, and how it combines with
// whatever query is already in the URL. No DOM here — src/list/filters.ts decides
// where a button appears and what a click does to the page; this file only ever
// turns (field, value) into a string, or declines.
//
// EVERY GRAMMAR FACT BELOW IS FROM https://docs.temporal.io/list-filter, checked
// there rather than assumed — CLAUDE.md's rule that a claim about Temporal's own
// behaviour needs a primary source, not precedent. It documents:
//   - field names: bare if every character is in [a-zA-Z0-9], otherwise wrapped in
//     backticks ("Wrap attributes with backticks if it contains characters not in
//     [a-zA-Z0-9]").
//   - string literals: single OR double quotes, both valid ("String literals with
//     single or double quotes"). Its own worked examples — including the one for
//     != itself, `ExecutionStatus != "Running"` — use double quotes, so that is the
//     default here.
//   - comparisons: =, !=, >, >=, <, <=; there is no <> and no bare NOT.
//
// WHAT IT DOES NOT DOCUMENT, ANYWHERE: how to escape a quote character embedded
// inside a literal. Two conventions exist in the wild — backslash-escaping the
// quote, and doubling it — and neither is confirmed by the docs. Rather than pick
// one, this picks whichever of ' or " the value does not contain, and if the value
// contains BOTH, DECLINES — see quoteStringLiteral(). Every caller has to be able
// to take "no" for an answer, for the same reason findByKey() in columns.ts can: a
// wrong guess here reads as a real filter that silently searches for the wrong
// thing, not as an error.

const BARE_FIELD = /^[A-Za-z0-9]+$/;

// The only field names this file is ever actually asked to quote come from a fixed
// mapping this extension owns (FIELD_BY_COLUMN_LABEL below), and every one of them
// is already bare. This exists to be a correct general rule, not because the
// backtick branch expects to run.
export function quoteField(field: string): string {
    return BARE_FIELD.test(field) ? field : `\`${field.replace(/`/g, '')}\``;
}

// Returns null, never a guessed escape, when `value` contains both quote
// characters — see the file header.
export function quoteStringLiteral(value: string): string | null {
    if (!value.includes('"')) return `"${value}"`;
    if (!value.includes("'")) return `'${value}'`;
    return null;
}

export type ComparisonOperator = '=' | '!=';

// The one clause this extension ever builds. Declines (null) rather than emit an
// unconfirmed escape — see quoteStringLiteral().
export function buildComparisonClause(field: string, operator: ComparisonOperator, value: string): string | null {
    const literal = quoteStringLiteral(value);
    if (literal === null) return null;
    return `${quoteField(field)} ${operator} ${literal}`;
}

// Every column this extension can build a clause for, keyed by the exact label
// readColumns() (columns.ts) reports — Temporal's own display name, the same name
// "Configure Table" shows. A column absent from this map gets no ≠ button and no
// Ctrl/Cmd augmentation at all: see its callers in filters.ts. Deliberately short —
// a column this extension cannot map with confidence (a deployment/build-id column,
// say) is left unsupported rather than guessed at.
export const FIELD_BY_COLUMN_LABEL: Readonly<Record<string, string>> = {
    'Workflow ID': 'WorkflowId',
    'Run ID': 'RunId',
    Type: 'WorkflowType',
    Status: 'ExecutionStatus',
    'Task Queue': 'TaskQueue',
};

// Plain click REPLACES whatever query is already in the URL; Ctrl/Cmd-click ADDS —
// wraps the existing query, if there is one, and ANDs the new clause onto it. Never
// drops what was already typed, and never ANDs onto nothing.
export function combineQuery(existingQuery: string, clause: string, additive: boolean): string {
    const trimmed = existingQuery.trim();
    if (!additive || trimmed === '') return clause;
    return `(${trimmed}) AND (${clause})`;
}

// The other combinator this extension needs, for "Expand to families"
// (family/expand.ts): widening a filter to ALSO include rows it did not itself
// match is an OR, never an AND — a failed-status filter ANDed with a set of root
// ids would just narrow to failed roots, not "everything in these families".
// Same empty-existing rule as combineQuery(): nothing to OR against yet means the
// clause stands alone rather than becoming `() OR (...)`, which is not valid
// syntax and would not mean "everything" even if it were.
export function combineQueryOr(existingQuery: string, clause: string): string {
    const trimmed = existingQuery.trim();
    if (trimmed === '') return clause;
    return `(${trimmed}) OR (${clause})`;
}

// One IN-list clause from several already-known-good values (workflow ids off the
// table, never user-typed) — declines the same way buildComparisonClause() does if
// any single value cannot be safely quoted, rather than silently dropping just that
// one and changing what the clause means. Empty input declines too: an IN() with no
// values is not "match nothing" in this grammar, it is not valid at all.
export function buildInClause(field: string, values: readonly string[]): string | null {
    if (values.length === 0) return null;
    const literals: string[] = [];
    for (const value of values) {
        const literal = quoteStringLiteral(value);
        if (literal === null) return null;
        literals.push(literal);
    }
    return `${quoteField(field)} IN (${literals.join(', ')})`;
}
