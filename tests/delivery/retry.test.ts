import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  FIXED_DELAY_JITTER_FRACTION,
  QUEUE_MAX_DELAY_SECONDS,
  additiveJitter,
  backoffDelay,
  clampRetryAfter,
  decideRetry,
  fullJitterDelay,
  maxAttempts,
  parseRetryAfter,
  type RandomSource,
  type RetryPolicy,
} from '../../src/delivery/retry';
import { ERROR_CODES, isRetryable } from '../../src/platform/errors';

const zero: RandomSource = () => 0;
const almostOne: RandomSource = () => 0.999999;
const half: RandomSource = () => 0.5;

/** Deterministic LCG so distribution tests are reproducible. */
function seeded(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const HOUR = 3600;

describe('Tier 1 full jitter (F177)', () => {
  it('backoff_is_within_cap_and_uses_full_jitter', () => {
    for (let attempt = 1; attempt <= 12; attempt++) {
      const ceiling = Math.min(900, 2 * 2 ** attempt);
      expect(fullJitterDelay(attempt, zero)).toBe(0);
      expect(fullJitterDelay(attempt, almostOne)).toBe(ceiling);
    }
  });

  it('backoff_distribution_is_uniform_over_many_samples', () => {
    const random = seeded(42);
    const ceiling = 900; // attempt 10 is capped
    const n = 20_000;
    const samples = Array.from({ length: n }, () => fullJitterDelay(10, random));
    const buckets = [0, 1, 2, 3].map(
      (b) => samples.filter((d) => Math.min(3, Math.floor((d / (ceiling + 1)) * 4)) === b).length,
    );
    buckets.forEach((count) => expect(Math.abs(count - n / 4)).toBeLessThan(n * 0.02));
  });

  it('rejects invalid attempts and broken random sources', () => {
    expect(() => fullJitterDelay(0, zero)).toThrow(RangeError);
    expect(() => fullJitterDelay(1.5, zero)).toThrow(RangeError);
    expect(() => fullJitterDelay(1, () => 1)).toThrow(RangeError);
    expect(() => fullJitterDelay(1, () => -0.1)).toThrow(RangeError);
    expect(() => fullJitterDelay(1, () => Number.NaN)).toThrow(RangeError);
  });
});

describe('two-tier schedule (F177)', () => {
  it('has 13 attempts by default', () => {
    expect(maxAttempts()).toBe(13);
  });

  it('uses full jitter for attempts 1..5 and the ladder for 6..12', () => {
    expect(backoffDelay(1, almostOne)).toBe(4);
    expect(backoffDelay(5, almostOne)).toBe(64);
    expect(backoffDelay(6, zero)).toBe(2 * HOUR);
    expect(backoffDelay(12, zero)).toBe(96 * HOUR);
    expect(backoffDelay(13, zero)).toBeNull();
    expect(backoffDelay(99, zero)).toBeNull();
  });

  it('every_retry_path_applies_jitter', () => {
    for (let attempt = 1; attempt < maxAttempts(); attempt++) {
      expect(backoffDelay(attempt, almostOne)).toBeGreaterThan(backoffDelay(attempt, zero) ?? Infinity);
    }
  });

  it('ladder jitter only extends a fixed step, by at most 10%', () => {
    expect(additiveJitter(HOUR, zero)).toBe(HOUR);
    expect(additiveJitter(HOUR, almostOne)).toBe(HOUR + HOUR * FIXED_DELAY_JITTER_FRACTION);
    expect(additiveJitter(5, almostOne)).toBe(5);
  });

  it('tier_two_schedule_spans_the_ladder_sum (spec says ~7 d; its own ladder sums to ~10.8 d)', () => {
    const total = Array.from({ length: maxAttempts() - 1 }, (_, i) => backoffDelay(i + 1, zero) ?? 0).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(260 * HOUR);
  });

  it('returns null when the ladder has a hole (defensive)', () => {
    const sparse: RetryPolicy = { ...DEFAULT_RETRY_POLICY, chronicLadderSeconds: new Array<number>(2) };
    expect(backoffDelay(6, zero, sparse)).toBeNull();
  });
});

describe('Retry-After (F178)', () => {
  const now = Date.UTC(2026, 9, 13, 12, 0, 0);

  it('retry_after_parses_both_rfc9110_forms', () => {
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Tue, 13 Oct 2026 12:01:30 GMT', now)).toBe(90);
    expect(parseRetryAfter('Tuesday, 13-Oct-26 12:00:10 GMT', now)).toBe(10);
    expect(parseRetryAfter('Tue Oct 13 12:00:05 2026', now)).toBe(5);
  });

  it('treats a past date as zero and malformed input as absent', () => {
    expect(parseRetryAfter('Tue, 13 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter('-5', now)).toBeNull();
    expect(parseRetryAfter('1.5', now)).toBeNull();
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('Tue, 13 Oct 2026 12:01:30 PST', now)).toBeNull();
    expect(parseRetryAfter('Tue, 99 Oct 2026 12:01:30 GMT', now)).toBeNull();
  });

  it('retry_after_is_clamped_to_a_sane_window', () => {
    expect(clampRetryAfter(0)).toBe(1);
    expect(clampRetryAfter(0.2)).toBe(1);
    expect(clampRetryAfter(30)).toBe(30);
    expect(clampRetryAfter(86_400)).toBe(DEFAULT_RETRY_POLICY.retryAfterCapSeconds);
    expect(clampRetryAfter(null)).toBeNull();
    expect(clampRetryAfter(undefined)).toBeNull();
    expect(clampRetryAfter(Number.NaN)).toBeNull();
  });
});

describe('decideRetry', () => {
  it('acks delivered and accepted outcomes', () => {
    expect(decideRetry({ attempt: 1, outcome: { kind: 'delivered' }, random: zero })).toEqual({
      action: 'ack',
    });
    expect(decideRetry({ attempt: 13, outcome: { kind: 'accepted' }, random: zero })).toEqual({
      action: 'ack',
    });
  });

  it.each(ERROR_CODES.filter((c) => !isRetryable(c)))(
    'permanent %s dead-letters on the first attempt',
    (code) => {
      expect(decideRetry({ attempt: 1, outcome: { kind: 'failed', code }, random: zero })).toEqual({
        action: 'dead_letter',
        reason: 'permanent_error',
        code,
      });
    },
  );

  it('discord_404_is_terminal_and_never_retried (mapped to destination_revoked)', () => {
    const d = decideRetry({
      attempt: 1,
      outcome: { kind: 'failed', code: 'destination_revoked', retryAfterSeconds: 1 },
      random: zero,
    });
    expect(d.action).toBe('dead_letter');
  });

  it('retries a transient failure via the queue with computed backoff', () => {
    expect(
      decideRetry({ attempt: 2, outcome: { kind: 'failed', code: 'destination_unavailable' }, random: half }),
    ).toEqual({
      action: 'retry',
      delaySeconds: 4,
      basis: 'backoff',
      transport: 'queue',
      malformedRetryAfter: false,
    });
  });

  it('retry_after_overrides_computed_backoff', () => {
    const d = decideRetry({
      attempt: 1,
      outcome: { kind: 'failed', code: 'destination_rate_limited', retryAfterSeconds: 30 },
      random: zero,
    });
    expect(d).toEqual({
      action: 'retry',
      delaySeconds: 30,
      basis: 'retry_after',
      transport: 'queue',
      malformedRetryAfter: false,
    });
  });

  it('never retries earlier than Retry-After, even with jitter', () => {
    const d = decideRetry({
      attempt: 1,
      outcome: { kind: 'failed', code: 'destination_rate_limited', retryAfterSeconds: 100 },
      random: almostOne,
    });
    expect(d.action === 'retry' && d.delaySeconds).toBe(110);
  });

  it('flags a malformed provider value and falls back to backoff', () => {
    const d = decideRetry({
      attempt: 1,
      outcome: { kind: 'failed', code: 'destination_rate_limited', retryAfterSeconds: Number.NaN },
      random: zero,
    });
    expect(d).toMatchObject({ action: 'retry', basis: 'backoff', malformedRetryAfter: true });
  });

  it('parks long waits on the D1 schedule instead of the queue', () => {
    const d = decideRetry({
      attempt: 8,
      outcome: { kind: 'failed', code: 'destination_unavailable' },
      random: zero,
    });
    expect(d).toMatchObject({ action: 'retry', delaySeconds: 12 * HOUR, transport: 'queue' });
    const longer = decideRetry({
      attempt: 9,
      outcome: { kind: 'failed', code: 'destination_unavailable' },
      random: zero,
    });
    // 24 h is exactly the queue maximum, so it still fits.
    expect(longer).toMatchObject({ action: 'retry', delaySeconds: 24 * HOUR, transport: 'queue' });
    const longest = decideRetry({
      attempt: 10,
      outcome: { kind: 'failed', code: 'destination_unavailable' },
      random: zero,
    });
    expect(longest).toMatchObject({ action: 'retry', delaySeconds: 48 * HOUR, transport: 'schedule' });
    expect(QUEUE_MAX_DELAY_SECONDS).toBe(24 * HOUR);
  });

  it('exhausted_delivery_reaches_a_terminal_dead_letter_state', () => {
    expect(
      decideRetry({ attempt: 13, outcome: { kind: 'failed', code: 'internal_error' }, random: zero }),
    ).toEqual({ action: 'dead_letter', reason: 'attempts_exhausted', code: 'internal_error' });
  });

  it('honours a per-connection policy', () => {
    const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, transientAttempts: 2, chronicLadderSeconds: [] };
    const input = { outcome: { kind: 'failed', code: 'destination_timeout' } as const, random: zero, policy };
    expect(decideRetry({ ...input, attempt: 1 }).action).toBe('retry');
    expect(decideRetry({ ...input, attempt: 2 }).action).toBe('dead_letter');
  });

  it('rejects an invalid attempt number', () => {
    expect(() => decideRetry({ attempt: 0, outcome: { kind: 'delivered' }, random: zero })).toThrow(
      RangeError,
    );
  });

  it('throws on an impossible outcome kind', () => {
    expect(() => decideRetry({ attempt: 1, outcome: { kind: 'bogus' } as never, random: zero })).toThrow(
      'Unhandled attempt outcome',
    );
  });
});
