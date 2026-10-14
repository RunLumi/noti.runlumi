import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * read it) and expiry. Staleness is checked weekly, outside this file (tests/stale/).
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

  // Staleness (older than 180 days) is deliberately NOT asserted here: a date-driven failure
  // would break every pull request at once. It lives in tests/stale/ and runs weekly via
  // `npm run check:stale` (.github/workflows/registry-staleness.yml).
  it('the staleness limit is 180 days and the weekly check exists', () => {
    expect(REGISTRY_MAX_AGE_DAYS).toBe(180);
    const wf = readFileSync(join(process.cwd(), '.github/workflows/registry-staleness.yml'), 'utf8');
    expect(wf).toContain('npm run check:stale');
    expect(wf).toMatch(/schedule:/);
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

  it('Lark host labels and hosts agree in both directions (single source)', () => {
    const lark = registryEntryFor('lark');
    const labels = lark.hostLabels ?? {};
    for (const h of lark.hosts) expect(labels[h], `${h} has no label`).toBeDefined();
    for (const h of Object.keys(labels)) expect(lark.hosts, `${h} is labelled but not a host`).toContain(h);
    expect(larkDomainOf(new URL('https://open.larksuite.com/'))).toBe('larksuite');
    expect(larkDomainOf(new URL('https://open.feishu.cn/'))).toBe('feishu');
    expect(larkDomainOf(new URL('https://open.larksuite.com.evil.com/'))).toBeUndefined();
    expect(larkDomainOf(new URL('https://constructor/'))).toBeUndefined();
  });

  it('the registry states that verifiedOn is not a re-read attestation', () => {
    const src = readFileSync(join(process.cwd(), 'src/connectors/destinations/provider-registry.ts'), 'utf8');
    expect(src).toContain('ATTESTATION');
    expect(src).toContain('NOT a record that anyone re-read');
  });

  it('a host the registry does not list is rejected, never widened', () => {
    expect(checkDestinationUrl('slack', 'https://hooks.slack-gov.com/services/T1/B1/x')).toMatchObject({
      ok: false,
      rule: 'host',
    });
  });
});
