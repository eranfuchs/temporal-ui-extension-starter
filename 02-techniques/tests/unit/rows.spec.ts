import { describe, expect, it } from 'vitest';

import { normalizeExecutions, runKey, simplifyStatus } from '../../src/rows';
import { apiWorkflow, fakeRunId } from '../helpers';
import type { TemporalApiWorkflow } from '../../src/types';

describe('runKey', () => {
    it('cannot be confused by punctuation in a workflow id', () => {
        // Both of these join to the same string with any single separator:
        //   'a:b' + ':' + 'c'   vs   'a' + ':' + 'b:c'
        // The length prefix is what keeps them apart.
        expect(runKey('a:b', 'c')).not.toBe(runKey('a', 'b:c'));
        expect(runKey('order|1/x', 'run')).toBe('9:order|1/x:run');
    });
});

describe('normalizeExecutions', () => {
    it('skips a row with no execution id rather than inventing one', () => {
        const broken = [
            { execution: { workflowId: '', runId: fakeRunId(1) } },
            { execution: { workflowId: 'ok', runId: '' } },
            {},
        ] as unknown as TemporalApiWorkflow[];
        expect(normalizeExecutions(broken)).toEqual([]);
    });

    it('turns an unparseable time into a usable number instead of NaN', () => {
        // NaN would propagate into every sort comparison and quietly randomise
        // the order of the whole table.
        const rows = normalizeExecutions([
            { execution: { workflowId: 'x', runId: fakeRunId(2) }, startTime: 'not a date' },
        ] as unknown as TemporalApiWorkflow[]);
        expect(rows[0]!.startTimeMs).toBe(0);
        expect(rows[0]!.endTimeMs).toBeNull();
    });

    it('carries the parent execution through, and null when there is none', () => {
        const parentRun = fakeRunId(3);
        const [child, root] = normalizeExecutions([
            apiWorkflow({ workflowId: 'kid', parent: { workflowId: 'mum', runId: parentRun } }),
            apiWorkflow({ workflowId: 'root' }),
        ]);
        expect(child!.parentWorkflowId).toBe('mum');
        expect(child!.parentRunId).toBe(parentRun);
        expect(root!.parentWorkflowId).toBeNull();
        expect(root!.parentRunId).toBeNull();
    });
});

describe('simplifyStatus', () => {
    it('shortens the enum the API returns', () => {
        expect(simplifyStatus('WORKFLOW_EXECUTION_STATUS_RUNNING')).toBe('Running');
        expect(simplifyStatus('WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW')).toBe('ContinuedAsNew');
        expect(simplifyStatus('WORKFLOW_EXECUTION_STATUS_TIMED_OUT')).toBe('TimedOut');
    });

    it('passes through a status that is already short', () => {
        // Some responses carry the short form. Both shapes have to land on the
        // same value, or the "is this family running?" test starts missing.
        expect(simplifyStatus('Running')).toBe('Running');
    });

    it('says Unknown rather than empty', () => {
        expect(simplifyStatus('')).toBe('Unknown');
    });
});
