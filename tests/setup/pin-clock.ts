import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Pin `Date` to a fixed instant, 10 s into a minute, for every test.
 *
 * Several limiters (ingress, mutations, reads, test-send, audit probes) use fixed
 * one-minute windows keyed on `Date.now()`. A test that drives one with a loop could cross
 * a minute boundary half-way, reset the counter and fail one run in a few hundred — a flake
 * that is unrelated to the code under test. Freezing the clock inside the window removes
 * the whole class. Only `Date` is faked: timers, `performance.now` and promises are real,
 * so nothing waits longer. A test that needs time to move calls `vi.setSystemTime`/
 * `vi.advanceTimersByTime` itself, or `vi.useRealTimers()` and restores in `finally`.
 */
function midMinute(): number {
  return Math.floor(Date.now() / 60_000) * 60_000 + 10_000;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: midMinute() });
});

afterEach(() => {
  vi.useRealTimers();
});
