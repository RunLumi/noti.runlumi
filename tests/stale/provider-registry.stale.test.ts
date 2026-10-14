import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DESTINATIONS,
  REGISTRY_MAX_AGE_DAYS,
  daysSinceVerified,
} from '../../src/connectors/destinations/provider-registry';

/**
 * F229 staleness gate. Not part of `npm test` / `npm run check` (excluded in vitest.config.ts)
 * because a date-driven failure would block every pull request on the same day. Run by
 * `npm run check:stale`, weekly, from .github/workflows/registry-staleness.yml, where a failure
 * is a signal to re-read the provider pages and correct the registry. The future-date check
 * stays blocking in tests/destinations/provider-registry.test.ts.
 *
 * `verifiedOn` is an attestation by whoever updates it that they re-read `docsUrl`; today it is
 * the date of docs/DESTINATION_API_REFERENCE.md, and the pages themselves were not re-read.
 */
describe('provider registry staleness (weekly)', () => {
  it('no_allowlist_entry_is_older_than_180_days', () => {
    const stale = ALLOWED_DESTINATIONS.filter(
      (e) => daysSinceVerified(e, new Date()) > REGISTRY_MAX_AGE_DAYS,
    );
    expect(
      stale.map((e) => `${e.kind} (verifiedOn ${e.verifiedOn}, ${e.docsUrl})`),
      'Re-read the listed documentation, correct the entry if it moved, then update verifiedOn in a PR that says you re-read it',
    ).toEqual([]);
  });
});
