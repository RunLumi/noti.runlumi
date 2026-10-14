import { describe, expect, it } from 'vitest';
import {
  ALLOWED_DESTINATIONS,
  REGISTRY_MAX_AGE_DAYS,
  daysSinceVerified,
  isAllowedHost,
  registryEntryFor,
} from '../../src/connectors/destinations/provider-registry';
import { checkDestinationUrl, larkDomainOf } from '../../src/connectors/destinations/url-policy';
import { DESTINATION_KINDS } from '../../src/connectors/destinations/types';

/**
 * F229: the allowlist is a typed registry with provenance (a docs URL and the date a human
 * read it) and expiry. The staleness test below is deliberately annoying: it fires when
 * nobody has re-read a provider's documentation in 180 days, and the fix is to re-read it.
 */
describe('provider registry (F229)', () => {
  it('has an entry for every destination kind except the customer-chosen one', () => {
    const kinds = ALLOWED_DESTINATIONS.map((e) => e.kind).sort();
    expect(kinds).toEqual(DESTINATION_KINDS.filter((k) => k !== 'generic_webhook').sort());
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('every_allowlist_entry_has_a_docs_url_and_a_verified_on_date', () => {
    for (const e of ALLOWED_DESTINATIONS) {
      expect(new URL(e.docsUrl).protocol, e.kind).toBe('https:');
      expect(e.verifiedOn, e.kind).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(e.verifiedOn)), e.kind).toBe(false);
      // Not in the future: a date nobody could have read yet is fabricated.
      expect(daysSinceVerified(e, new Date()), e.kind).toBeGreaterThanOrEqual(0);
    }
  });

  it('no_allowlist_entry_is_older_than_180_days', () => {
    expect(REGISTRY_MAX_AGE_DAYS).toBe(180);
    const stale = ALLOWED_DESTINATIONS.filter(
      (e) => daysSinceVerified(e, new Date()) > REGISTRY_MAX_AGE_DAYS,
    );
    expect(
      stale.map((e) => e.kind),
      'Re-read the provider documentation, fix the entry if it moved, then update verifiedOn',
    ).toEqual([]);
  });

  it('staleness is measured, not assumed (a clock past the limit fails)', () => {
    const entry = ALLOWED_DESTINATIONS[0];
    if (!entry) throw new Error('registry is empty');
    const later = new Date(Date.parse(entry.verifiedOn) + (REGISTRY_MAX_AGE_DAYS + 1) * 86_400_000);
    expect(daysSinceVerified(entry, later)).toBeGreaterThan(REGISTRY_MAX_AGE_DAYS);
  });

  it('hosts are exact, lowercase, and carry no wildcard syntax', () => {
    for (const e of ALLOWED_DESTINATIONS) {
      for (const h of e.hosts) {
        expect(h, e.kind).toBe(h.toLowerCase());
        expect(h, e.kind).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
        expect(h, e.kind).not.toContain('*');
      }
    }
  });

  it('wildcard_subdomain_requires_a_written_reason', () => {
    const wild = ALLOWED_DESTINATIONS.flatMap((e) => (e.wildcardSubdomains ?? []).map((w) => ({ e, w })));
    expect(wild.length).toBeGreaterThan(0);
    for (const { e, w } of wild) {
      expect(w.reason.trim().length, e.kind).toBeGreaterThanOrEqual(40);
      expect(w.suffix, e.kind).not.toContain('*');
    }
  });

  it('an entry with no path prefix says why the provider path is opaque', () => {
    for (const e of ALLOWED_DESTINATIONS) {
      if (e.pathPrefixes.length === 0) {
        expect(e.opaquePathReason?.trim().length ?? 0, e.kind).toBeGreaterThan(20);
      }
      for (const p of e.pathPrefixes) expect(p, e.kind).toMatch(/^\/.*\/$/);
    }
  });

  it('suffix_matching_cannot_be_bypassed_by_lookalike_hosts', () => {
    expect(isAllowedHost('slack', 'hooks.slack.com')).toBe(true);
    for (const h of [
      'evilhooks.slack.com',
      'hooks.slack.com.evil.com',
      'xhooks.slack.com',
      'slack.com',
      'hooks.slack.co',
      'hooks.slack.com.',
      '',
    ]) {
      expect(isAllowedHost('slack', h), h).toBe(false);
    }
    expect(isAllowedHost('teams', 'prod-12.westus.logic.azure.com')).toBe(true);
    for (const h of [
      'logic.azure.com',
      'evillogic.azure.com',
      'x.logic.azure.com.evil.com',
      'a_b.logic.azure.com',
    ]) {
      expect(isAllowedHost('teams', h), h).toBe(false);
    }
  });

  it('a host registered for one provider is not accepted for another', () => {
    expect(isAllowedHost('discord', 'hooks.slack.com')).toBe(false);
    expect(isAllowedHost('slack', 'discord.com')).toBe(false);
    expect(isAllowedHost('generic_webhook', 'hooks.slack.com')).toBe(false);
  });

  it('the URL policy and the registry agree on every registered host', () => {
    for (const e of ALLOWED_DESTINATIONS) {
      for (const h of e.hosts) {
        const r = checkDestinationUrl(e.kind, `https://${h}/`);
        // The path may fail; the host rule must not.
        expect(r.ok ? 'ok' : r.rule, `${e.kind} ${h}`).not.toBe('host');
      }
    }
  });

  it('Lark covers exactly the two regional hosts the adapter maps to a domain', () => {
    const lark = registryEntryFor('lark');
    expect([...lark.hosts].sort()).toEqual(['open.feishu.cn', 'open.larksuite.com']);
    for (const h of lark.hosts) expect(larkDomainOf(new URL(`https://${h}/`))).toBeDefined();
  });

  it('a host the registry does not list is rejected, never widened', () => {
    expect(checkDestinationUrl('slack', 'https://hooks.slack-gov.com/services/T1/B1/x')).toMatchObject({
      ok: false,
      rule: 'host',
    });
  });
});
