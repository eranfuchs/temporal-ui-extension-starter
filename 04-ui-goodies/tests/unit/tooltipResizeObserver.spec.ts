// @vitest-environment jsdom
//
// The ResizeObserver ensurePanel() builds in src/payloads/tooltip.ts is invisible
// to every OTHER spec in this project: jsdom has neither ResizeObserver nor a
// layout engine to drive one, so `typeof ResizeObserver !== 'undefined'` is false
// there and the whole block never runs — see that file's own comment on it. That
// silence is exactly how two things regressed unnoticed: the observer was never
// disconnected when the panel was switched off, and its callback never kept the
// panel positioned inside the viewport during a native resize-drag. This file
// installs a fake ResizeObserver just for these tests, to pin the LIFECYCLE
// (created once per panel, disconnected on removal) and the WIRING (its callback
// re-places the panel) from outside jsdom's blind spot. The pixel-accurate
// placement claim itself still needs a real browser — see docs/design-notes.md.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PANEL_CLASS } from '../../src/decoration';
import { removePayloadTooltip } from '../../src/payloads/tooltip';
import { hoverAndAnswer, installHarness, openPanel, panel, resetHarness } from '../tooltipHarness';

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    readonly disconnect = vi.fn();
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        FakeResizeObserver.instances.push(this);
    }

    observe(): void {}
    unobserve(): void {}

    // Not part of the real interface: lets a test invoke the callback the way a
    // real browser would after a resize, without an actual layout engine behind it.
    fire(): void {
        this.callback([], this as unknown as ResizeObserver);
    }
}

beforeAll(installHarness);

beforeEach(() => {
    resetHarness();
    FakeResizeObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});

afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe('the width observer ensurePanel() builds', () => {
    it('is disconnected when the panel is switched off, not left running', () => {
        openPanel();
        expect(FakeResizeObserver.instances).toHaveLength(1);
        const observer = FakeResizeObserver.instances[0]!;

        removePayloadTooltip();

        expect(observer.disconnect).toHaveBeenCalledTimes(1);
    });

    it("erases the retained body element's decoded text before the panel is detached, not after", async () => {
        // A previous version of removePayloadTooltip() nulled state.body before
        // calling the function that reads it to erase it, which made the erasure a
        // silent no-op — the panel still came off the page on schedule, so nothing
        // about that looked wrong. Retaining the element itself, the way a page
        // script that grabbed a reference earlier would, is what catches that: the
        // module's own state.body is not what Rule 5 is protecting.
        await hoverAndAnswer({ text: 'decoded payload text' });
        const retainedBody = panel().querySelector(`.${PANEL_CLASS}-body`)!;
        expect(retainedBody.textContent).toBe('decoded payload text');

        removePayloadTooltip();

        expect(retainedBody.textContent).toBe('');
    });

    it('re-places the panel when the observer callback fires, not only on open/fill', () => {
        // Rule 3's drag half: content.css lets a reader drag the body up to its own
        // much larger ceiling, and only this callback keeps the panel (and its own
        // resize handle) from being carried off-screen as the body grows. place()
        // is not exported, so — the same technique the existing "placed again once
        // real content exists" spec above uses — a count of getBoundingClientRect()
        // calls made specifically on the panel element stands in for "place() ran".
        openPanel();
        const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
        const before = rectSpy.mock.instances.filter((instance) => instance === panel()).length;

        FakeResizeObserver.instances[0]!.fire();

        const after = rectSpy.mock.instances.filter((instance) => instance === panel()).length;
        expect(after).toBeGreaterThan(before);
    });

    it('disconnects the old observer when a stale panel is rebuilt, not only when the master switch removes it', () => {
        // removePayloadTooltip() is not the only way the panel node leaves the
        // page: ensurePanel() itself rebuilds from scratch whenever it finds
        // state.panel.isConnected false, which happens if something OTHER than
        // our own master switch — a host DOM replacement — took the node out
        // from under it. That path never calls removePayloadTooltip(), so the
        // disconnect it does has to also happen here, or the observer built for
        // the discarded panel keeps running.
        openPanel();
        expect(FakeResizeObserver.instances).toHaveLength(1);
        const staleObserver = FakeResizeObserver.instances[0]!;

        panel().remove();
        openPanel();

        expect(FakeResizeObserver.instances).toHaveLength(2);
        expect(staleObserver.disconnect).toHaveBeenCalledTimes(1);
    });

    it('does not reposition a panel the observer is still watching after it was closed', () => {
        // close() hides the panel but does not rebuild it, so the SAME observer
        // instance keeps firing for as long as the body it watches keeps existing.
        // A closed (hidden) panel has nothing worth repositioning.
        openPanel();
        // Before/after, not an absolute count: this file's vitest.config.ts does
        // not restore mocks between tests, so a spy on a shared prototype method
        // accumulates instances across every test in this file, the same reason
        // the "re-places the panel" spec above only asserts a delta.
        const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
        const before = rectSpy.mock.instances.filter((instance) => instance === panel()).length;
        panel().hidden = true;

        FakeResizeObserver.instances[0]!.fire();

        const after = rectSpy.mock.instances.filter((instance) => instance === panel()).length;
        expect(after).toBe(before);
    });
});
