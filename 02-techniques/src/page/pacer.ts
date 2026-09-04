// The load control for the features that make requests of their own volume: what
// keeps a screen of rows from becoming a screen of requests, and what happens when
// the server says "slow down".
//
// The split is the point. The slot accounting — "run at most four of these at a time,
// queue the rest, start the next one when one finishes" — is p-limit's, because it is
// a generic algorithm with no Temporal in it. The pacing POLICY is ours and stays
// ours: which Retry-After forms to read, how long a wait to believe, what to do when
// the server says slow down without saying how long for, and which of two overlapping
// delays wins. No library knows any of that, and a reader porting this to their own
// backend changes only this half.
//
// INVARIANT: the pacing library supplies slots and nothing else. In particular a
// server-directed Retry-After is never expressed as a library rate limit.
// Breaking it: `intervalCap` is a fixed rate WE choose, not a wait the SERVER
// asked for, and dressing the second as the first buries the half a reader forks.
// p-queue was measured against p-limit here; see docs/design-notes.md#two-queue-libraries-measured.
//
// INVARIANT: the backoff sleep happens INSIDE the limited task, so a caller waiting
// out a Retry-After is HOLDING its slot — p-limit counts it in `activeCount`, not
// `pendingCount`. A backoff therefore parks at most `maxConcurrent` callers and the
// rest stay queued behind them: nothing fetches before the block expires, and the
// expiry cannot release the queue as a burst.
// Breaking it: check the slots, then sleep, then reserve — which is what the
// hand-written version here did, untested. During a backoff nothing is running, so
// `active` is 0, so every caller passes the check, sleeps, and wakes together: a
// hundred rows became a hundred simultaneous requests at the exact moment the server
// had asked for fewer. The cap held in the only case where it was never needed and
// failed in the only case where it was.
//
// The clock and sleep are injected because every invariant above is about TIME, and a
// test that cannot control time can only assert the shape of the code.
// tests/unit/pacer.spec.ts drives all of them with a fake clock and no timers.

import pLimit from 'p-limit';

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
    // Introspection. Nothing in the UI reads these today — the tests do, because
    // the invariants below are about counts at a moment in time and there is no
    // other way to observe one. `active` counts slots HELD, which during a backoff
    // includes callers that are waiting rather than fetching: that is the point of
    // holding the slot, and it is the difference this whole file turns on.
    active(): number;
    waiting(): number;
    blockedForMs(): number;
}

export function makePacer(clock: PacerClock, limits: PacerLimits): Pacer {
    const limit = pLimit(limits.maxConcurrent);
    let blockedUntil = 0;
    let backoffMs = limits.backoffStartMs;

    return {
        run<T>(work: () => Promise<T>): Promise<T> {
            return limit(async () => {
                // A loop, not an `if`: another response can EXTEND the block while
                // this caller is asleep in it, and waking into a still-blocked
                // window to fetch anyway is the bug this whole file is about.
                for (;;) {
                    const pause = blockedUntil - clock.now();
                    if (pause <= 0) break;
                    await clock.sleep(pause);
                }
                return work();
            });
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

        // p-limit's own two counters, which are exactly the two questions worth
        // asking: `activeCount` is tasks that have STARTED and not finished — a
        // caller asleep in a backoff is one of them, because it holds its slot —
        // and `pendingCount` is the ones still queued behind them.
        active: () => limit.activeCount,
        waiting: () => limit.pendingCount,
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
