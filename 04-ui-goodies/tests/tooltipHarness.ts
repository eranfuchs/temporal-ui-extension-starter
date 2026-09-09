// The jsdom harness for the payload panel: two buttons (Input, Output) sharing
// one panel, one table, and the helpers that hover them and answer them.
//
// WHY IT IS SHARED RATHER THAN COPIED. Two spec files drive this panel — one for
// the five rules at the top of src/payloads/tooltip.ts (the element and the
// gesture), one for the four invariants at the top of src/payloads/payloadClient.ts
// (which answer may be believed) — and they must drive the SAME installed panel.
// Two private harnesses would drift, and the drift would be invisible: each file
// would keep passing against its own slightly different fixture while the rules
// and the invariants they pin no longer meet in the middle.
//
// WHY IT IS NOT IN tests/helpers.ts. That file is shared with 02-techniques, which
// has no payload panel. Putting a panel fixture
// there would force 02 to carry a harness for a feature it does not have.
//
// The panel is installed ONCE, in installHarness(): it registers listeners on the
// document and the window, so installing per test would stack them. resetHarness()
// is the per-test half — fake timers, the postMessage spy, the table, and the module
// state that outlives a test.

import { safeParse } from 'valibot';
import { expect, vi } from 'vitest';

import {
    payloadRequestSchema,
    type CodecConfig,
    type PayloadKind,
    type PayloadRequest,
    type PayloadResult,
} from '../src/payloads/payloadMessages';
import { installPayloadTooltip, resetPayloadState, type TooltipRow } from '../src/payloads/tooltip';
import { PANEL_CLASS, PAYLOAD_INPUT_CLASS, PAYLOAD_OUTPUT_CLASS } from '../src/decoration';
import { MESSAGE_SOURCE } from '../src/types';
import { fakeRunId } from './helpers';

export const NAMESPACE = 'sample-namespace';
export const RUN_ID = fakeRunId(201);

export const ROW: TooltipRow = {
    workflowId: 'sample-workflow',
    runId: RUN_ID,
    workflowType: 'SampleWorkflow',
    status: 'Completed',
};

// A running workflow's Output button has no result event to fetch — which is
// also what makes it the right fixture for counting requests.
export const RUNNING_ROW: TooltipRow = { ...ROW, status: 'Running' };

// A DIFFERENT row, for the specs about moving the pointer between two buttons. Its
// ids differ from the first row's, because the whole point of those specs is which
// row was asked about.
export const SECOND_ROW: TooltipRow = { ...RUNNING_ROW, workflowId: 'second-workflow', runId: fakeRunId(202) };

export const GRACE_MS = 500; // comfortably past HOVER_DELAY_MS and CLOSE_DELAY_MS
export const PART_WAY_MS = 80; // short of HOVER_DELAY_MS, so a pending hover timer is still pending

// What the page looks like, as the installed panels see it. Every dependency is
// read through a function, so a spec can change any of these BETWEEN two hovers —
// which is the only way to test that the namespace is part of the cache key.
//
// A mutable object rather than three exported `let`s: an imported binding cannot be
// assigned from the importing module, and a setter per field is three functions that
// do nothing but assign.
export const page: { row: TooltipRow | null; namespace: string; codec: CodecConfig } = {
    row: ROW,
    namespace: NAMESPACE,
    codec: { endpoint: '' },
};

// Rows that belong to a SPECIFIC button, for the two-row specs. Everything else
// reads page.row, so one fixture row stays the default and nothing else changes.
// Both of a row's buttons (Input and Output) map to the same row here — which
// button was hovered is what tells two specs apart, not which row it resolves to.
const rowsByButton = new Map<HTMLElement, TooltipRow>();

// Every payload request either panel posted, in order. Emptied in place rather
// than reassigned, so a spec can hold a reference to it across a reset.
export const posted: PayloadRequest[] = [];

export function button(kind: PayloadKind = 'input'): HTMLElement {
    const className = kind === 'input' ? PAYLOAD_INPUT_CLASS : PAYLOAD_OUTPUT_CLASS;
    return document.querySelector<HTMLElement>(`.${className}`)!;
}

function appendButton(cell: HTMLElement, className: string, glyph: string): HTMLElement {
    const trigger = cell.appendChild(document.createElement('button'));
    trigger.className = className;
    trigger.textContent = glyph;
    return trigger;
}

// A second row in the same table, with its own Input and Output buttons bound to
// its own workflow. Returned as a pair rather than looked up, because the specs
// that use it need to aim a pointer event at exactly one of the two.
export function addSecondButton(row: TooltipRow = SECOND_ROW): { input: HTMLElement; output: HTMLElement } {
    const cell = document
        .querySelector('tbody')!
        .appendChild(document.createElement('tr'))
        .appendChild(document.createElement('td'));
    const input = appendButton(cell, PAYLOAD_INPUT_CLASS, 'In');
    const output = appendButton(cell, PAYLOAD_OUTPUT_CLASS, 'Out');
    rowsByButton.set(input, row);
    rowsByButton.set(output, row);
    return { input, output };
}

// There is exactly one panel on the page — see the top-of-file note on
// src/payloads/tooltip.ts for why an earlier per-kind version of this file no
// longer matches the code. `expectedKind`, when given, is not a selector: it
// asserts against `data-tuis-kind` (set in ensurePanel()/openNow(),
// tooltip.ts) that the panel is showing the kind the caller believes it is,
// so a spec whose assumption about which kind is currently active has gone
// stale fails loudly at the assertion, rather than silently reading whichever
// kind happens to be open.
export function panel(expectedKind?: PayloadKind): HTMLElement {
    const node = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;
    if (expectedKind !== undefined && node.dataset.tuisKind !== expectedKind) {
        throw new Error(`panel(): expected kind "${expectedKind}" but the panel is showing "${node.dataset.tuisKind}"`);
    }
    return node;
}

export function section(expectedKind?: PayloadKind): { heading: Element; body: Element } {
    const node = panel(expectedKind);
    return {
        heading: node.querySelector(`.${PANEL_CLASS}-heading`)!,
        body: node.querySelector(`.${PANEL_CLASS}-body`)!,
    };
}

// pointerover is what the code listens to, and it must bubble to reach a
// delegated listener on the document — as a real one does.
export function pointerOver(target: EventTarget): void {
    target.dispatchEvent(new Event('pointerover', { bubbles: true }));
}

export function openPanel(kind: PayloadKind = 'input'): void {
    pointerOver(button(kind));
    vi.advanceTimersByTime(GRACE_MS);
    expect(panel(kind).hidden).toBe(false);
}

// The answer, as the MAIN world would post it: every field the request named,
// echoed back. This builds a CORRECT one, and each correlation spec breaks exactly
// one field of it.
export function answerTo(request: PayloadRequest, overrides: Partial<PayloadResult> = {}): PayloadResult {
    return {
        source: MESSAGE_SOURCE,
        type: 'payload-result',
        id: request.id,
        namespace: request.namespace,
        workflowId: request.workflowId,
        runId: request.runId,
        kind: request.kind,
        label: request.kind === 'input' ? 'Input' : 'Completed',
        text: `text for ${request.kind} of ${request.workflowId}`,
        error: null,
        decodedBy: null,
        ...overrides,
    };
}

export function deliver(data: unknown, source: Window | null = window): void {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
}

// The answer travels through a CHAIN of awaits before it reaches the DOM: the
// promise ask() is waiting on, the cache write and the in-flight cleanup that
// requestPayload() hangs off it, its own frame, then the continuation in fill().
// Draining microtasks is what makes the assertion about the panel rather than about
// the message.
//
// Generously longer than the chain, and deliberately NOT the exact hop count. It was
// 4 — which was exact — and adding the client's in-flight join (invariant 2) made the
// chain one hop longer, which turned eight render assertions red for a reason that had
// nothing to do with the panel. Note that a drain which is too SHORT fails loudly (a
// section still reading "Loading…") rather than passing vacuously, because every spec
// expecting "Loading…" after a bad answer is paired with one expecting the real text
// after a good one.
const MICROTASK_DRAIN = 24;

export async function settled(): Promise<void> {
    for (let tick = 0; tick < MICROTASK_DRAIN; tick++) await Promise.resolve();
}

// One complete round trip: hover, answer whatever was asked, render.
export async function hoverAndAnswer(overrides: Partial<PayloadResult> = {}, kind: PayloadKind = 'input'): Promise<void> {
    const before = posted.length;
    openPanel(kind);
    for (const request of posted.slice(before)) deliver(answerTo(request, overrides));
    await settled();
}

// Once per spec FILE. It registers listeners on the document and the window.
export function installHarness(): void {
    installPayloadTooltip({
        // Per-button first, so a two-row spec can give each row its own identity;
        // page.row otherwise, which is what every other spec uses.
        findRow: (tr) => {
            const trigger = tr.querySelector<HTMLElement>(`.${PAYLOAD_INPUT_CLASS}, .${PAYLOAD_OUTPUT_CLASS}`);
            return (trigger && rowsByButton.get(trigger)) ?? page.row;
        },
        namespace: () => page.namespace,
        codec: () => page.codec,
    });
}

// Once per test, and it has to be all of this: the client's cache and the panel's
// generation counter are MODULE state and outlive a test, so without the reset the
// specs that count requests would pass or fail depending on which ran first.
export function resetHarness(): void {
    vi.useFakeTimers();
    page.row = ROW;
    page.namespace = NAMESPACE;
    page.codec = { endpoint: '' };
    rowsByButton.clear();
    posted.length = 0;
    resetPayloadState();
    vi.spyOn(window, 'postMessage').mockImplementation(((message: unknown) => {
        // Parsed, not cast: a message the page world would refuse is a message that
        // was never sent, and a spec should fail in that case.
        const request = safeParse(payloadRequestSchema, message);
        if (request.success) posted.push(request.output);
    }) as typeof window.postMessage);
    // A table row, because openNow resolves the row through button.closest('tr').
    // Built node by node rather than with innerHTML: there is no innerHTML anywhere
    // in this repository, and a fixture is not a good enough reason to start.
    document.body.replaceChildren();
    const table = document.body.appendChild(document.createElement('table'));
    const cell = table
        .appendChild(document.createElement('tbody'))
        .appendChild(document.createElement('tr'))
        .appendChild(document.createElement('td'));
    appendButton(cell, PAYLOAD_INPUT_CLASS, 'In');
    appendButton(cell, PAYLOAD_OUTPUT_CLASS, 'Out');
}
