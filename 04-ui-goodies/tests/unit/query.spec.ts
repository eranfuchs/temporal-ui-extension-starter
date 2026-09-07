// src/list/query.ts: no DOM here, just the List Filter grammar and the two things
// that are genuinely subtle about it — an escaping rule Temporal's own docs never
// specify (so this declines rather than guesses one), and additive vs. replacing
// query combination.

import { describe, expect, it } from 'vitest';

import {
    buildComparisonClause,
    buildInClause,
    combineQuery,
    combineQueryOr,
    FIELD_BY_COLUMN_LABEL,
    quoteStringLiteral,
} from '../../src/list/query';

describe('quoteStringLiteral', () => {
    it('double-quotes a plain value', () => {
        expect(quoteStringLiteral('running')).toBe('"running"');
    });

    it('single-quotes a value that contains a double quote', () => {
        expect(quoteStringLiteral('say "hi"')).toBe('\'say "hi"\'');
    });

    it('double-quotes a value that contains a single quote, unaffected', () => {
        expect(quoteStringLiteral("it's fine")).toBe('"it\'s fine"');
    });

    it('declines rather than guess an escape when a value has both quote characters', () => {
        expect(quoteStringLiteral(`both ' and " here`)).toBeNull();
    });
});

describe('buildComparisonClause', () => {
    it('builds a bare-field equals clause', () => {
        expect(buildComparisonClause('WorkflowType', '=', 'OrderFlow')).toBe('WorkflowType = "OrderFlow"');
    });

    it('builds a not-equals clause', () => {
        expect(buildComparisonClause('ExecutionStatus', '!=', 'Running')).toBe('ExecutionStatus != "Running"');
    });

    it('wraps a non-bare field name in backticks', () => {
        expect(buildComparisonClause('Custom Field', '=', 'x')).toBe('`Custom Field` = "x"');
    });

    it('declines when the value is unquotable, rather than emit a guessed escape', () => {
        expect(buildComparisonClause('WorkflowId', '!=', `both ' and " here`)).toBeNull();
    });
});

describe('FIELD_BY_COLUMN_LABEL', () => {
    it('maps every column label this extension supports to its List Filter field', () => {
        expect(FIELD_BY_COLUMN_LABEL).toEqual({
            'Workflow ID': 'WorkflowId',
            'Run ID': 'RunId',
            Type: 'WorkflowType',
            Status: 'ExecutionStatus',
            'Task Queue': 'TaskQueue',
        });
    });

    it('has no entry for a column this extension added itself', () => {
        expect(FIELD_BY_COLUMN_LABEL['Last event']).toBeUndefined();
    });
});

describe('combineQuery', () => {
    it('replaces the existing query on a plain click, even when one was already there', () => {
        expect(combineQuery('WorkflowType = "Old"', 'ExecutionStatus = "Running"', false)).toBe(
            'ExecutionStatus = "Running"',
        );
    });

    it('is just the new clause when additive but nothing was there to combine with', () => {
        expect(combineQuery('', 'ExecutionStatus = "Running"', true)).toBe('ExecutionStatus = "Running"');
    });

    it('treats a whitespace-only existing query the same as empty', () => {
        expect(combineQuery('   ', 'ExecutionStatus = "Running"', true)).toBe('ExecutionStatus = "Running"');
    });

    it('ANDs the new clause onto the existing one, both parenthesised, when additive', () => {
        expect(combineQuery('WorkflowType = "Old"', 'ExecutionStatus != "Running"', true)).toBe(
            '(WorkflowType = "Old") AND (ExecutionStatus != "Running")',
        );
    });
});

describe('combineQueryOr', () => {
    it('is just the clause when nothing was there to combine with', () => {
        expect(combineQueryOr('', 'RootWorkflowId IN ("a")')).toBe('RootWorkflowId IN ("a")');
    });

    it('treats a whitespace-only existing query the same as empty', () => {
        expect(combineQueryOr('   ', 'RootWorkflowId IN ("a")')).toBe('RootWorkflowId IN ("a")');
    });

    it('ORs the new clause onto the existing one, both parenthesised', () => {
        expect(combineQueryOr('ExecutionStatus = "Failed"', 'RootWorkflowId IN ("a", "b")')).toBe(
            '(ExecutionStatus = "Failed") OR (RootWorkflowId IN ("a", "b"))',
        );
    });
});

describe('buildInClause', () => {
    it('builds an IN clause from several bare-quotable values', () => {
        expect(buildInClause('RootWorkflowId', ['a', 'b', 'c'])).toBe('RootWorkflowId IN ("a", "b", "c")');
    });

    it('wraps a non-bare field name in backticks, same as buildComparisonClause', () => {
        expect(buildInClause('Custom Field', ['x'])).toBe('`Custom Field` IN ("x")');
    });

    it('declines on an empty value list rather than emit an invalid IN ()', () => {
        expect(buildInClause('RootWorkflowId', [])).toBeNull();
    });

    it('declines if ANY single value is unquotable, not just drop that one', () => {
        expect(buildInClause('RootWorkflowId', ['fine', `both ' and " here`])).toBeNull();
    });
});
