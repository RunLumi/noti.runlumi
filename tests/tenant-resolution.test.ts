import { describe, it, expect } from 'vitest';
import { readInstallationBlock } from '../src/connectors/sources/github/tenant';

/**
 * The inbound tenant resolver.
 *
 * A verified GitHub signature proves only that the request was signed with our App-wide
 * webhook secret — which every installation of our App holds. The `installation` block is
 * the only tenant signal that arrives inside the signed bytes, so parsing it correctly is
 * what stands between an attacker-chosen `repository.full_name` and another tenant's
 * notifications.
 */
const APP_ID = '12345';
const APP_ID_NUM = 12345;

// GitHub sends `app_id` and `installation.id` as numbers.
const installation = (id: unknown, appId: unknown = APP_ID_NUM) => ({
  installation: { id, app_id: appId, target_type: 'Organization' },
});

describe('inbound tenant resolution', () => {
  it('accepts a well-formed installation block', () => {
    expect(readInstallationBlock(installation(987654), APP_ID)).toEqual({
      kind: 'ok',
      installationId: '987654',
    });
  });

  it('rejects a payload with no installation block', () => {
    expect(readInstallationBlock({ repository: { full_name: 'acme/repo' } }, APP_ID)).toEqual({
      kind: 'no-installation',
    });
  });

  it('rejects a payload whose installation is not an object', () => {
    expect(readInstallationBlock({ installation: 'nope' }, APP_ID)).toEqual({
      kind: 'no-installation',
    });
  });

  it('rejects a non-integer installation id', () => {
    expect(readInstallationBlock(installation(1.5), APP_ID)).toEqual({ kind: 'no-installation' });
    expect(readInstallationBlock(installation('987654'), APP_ID)).toEqual({
      kind: 'no-installation',
    });
    expect(readInstallationBlock(installation(null), APP_ID)).toEqual({ kind: 'no-installation' });
  });

  it('rejects an installation belonging to a different App', () => {
    // This is the cross-app confusion case: a payload minted for another App must never
    // be matched against our installation registry.
    expect(readInstallationBlock(installation(987654, '99999'), APP_ID)).toEqual({
      kind: 'app-mismatch',
    });
  });

  it('rejects a negative or zero installation id', () => {
    expect(readInstallationBlock(installation(-1), APP_ID)).toEqual({ kind: 'no-installation' });
    expect(readInstallationBlock(installation(0), APP_ID)).toEqual({ kind: 'no-installation' });
  });

  it('rejects a present app_id that is not a number', () => {
    // A string app_id must not slip past the cross-App check by failing a type guard.
    expect(readInstallationBlock(installation(987654, '12345'), APP_ID)).toEqual({
      kind: 'app-mismatch',
    });
    expect(readInstallationBlock(installation(987654, null), APP_ID)).toEqual({
      kind: 'app-mismatch',
    });
  });

  it('treats a missing app_id as acceptable but never invents one', () => {
    // GitHub omits app_id in some shapes; the signature still authenticates the body, and
    // the installation id lookup is still scoped to OUR app id in the query.
    expect(readInstallationBlock({ installation: { id: 42 } }, APP_ID)).toEqual({
      kind: 'ok',
      installationId: '42',
    });
  });

  it('never resolves a tenant from a repository field', () => {
    // Regression guard for D3: the repository name is attacker-chosen body content and
    // must not influence tenant resolution at all.
    const result = readInstallationBlock(
      { repository: { full_name: 'victim/private-repo' }, ...installation(1) },
      APP_ID,
    );
    expect(result).toEqual({ kind: 'ok', installationId: '1' });
  });
});
