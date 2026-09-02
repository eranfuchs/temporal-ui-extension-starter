// The load-control invariants, with time under the test's control.
//
// These exist because the pacer was inline in rowInfoServe.ts with NO tests, and
// the bug it shipped with — a slot reserved AFTER the backoff sleep instead of
// before — is invisible to any test that cannot hold several callers inside one
// backoff window at once. A real clock cannot do that reliably; a fake one does it
// deterministically.
//
// The fake clock never advances on its own. `sleep()` records the sleeper and
// resolves only when the test moves time forward, so "did this caller start before
// Retry-After elapsed?" is a question with an exact answer rather than a flaky one.

import { beforeEach, describe, expect, it } from 'vitest';
import { advisedWaitMs, makePacer, type Pacer, type PacerClock } from '../../src/page/pacer';

interface FakeClock extends PacerClock {
    advance(ms: number): Promise<void>;
    sleepers(): number;
}

function fakeClock(startMs = 1_000_000): FakeClock {
    let nowMs = startMs;
    let waking: { atMs: number; wake: () => void }[] = [];
    return {
        now: () => nowMs,
        sleep(ms: number) {
            return new Promise<void>((resolve) => {
                waking.push({ atMs: nowMs + ms, wake: resolve });
            });
        },
        async advance(ms: number) {
            nowMs += ms;
            const due = waking.filter((entry) => entry.atMs <= nowMs);
            waking = waking.filter((entry) => entry.atMs > nowMs);
            for (const entry of due) entry.wake();
            // Two turns: one for each sleeper's own continuation, one for whatever
            // that continuation awaited (the pacer re-checks the block, then calls
            // work(), which is itself async).
            await Promise.resolve();
            await Promise.resolve();
        },
        sleepers: () => waking.length,
    };
}

const LIMITS = {
    maxConcurrent: 4,
    backoffStartMs: 2_000,
    backoffCeilingMs: 60_000,
    advisedCeilingMs: 300_000,
};

// A unit of work that never finishes on its own, so the test decides when a slot
// is given back. `started` is the count of work() invocations — the number that
// must never exceed maxConcurrent.
function tracker() {
    const finish: (() => void)[] = [];
    let started = 0;
    let inFlight = 0;
    let peak = 0;
    return {
        work(): Promise<void> {
            started++;
            inFlight++;
            peak = Math.max(peak, inFlight);
            return new Promise<void>((resolve) => {
                finish.push(() => {
                    inFlight--;
                    resolve();
                });
            });
        },
        started: () => started,
        // The most that were ever in flight at one moment.
        peakInFlight: () => peak,
        async completeAll(): Promise<void> {
            while (finish.length > 0) finish.shift()!();
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

describe('pacer concurrency', () => {
    let clock: FakeClock;
    let pacer: Pacer;

    beforeEach(() => {
        clock = fakeClock();
        pacer = makePacer(clock, LIMITS);
    });

    it('runs at most maxConcurrent units of work at once', async () => {
        const jobs = tracker();
        for (let i = 0; i < 20; i++) void pacer.run(() => jobs.work());
        await Promise.resolve();
        await Promise.resolve();

        expect(jobs.started()).toBe(LIMITS.maxConcurrent);
        expect(pacer.active()).toBe(LIMITS.maxConcurrent);
        expect(pacer.waiting()).toBe(20 - LIMITS.maxConcurrent);
    });

    it('drains the queue four at a time as slots come back', async () => {
        const jobs = tracker();
        const all: Promise<void>[] = [];
        for (let i = 0; i < 10; i++) all.push(pacer.run(() => jobs.work()));
        await Promise.resolve();
        await Promise.resolve();
        expect(jobs.started()).toBe(4);

        await jobs.completeAll();
        expect(jobs.started()).toBe(8);

        await jobs.completeAll();
        expect(jobs.started()).toBe(10);

        await jobs.completeAll();
        await Promise.all(all);
        // Never more than four at any single moment, across the whole drain.
        expect(jobs.peakInFlight()).toBe(4);
        expect(pacer.active()).toBe(0);
        expect(pacer.waiting()).toBe(0);
    });

    // THE REGRESSION TEST FOR THE ORIGINAL BUG. The old pacer checked the slot
    // count, then slept out the backoff, then took a slot — so during a backoff
    // `active` was 0, every caller passed the check, and all of them woke and
    // fetched together. Twenty rows became twenty simultaneous requests at the
    // exact moment the server had asked for fewer.
    it('still admits only four when a backoff releases a crowd', async () => {
        const jobs = tracker();
        pacer.noteRateLimit('30');
        for (let i = 0; i < 20; i++) void pacer.run(() => jobs.work());
        await Promise.resolve();
        await Promise.resolve();

        // Nothing has started, and only four callers are parked in the sleep: the
        // other sixteen never got a slot to sleep in.
        expect(jobs.started()).toBe(0);
        expect(clock.sleepers()).toBe(LIMITS.maxConcurrent);

        await clock.advance(30_000);
        expect(jobs.started()).toBe(LIMITS.maxConcurrent);
        expect(jobs.peakInFlight()).toBe(LIMITS.maxConcurrent);
    });
});

describe('pacer backoff', () => {
    let clock: FakeClock;
    let pacer: Pacer;

    beforeEach(() => {
        clock = fakeClock();
        pacer = makePacer(clock, LIMITS);
    });

    it('starts nothing before the advised Retry-After has elapsed', async () => {
        const jobs = tracker();
        pacer.noteRateLimit('10');
        void pacer.run(() => jobs.work());
        await Promise.resolve();

        await clock.advance(9_999);
        expect(jobs.started()).toBe(0);

        await clock.advance(1);
        expect(jobs.started()).toBe(1);
    });

    it('lets the longest overlapping delay win', async () => {
        const jobs = tracker();
        // Four requests are in the air by design, so two rate-limited responses
        // overlap routinely — and the second must not shorten the first.
        pacer.noteRateLimit('60');
        pacer.noteRateLimit('4');
        expect(pacer.blockedForMs()).toBe(60_000);

        void pacer.run(() => jobs.work());
        await Promise.resolve();
        await clock.advance(4_000);
        expect(jobs.started()).toBe(0);

        await clock.advance(56_000);
        expect(jobs.started()).toBe(1);
    });

    it('re-checks the block on waking, so an extension is honoured', async () => {
        const jobs = tracker();
        pacer.noteRateLimit('10');
        void pacer.run(() => jobs.work());
        await Promise.resolve();

        // A response that was already in flight comes back 429 while this caller is
        // asleep, pushing the window out. Waking into a still-blocked window and
        // fetching anyway is exactly what the `for(;;)` loop prevents.
        await clock.advance(5_000);
        pacer.noteRateLimit('20');
        await clock.advance(5_000);
        expect(jobs.started()).toBe(0);

        await clock.advance(20_000);
        expect(jobs.started()).toBe(1);
    });

    it('doubles its own wait when the server gives no Retry-After, up to the ceiling', () => {
        pacer.noteRateLimit(null);
        expect(pacer.blockedForMs()).toBe(2_000);
        pacer.noteRateLimit(null);
        expect(pacer.blockedForMs()).toBe(4_000);
        pacer.noteRateLimit(null);
        expect(pacer.blockedForMs()).toBe(8_000);
        for (let i = 0; i < 10; i++) pacer.noteRateLimit(null);
        expect(pacer.blockedForMs()).toBe(LIMITS.backoffCeilingMs);
    });

    it('does not reset the doubling on a success that lands inside the block', async () => {
        pacer.noteRateLimit(null); // 2s window, next own wait 4s
        // An in-flight request that started before the block succeeds during it.
        pacer.noteSuccess();

        await clock.advance(2_000);
        pacer.noteRateLimit(null);
        // 4s, not another 2s: the escalation survived the concurrent success.
        expect(pacer.blockedForMs()).toBe(4_000);
    });

    it('does reset the doubling once the block has expired', async () => {
        pacer.noteRateLimit(null);
        await clock.advance(2_001);
        pacer.noteSuccess();

        pacer.noteRateLimit(null);
        expect(pacer.blockedForMs()).toBe(2_000);
    });
});

describe('advisedWaitMs', () => {
    const NOW = 1_000_000;
    const CEILING = 300_000;

    it('reads delay-seconds', () => {
        expect(advisedWaitMs('30', NOW, CEILING)).toBe(30_000);
        expect(advisedWaitMs('  7 ', NOW, CEILING)).toBe(7_000);
    });

    it('reads an HTTP-date, which Number() would silently turn into NaN', () => {
        const at = new Date(NOW + 45_000).toUTCString();
        // toUTCString drops sub-second precision, so allow the truncation.
        expect(advisedWaitMs(at, NOW, CEILING)).toBeGreaterThan(44_000);
        expect(advisedWaitMs(at, NOW, CEILING)).toBeLessThanOrEqual(45_000);
    });

    it('caps a server-supplied wait, so one stray header cannot park the feature for a day', () => {
        expect(advisedWaitMs('86400', NOW, CEILING)).toBe(CEILING);
    });

    it('returns null for anything that is not a usable wait', () => {
        expect(advisedWaitMs(null, NOW, CEILING)).toBeNull();
        expect(advisedWaitMs('', NOW, CEILING)).toBeNull();
        expect(advisedWaitMs('   ', NOW, CEILING)).toBeNull();
        expect(advisedWaitMs('soon', NOW, CEILING)).toBeNull();
        expect(advisedWaitMs('0', NOW, CEILING)).toBeNull();
        expect(advisedWaitMs('-5', NOW, CEILING)).toBeNull();
        // A date already in the past is not a wait either.
        expect(advisedWaitMs(new Date(NOW - 60_000).toUTCString(), NOW, CEILING)).toBeNull();
    });
});
