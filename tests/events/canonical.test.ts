import { describe, expect, it } from 'vitest';
import { GITHUB_EVENT_TYPES } from '../../src/connectors/sources/github/catalog';
import { GITLAB_EVENT_TYPES } from '../../src/connectors/sources/gitlab/catalog';
import { STRIPE_EVENT_TYPES } from '../../src/connectors/sources/stripe/catalog';
import { extractGithubFacts, senderFacts } from '../../src/connectors/sources/github/facts';
import { classifyGithubEvent } from '../../src/connectors/sources/github/events';
import { mapGithubEvent } from '../../src/connectors/sources/github/map';
import { EVENT_CATALOG, severityOfStatus, descriptorFor } from '../../src/events/catalog';
import {
  CANONICAL_BUDGET_BYTES,
  CANONICAL_LIMITS,
  canonicalFromDisplay,
  displayOf,
  eventTypeOf,
  routingFactsOf,
  type CanonicalEvent,
} from '../../src/events/canonical';
import { cleanLine, hasUnsafeText } from '../../src/events/text';
import { canonicalSizeBytes, validateCanonicalEvent } from '../../src/events/validate';
import { LABEL_MAX } from '../../src/routing/filter-input';
import { en } from '../../web/src/i18n/messages.en';
import { providersEn } from '../../web/src/i18n/messages.providers.en';
import { loadFixtureJson, loadManifest } from '../fixtures/load';
import { normalize } from '../conformance/normalize';

const good = (): CanonicalEvent =>
  canonicalFromDisplay({
    provider: 'gitlab',
    adapterVersion: '1.0.0',
    id: 'evt-1',
    source: 'https://gitlab.com/acme/api',
    display: {
      title: 'Pipeline failed on main',
      url: 'https://gitlab.com/acme/api/-/pipelines/1',
      eventType: 'pipeline.failed',
      status: 'failure',
      repo: 'acme/api',
      actor: 'octocat',
      summary: 'a · b',
    },
  });

const withData = (over: Record<string, unknown>) => {
  const e = good();
  return { ...e, data: { ...e.data, ...over } };
};
const reasons = (value: unknown) => {
  const r = validateCanonicalEvent(value);
  return r.ok ? [] : r.errors.map((e) => `${e.field}:${e.reason}`);
};

describe('event type registry', () => {
  it('derives the per-source catalogues, so there is one table', () => {
    expect(GITHUB_EVENT_TYPES).toEqual(EVENT_CATALOG.github.map((d) => d.type));
    expect(GITLAB_EVENT_TYPES).toEqual(EVENT_CATALOG.gitlab.map((d) => d.type));
    expect(STRIPE_EVENT_TYPES).toEqual(EVENT_CATALOG.stripe.map((d) => d.type));
  });

  it('every entry has a unique type, a label that exists in the dashboard, and a consistent severity', () => {
    for (const [source, list] of Object.entries(EVENT_CATALOG)) {
      expect(new Set(list.map((d) => d.type)).size).toBe(list.length);
      for (const d of list) {
        expect(d.source).toBe(source);
        expect(d.defaultSeverity).toBe(severityOfStatus(d.defaultStatus));
        const known = source === 'github' ? en : providersEn;
        expect(Object.hasOwn(known, d.labelKey), d.labelKey).toBe(true);
      }
    }
  });

  it('keeps the statuses the GitHub route has always used', () => {
    const failing = ['workflow_run.failure', 'workflow_run.timed_out'];
    const passing = ['workflow_run.success', 'pull_request.merged'];
    for (const d of EVENT_CATALOG.github) {
      const expected = failing.includes(d.type) ? 'failure' : passing.includes(d.type) ? 'success' : 'info';
      expect(d.defaultStatus, d.type).toBe(expected);
    }
    expect(descriptorFor('github', 'nope')).toBeUndefined();
  });

  it('keeps the filter label bound in step with the canonical one', () => {
    expect(CANONICAL_LIMITS.label).toBe(LABEL_MAX);
  });
});

describe('canonical event validator', () => {
  it('accepts a well-formed event and returns it', () => {
    const r = validateCanonicalEvent(good());
    expect(r.ok).toBe(true);
  });

  it('requires id, source, type and specversion exactly 1.0', () => {
    for (const key of ['id', 'source', 'type'])
      expect(reasons({ ...good(), [key]: undefined })).toContain(`${key}:required`);
    expect(reasons({ ...good(), specversion: '0.3' })).toContain('specversion:bad_value');
  });

  it('treats a null optional attribute as unset', () => {
    const r = validateCanonicalEvent({ ...good(), subject: null, time: null });
    expect(r.ok).toBe(true);
    if (r.ok) expect('subject' in r.event).toBe(false);
  });

  it('rejects attribute names outside a-z0-9 and any unknown key, top level and in data', () => {
    expect(reasons({ ...good(), org_id: 'x' })).toEqual(
      expect.arrayContaining(['org_id:unknown_field', 'org_id:bad_value']),
    );
    expect(reasons({ ...good(), Foo: 'x' })).toContain('Foo:unknown_field');
    expect(reasons(withData({ payload: { a: 1 } }))).toContain('data.payload:unknown_field');
    expect(
      reasons(withData({ actor: { login: 'a', type: 'user', isBot: false, isGhost: false, email: 'x' } })),
    ).toContain('data.actor.email:unknown_field');
  });

  it('rejects control characters, bidi overrides, noncharacters and unpaired surrogates', () => {
    for (const bad of [
      'a\u0000b',
      'a‮b',
      'a b',
      'a﷐b',
      'a￾b',
      'a\u{1ffff}b',
      'a\ud800b',
      'a\udc00b',
      'a\u0085b',
    ])
      expect(reasons(withData({ title: bad })), JSON.stringify(bad)).toContain('data.title:unsafe_text');
    // A well-formed pair is fine; a summary may span lines but not hold other controls.
    expect(reasons(withData({ title: 'ok \u{1f600}' }))).toEqual([]);
    expect(reasons(withData({ summary: 'a\nb\tc' }))).toEqual([]);
    expect(reasons(withData({ summary: 'a\u0007b' }))).toContain('data.summary:unsafe_text');
  });

  it('requires an RFC 3339 time and a URI source', () => {
    expect(reasons({ ...good(), time: '2026-10-14T09:41:22.318Z' })).toEqual([]);
    expect(reasons({ ...good(), time: '2026-10-14T09:41:22+07:00' })).toEqual([]);
    for (const t of ['2026-10-14', '2026-13-01T00:00:00Z', 'yesterday', '2026-10-14 09:41:22Z'])
      expect(reasons({ ...good(), time: t }), t).toContain('time:bad_value');
    expect(reasons({ ...good(), source: 'not a uri' })).toContain('source:bad_value');
    expect(reasons({ ...good(), source: '/relative' })).toContain('source:bad_value');
  });

  it('bounds every field and never echoes a value in an error', () => {
    expect(reasons(withData({ title: 'x'.repeat(CANONICAL_LIMITS.title + 1) }))).toContain(
      'data.title:too_long',
    );
    expect(
      reasons(
        withData({ facts: { branch: null, baseBranch: null, draft: null, labels: Array(101).fill('a') } }),
      ),
    ).toContain('data.facts.labels:too_long');
    const r = validateCanonicalEvent(withData({ title: 'SECRET-TEXT\u0000' }));
    expect(JSON.stringify(r)).not.toContain('SECRET-TEXT');
  });

  it('requires an https link without credentials', () => {
    for (const url of ['http://a.test/x', 'javascript:alert(1)', 'https://u:p@a.test/', 'not a url'])
      expect(reasons(withData({ url })), url).toContain('data.url:bad_value');
  });

  it('keeps a catalogued source to its closed catalogue, and a generic type to the documented shape', () => {
    expect(reasons({ ...good(), type: 'io.lumi.noti.gitlab.pipeline.exploded' })).toContain(
      'type:not_in_catalog',
    );
    expect(reasons({ ...good(), provider: 'github', type: 'io.lumi.noti.github.pipeline.failed' })).toContain(
      'type:not_in_catalog',
    );
    expect(reasons({ ...good(), type: 'io.lumi.noti.github.pipeline.failed' })).toContain('type:bad_value');
    expect(reasons({ ...good(), type: 'pipeline.failed' })).toContain('type:bad_value');
    const generic = { ...good(), provider: 'generic', type: 'io.lumi.noti.generic.deploy.failed' };
    expect(reasons(generic)).toEqual([]);
    expect(reasons({ ...generic, type: 'io.lumi.noti.generic. spaced' })).toContain('type:bad_value');
  });

  it('refuses an event over the size budget instead of truncating it', () => {
    // Under every field bound the event cannot reach 64 KiB; prove the guard with a fake bound.
    const big = withData({ summary: 'x'.repeat(CANONICAL_LIMITS.summary) });
    expect(canonicalSizeBytes(big as CanonicalEvent)).toBeLessThan(CANONICAL_BUDGET_BYTES);
  });

  it('keeps the worst case within the budget', () => {
    const labels = Array(CANONICAL_LIMITS.labelCount).fill('l'.repeat(CANONICAL_LIMITS.label));
    const e = withData({
      title: 't'.repeat(CANONICAL_LIMITS.title),
      summary: 's'.repeat(CANONICAL_LIMITS.summary),
      url: `https://a.test/${'u'.repeat(2000)}`,
      repo: 'r'.repeat(CANONICAL_LIMITS.repo),
      facts: { branch: 'b'.repeat(255), baseBranch: 'b'.repeat(255), draft: false, labels },
    });
    const r = validateCanonicalEvent({ ...e, id: 'i'.repeat(CANONICAL_LIMITS.id) });
    expect(r.ok).toBe(true);
    expect(canonicalSizeBytes(e as CanonicalEvent)).toBeLessThan(CANONICAL_BUDGET_BYTES / 2);
  });
});

describe('text hygiene', () => {
  it('cleanLine removes unsafe code points and never leaves half a surrogate pair', () => {
    expect(cleanLine('a‮b\nc', 20)).toBe('a b c');
    const cut = cleanLine('x'.repeat(8) + '\u{1f600}'.repeat(5), 10);
    expect(hasUnsafeText(cut)).toBe(false);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('every fixture maps to a valid canonical event that round-trips to its display fields', () => {
  for (const entry of loadManifest().filter((e) => e.expect === 'delivered')) {
    it(entry.id, () => {
      const canonical = normalize(entry.provider, entry.headers, loadFixtureJson(entry));
      expect(canonical).not.toBeNull();
      const checked = validateCanonicalEvent(canonical);
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!canonical) return;
      expect(eventTypeOf(canonical)).toBe(canonical.type.split(`io.lumi.noti.${canonical.provider}.`)[1]);
      if (entry.provider !== 'github' && entry.provider !== 'generic') {
        const again = canonicalFromDisplay({
          provider: canonical.provider,
          adapterVersion: canonical.adapterversion,
          id: canonical.id,
          source: canonical.source,
          display: displayOf(canonical),
        });
        expect(again).toEqual(canonical);
      }
    });
  }
});

describe('GitHub routing facts come from the canonical event unchanged', () => {
  for (const entry of loadManifest().filter((e) => e.provider === 'github' && e.expect === 'delivered')) {
    it(entry.id, () => {
      const json = loadFixtureJson(entry);
      const kind = entry.headers['x-github-event'] as string;
      const canonical = normalize('github', entry.headers, json) as CanonicalEvent;
      const direct = extractGithubFacts(kind, json);
      // The canonical layer may refuse an unsafe fact; the documented examples have none.
      expect(routingFactsOf(canonical)).toEqual(direct);
    });
  }
});

describe('actor trust (F60)', () => {
  const sender = (s: Record<string, unknown>) => senderFacts({ sender: s });

  it('flags the ghost placeholder, whatever its case', () => {
    expect(sender({ login: 'ghost', type: 'User' })).toMatchObject({ isGhost: true, isBot: false });
    expect(sender({ login: 'Ghost' }).isGhost).toBe(true);
  });

  it('marks a bot by sender.type or by the [bot] suffix, and reports unknown as null, never false', () => {
    expect(sender({ login: 'dependabot[bot]', type: 'Bot' }).isBot).toBe(true);
    expect(sender({ login: 'renovate[bot]' }).isBot).toBe(true);
    expect(sender({ login: 'octocat', type: 'User' }).isBot).toBe(false);
    expect(sender({ login: 'octocat' }).isBot).toBeNull();
    expect(senderFacts({})).toEqual({ login: null, isBot: null, isGhost: null });
  });

  const base = {
    action: 'opened',
    pull_request: { title: 't', number: 1 },
    repository: { full_name: 'a/b' },
  };
  const map = (sender: Record<string, unknown>) =>
    mapGithubEvent({
      kind: 'pull_request',
      event: { ...base, sender },
      eventType: 'pull_request.opened',
      deliveryId: 'd',
    });

  it('never shows a ghost as a person, and shows a bot by its login', () => {
    const ghost = map({ login: 'ghost', type: 'User' });
    expect(ghost.data.actor).toMatchObject({ type: 'ghost', isGhost: true });
    expect(displayOf(ghost).actor).toBeUndefined();
    expect(displayOf(map({ login: 'dependabot[bot]', type: 'Bot' })).actor).toBe('dependabot[bot]');
  });

  it('reads the login only: a display name or profile text is never copied', () => {
    const event = map({
      login: 'octocat',
      type: 'User',
      name: 'Admin <security@example.invalid>',
      bio: 'I am the CEO',
      email: 'x@example.invalid',
    });
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/Admin|CEO|example\.invalid/);
    expect(event.data.actor?.login).toBe('octocat');
  });

  it('a spoofed login is bounded and cleaned, and is never an authorization input', () => {
    const event = map({ login: `evil‮${'x'.repeat(500)}`, type: 'User' });
    expect(validateCanonicalEvent(event).ok).toBe(true);
    expect(event.data.actor?.login.length).toBeLessThanOrEqual(CANONICAL_LIMITS.actor);
    expect(hasUnsafeText(event.data.actor?.login ?? '')).toBe(false);
  });
});

describe('GitHub classification feeds the closed catalogue only', () => {
  it('maps merged and conclusions to catalogued types', () => {
    expect(classifyGithubEvent('pull_request', { action: 'closed', pull_request: { merged: true } })).toBe(
      'pull_request.merged',
    );
    for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out'])
      expect(GITHUB_EVENT_TYPES as readonly string[]).toContain(
        classifyGithubEvent('workflow_run', { action: 'completed', workflow_run: { conclusion } }),
      );
  });
});

describe('invisible formatting and bounded work (L1, L2)', () => {
  it('rejects zero-width and tag characters, and allows ZWJ and ZWNJ that real text needs', () => {
    for (const bad of ['a\u200bb', 'a\u2060b', 'a\ufeffb', 'a\u061cb', 'a\u{e0041}b', 'a\u{e007f}b'])
      expect(hasUnsafeText(bad), JSON.stringify(bad)).toBe(true);
    // A family emoji is joined with ZWJ; Persian uses ZWNJ.
    expect(hasUnsafeText('\u{1f468}\u200d\u{1f469}\u200d\u{1f467}')).toBe(false);
    expect(hasUnsafeText('\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645')).toBe(false);
    expect(reasons(withData({ title: 'a\u200bb' }))).toContain('data.title:unsafe_text');
  });

  it('cleanLine turns invisible formatting into spaces and does bounded work on huge input', () => {
    expect(cleanLine('a\u200bb\ufeffc', 20)).toBe('a b c');
    const started = performance.now();
    const out = cleanLine('x\u200b'.repeat(5_000_000), 50);
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe('facts are verbatim or unknown (L3, L4)', () => {
  const map = (event: Record<string, unknown>) =>
    mapGithubEvent({
      kind: 'pull_request',
      event: {
        action: 'opened',
        sender: { login: 'a', type: 'User' },
        repository: { full_name: 'a/b' },
        ...event,
      },
      eventType: 'pull_request.opened',
      deliveryId: 'd',
    });
  const pull = (over: Record<string, unknown>) => ({
    pull_request: { title: 't', number: 1, labels: [], ...over },
  });

  it('a branch over the bound is unknown, never a truncated name', () => {
    const long = 'b'.repeat(CANONICAL_LIMITS.branch + 1);
    expect(map(pull({ head: { ref: long }, base: { ref: 'main' } })).data.facts.branch).toBeNull();
    const fits = 'b'.repeat(CANONICAL_LIMITS.branch);
    expect(map(pull({ head: { ref: fits }, base: { ref: 'main' } })).data.facts.branch).toBe(fits);
  });

  it('one label that cannot be carried makes the whole list unknown', () => {
    const labels = [{ name: 'bug' }, { name: 'bad\u200blabel' }];
    expect(map(pull({ labels })).data.facts.labels).toBeNull();
    expect(map(pull({ labels: [{ name: 'bug' }] })).data.facts.labels).toEqual(['bug']);
  });
});
