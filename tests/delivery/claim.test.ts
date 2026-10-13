import { describe, expect, it } from 'vitest';
import {
  CLAIM_OUTBOX_ROW_SQL,
  DEFAULT_LEASE_MS,
  DEFAULT_SWEEP_LIMIT,
  OUTBOX_STATEMENTS,
  OUTBOX_STALL_THRESHOLD_MS,
  RECLAIM_EXPIRED_LEASE_SQL,
  SELECT_DUE_WORKSPACES_SQL,
  DEFAULT_WORKSPACE_LIMIT,
  claimedRow,
  dueWorkspacesParams,
  markInvalidParams,
  scheduleRedispatchParams,
  buildClaim,
  claimWon,
  isOutboxStalled,
  markDispatchedParams,
  newLeaseToken,
  reclaimExpiredParams,
  reconcileCandidatesParams,
  releaseClaimParams,
} from '../../src/delivery/claim';

const NOW = 1_760_000_000_000;
const request = { orgId: 'org_1', rowId: 'row_1', nowMs: NOW, leaseToken: 'lease-1' } as const;

function placeholders(sql: string): number[] {
  return Array.from(new Set(Array.from(sql.matchAll(/\?(\d+)/g), (m) => Number(m[1])))).sort((a, b) => a - b);
}

describe('outbox claim SQL (F172/F174)', () => {
  it.each(Object.entries(OUTBOX_STATEMENTS))('%s carries the tenant predicate', (_name, sql) => {
    expect(sql).toMatch(/WHERE\s+organization_id = \?\d/);
  });

  it('the claim is a single conditional UPDATE … RETURNING, never read-then-write', () => {
    expect(CLAIM_OUTBOX_ROW_SQL).toMatch(/^UPDATE notification_outbox/);
    expect(CLAIM_OUTBOX_ROW_SQL).toContain("AND state = 'pending'");
    expect(CLAIM_OUTBOX_ROW_SQL).toMatch(
      /RETURNING id, organization_id, lease_token, lease_expires_at, payload_json$/,
    );
    expect(CLAIM_OUTBOX_ROW_SQL).not.toMatch(/SELECT/i);
  });

  it('state-changing statements after the claim are fenced by the lease token', () => {
    expect(OUTBOX_STATEMENTS.markDispatched).toContain("state = 'claimed' AND lease_token = ?4");
    expect(OUTBOX_STATEMENTS.release).toContain("state = 'claimed' AND lease_token = ?4");
    expect(RECLAIM_EXPIRED_LEASE_SQL).toContain('lease_expires_at <= ?1');
  });

  it.each(Object.entries(OUTBOX_STATEMENTS))('%s uses contiguous numbered placeholders', (_name, sql) => {
    const used = placeholders(sql);
    expect(used).toEqual(Array.from({ length: used.length }, (_, i) => i + 1));
  });

  it('makes no delivery-guarantee claim beyond at-least-once', () => {
    Object.values(OUTBOX_STATEMENTS).forEach((sql) => expect(sql.toLowerCase()).not.toContain('exactly'));
  });
});

describe('buildClaim', () => {
  it('binds parameters in placeholder order with a default lease', () => {
    const claim = buildClaim(request);
    expect(claim.sql).toBe(CLAIM_OUTBOX_ROW_SQL);
    expect(claim.params).toEqual([NOW, 'lease-1', NOW + DEFAULT_LEASE_MS, 'org_1', 'row_1']);
    expect(claim.params).toHaveLength(placeholders(CLAIM_OUTBOX_ROW_SQL).length);
    expect(claim.lease).toEqual({ token: 'lease-1', claimedAtMs: NOW, expiresAtMs: NOW + DEFAULT_LEASE_MS });
  });

  it('honours a custom lease', () => {
    expect(buildClaim({ ...request, leaseMs: 5000 }).lease.expiresAtMs).toBe(NOW + 5000);
  });

  it.each([
    [{ orgId: '' }, /orgId/],
    [{ rowId: '' }, /rowId/],
    [{ leaseToken: '' }, /leaseToken/],
    [{ leaseMs: 0 }, /leaseMs/],
    [{ leaseMs: 1.5 }, /leaseMs/],
  ])('rejects %o', (patch, message) => {
    expect(() => buildClaim({ ...request, ...patch })).toThrow(message);
  });

  it('mints unique lease tokens', () => {
    expect(newLeaseToken()).not.toBe(newLeaseToken());
  });
});

describe('claimWon', () => {
  const claim = buildClaim(request);
  const row = {
    id: 'row_1',
    organization_id: 'org_1',
    lease_token: 'lease-1',
    lease_expires_at: NOW + 1,
    payload_json: '{}',
  };

  it('is true only for exactly our row with our token', () => {
    expect(claimWon([row], claim)).toBe(true);
  });

  it('two_concurrent_dispatchers: the loser sees no row', () => {
    expect(claimWon([], claim)).toBe(false);
  });

  it.each([
    [[row, row]],
    [[null]],
    [['row_1']],
    [[{ ...row, lease_token: 'other' }]],
    [[{ ...row, organization_id: 'org_2' }]],
    [[{ ...row, id: 'row_2' }]],
    [[{ ...row, payload_json: null }]],
  ])('rejects %o', (rows) => {
    expect(claimWon(rows, claim)).toBe(false);
  });
});

describe('follow-up statement params', () => {
  const lease = buildClaim(request).lease;

  it('match their placeholders', () => {
    expect(markDispatchedParams('org_1', 'row_1', lease, '2026-10-13T00:00:00Z')).toEqual([
      '2026-10-13T00:00:00Z',
      'org_1',
      'row_1',
      'lease-1',
    ]);
    expect(releaseClaimParams('org_1', 'row_1', lease, 'destination_unavailable')).toEqual([
      'destination_unavailable',
      'org_1',
      'row_1',
      'lease-1',
    ]);
    expect(reclaimExpiredParams('org_1', 'row_1', NOW)).toEqual([NOW, 'org_1', 'row_1']);
    expect(reconcileCandidatesParams('org_1', NOW)).toEqual(['org_1', NOW, DEFAULT_SWEEP_LIMIT]);
    expect(reconcileCandidatesParams('org_1', NOW, 5)).toEqual(['org_1', NOW, 5]);
  });

  it('bounds the reconciler sweep', () => {
    expect(() => reconcileCandidatesParams('org_1', NOW, 0)).toThrow(RangeError);
  });
});

describe('reconciler workspace enumeration and scheduling', () => {
  it('enumerates only workspaces, never rows, and skips rows with no tenant', () => {
    expect(SELECT_DUE_WORKSPACES_SQL).toMatch(/^SELECT DISTINCT organization_id FROM/);
    expect(SELECT_DUE_WORKSPACES_SQL).toContain('organization_id IS NOT NULL');
    expect(dueWorkspacesParams(NOW)).toEqual([NOW, DEFAULT_WORKSPACE_LIMIT]);
    expect(() => dueWorkspacesParams(NOW, 0)).toThrow(RangeError);
  });

  it('a parked row is not claimable before not_before', () => {
    expect(CLAIM_OUTBOX_ROW_SQL).toContain('(not_before IS NULL OR not_before <= ?1)');
    expect(scheduleRedispatchParams('org_1', 'row_1', NOW)).toEqual([NOW, 'org_1', 'row_1']);
  });

  it('invalid rows are fenced by the lease too', () => {
    const lease = buildClaim(request).lease;
    expect(markInvalidParams('org_1', 'row_1', lease)).toEqual(['org_1', 'row_1', 'lease-1']);
  });

  it('claimedRow returns the payload of a won claim', () => {
    const claim = buildClaim(request);
    const won = {
      id: 'row_1',
      organization_id: 'org_1',
      lease_token: 'lease-1',
      lease_expires_at: 1,
      payload_json: '{}',
    };
    expect(claimedRow([won], claim)).toEqual(won);
    expect(claimedRow([], claim)).toBeNull();
  });
});

describe('isOutboxStalled (F173)', () => {
  it('raises only past five minutes', () => {
    expect(isOutboxStalled(NOW, NOW + OUTBOX_STALL_THRESHOLD_MS)).toBe(false);
    expect(isOutboxStalled(NOW, NOW + OUTBOX_STALL_THRESHOLD_MS + 1)).toBe(true);
  });
});
