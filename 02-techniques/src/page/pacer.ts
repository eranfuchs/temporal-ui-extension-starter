// The load control for the only feature in this repository that makes requests of
// its own volume — and the reason it is a module of its own rather than four
// variables at the top of rowInfoServe.ts.
//
// WHY IT WAS EXTRACTED: the pacer was inline, it was the one piece of this
// extension a reader is most likely to copy, and it was WRONG in a way no test
// could have caught, because it had no tests. It read:
//
//     while (active >= MAX_CONCURRENT) await waitForASlot();
//     const pause = blockedUntil - Date.now();
//     if (pause > 0) await sleep(pause);       // ← the slot is NOT held yet
//     active++;
//
// Check, then wait, then reserve. During a backoff nothing is running, so `active`
// is 0, so EVERY caller passes the check, sleeps, and wakes together: a hundred
// rows became a hundred simultaneous requests at the exact moment the server had
// asked for fewer. The concurrency cap held in the only case where it was never
// needed and failed in the only case where it was.
//
// Two rules fix it, and both are properties of this file rather than of its caller:
//
//   1. A SLOT IS RESERVED BEFORE ANY WAITING, and held across it. A backoff
//      therefore parks at most `maxConcurrent` callers; the rest queue behind them
//      and drain a slot at a time.
//   2. THE SLOT IS HANDED OVER, never released into a pool. release() wakes one
//      waiter WITHOUT decrementing, so there is no window between "a slot is free"
//      and "I have it" for a second caller to see. A check-then-act race cannot be
//      written here, because there is no check to lose.
//
// The clock and sleep are injected for one reason: every invariant above is about
// TIME, and a test that cannot control time can only assert the shape of the code.
// tests/unit/pacer.spec.ts drives all four with a fake clock and no timers.

export interface PacerClock {
    now(): number;
    sleep(ms: number): Promise<void>;
}

export interface PacerLimits {
    maxConcurrent: number;
    // Where the doubling starts when the server said "slow down" without saying
    // how long for.
    backoffStartMs: number;
    // The ceiling on our OWN doubling. It matters more than the floor: unbounded
    // doubling eventually parks the feature for an hour and reads as broken.
    backoffCeilingMs: number;
    // The ceiling on a wait the SERVER asked for. Retry-After is attacker- or
    // bug-supplied from this code's point of view — a stray `Retry-After: 86400`
    // would disable the column for a day, silently. Honour the header, cap the
    // damage, and say so.
    advisedCeilingMs: number;
}

export interface Pacer {
    // Runs `work` when there is a slot and no active backoff. Nothing else in this
    // extension may call the Temporal API outside of this.
    run<T>(work: () => Promise<T>): Promise<T>;
    // The server said slow down. Returns the wait it settled on, for the log line.
    noteRateLimit(retryAfterHeader: string | null): number;
    noteSuccess(): void;
    // Introspection, for tests and for the popup's cost report. `active` counts
    // slots held, which during a backoff includes callers that are waiting rather
    // than fetching — that is the point of holding the slot.
    active(): number;
    waiting(): number;
    blockedForMs(): number;
}

export function makePacer(clock: PacerClock, limits: PacerLimits): Pacer {
    let active = 0;
    const waiting: (() => void)[] = [];
    let blockedUntil = 0;
    let backoffMs = limits.backoffStartMs;

    function acquire(): Promise<void> {
        if (active < limits.maxConcurrent) {
            active++;
            return Promise.resolve();
        }
        // Resolving this promise MEANS "you own a slot" — see release().
        return new Promise<void>((resolve) => waiting.push(resolve));
    }

    function release(): void {
        const next = waiting.shift();
        // Handed over, not returned: `active` deliberately does not change here.
        if (next) next();
        else active--;
    }

    return {
        async run<T>(work: () => Promise<T>): Promise<T> {
            await acquire();
            try {
                // A loop, not an `if`: another response can EXTEND the block while
                // this caller is asleep in it, and waking into a still-blocked
                // window to fetch anyway is the bug this whole file is about.
                for (;;) {
                    const pause = blockedUntil - clock.now();
                    if (pause <= 0) break;
                    await clock.sleep(pause);
                }
                return await work();
            } finally {
                release();
            }
        },

        noteRateLimit(retryAfterHeader: string | null): number {
            const advised = advisedWaitMs(retryAfterHeader, clock.now(), limits.advisedCeilingMs);
            const wait = advised ?? backoffMs;
            // MAX, NOT ASSIGNMENT. Two rate-limited responses overlap all the time
            // — four requests are in the air by design — and a later `Retry-After:
            // 4` must not be able to shorten an earlier `Retry-After: 60`. The
            // longest overlapping delay wins.
            blockedUntil = Math.max(blockedUntil, clock.now() + wait);
            backoffMs = Math.min(backoffMs * 2, limits.backoffCeilingMs);
            return wait;
        },

        noteSuccess(): void {
            // ONLY WHEN NOT BLOCKED. Four requests are in flight at a time, so a
            // success that started before the block routinely lands during it —
            // and resetting the doubling then would answer an escalating rate
            // limiter with the same small delay every time.
            if (clock.now() >= blockedUntil) backoffMs = limits.backoffStartMs;
        },

        active: () => active,
        waiting: () => waiting.length,
        blockedForMs: () => Math.max(0, blockedUntil - clock.now()),
    };
}

// Retry-After, in the two forms RFC 9110 §10.2.3 allows: delay-seconds, or an
// HTTP-date. Returns null for "the server did not usefully say", which is the
// signal to fall back on our own doubling.
//
// Both forms are read because both are served in practice — a gateway in front of
// Temporal is as likely to emit a date as the API is to emit seconds — and getting
// the date form wrong is silent: Number('Wed, 21 Oct 2026 07:28:00 GMT') is NaN,
// which would look exactly like a missing header.
export function advisedWaitMs(header: string | null, nowMs: number, ceilingMs: number): number | null {
    if (header === null) return null;
    const text = header.trim();
    if (!text) return null;

    const seconds = Number(text);
    if (Number.isFinite(seconds)) {
        // A negative or zero delay is a "retry now", which is not a wait.
        if (seconds <= 0) return null;
        return Math.min(seconds * 1000, ceilingMs);
    }

    const atMs = Date.parse(text);
    if (!Number.isFinite(atMs)) return null;
    const wait = atMs - nowMs;
    return wait > 0 ? Math.min(wait, ceilingMs) : null;
}
