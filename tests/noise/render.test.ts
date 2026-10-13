import { describe, expect, it } from 'vitest';
import { COMBINED_SUMMARY_MAX_CHARS } from '../../src/env';
import {
  DIGEST_LIST_MAX,
  GROUP_LIST_MAX,
  renderDigest,
  renderGroup,
  worstStatus,
  type HeldItem,
} from '../../src/routing/noise-render';

const item = (over: Partial<HeldItem> & { n: number }): HeldItem => ({
  id: `id-${String(over.n).padStart(4, '0')}`,
  holdReason: 'digest',
  groupKey: `key-${over.n}_`.padEnd(32, '0'),
  heldAt: 1000 + over.n,
  eventType: 'issue_comment.created',
  title: `Item ${over.n}`,
  url: `https://github.com/acme/web/issues/${over.n}`,
  repo: 'acme/web',
  actor: 'octocat',
  status: 'info',
  summary: '',
  resolved: false,
  ...over,
});

describe('renderGroup', () => {
  const items = [1, 2, 3].map((n) => item({ n, groupKey: 'same'.padEnd(32, '0'), holdReason: 'grouped' }));

  it('shows the newest item, the count and a list newest first', () => {
    const g = renderGroup(items);
    expect(g.title).toBe('Item 3 · 3 updates');
    expect(g.count).toBe(3);
    expect(g.url).toBe('https://github.com/acme/web/issues/3');
    expect(g.repo).toBe('acme/web');
    const lines = (g.summary ?? '').split('\n').filter((l) => l.startsWith('•'));
    expect(lines.map((l) => l.replace(/^• acme\/web: /, ''))).toEqual(['Item 3', 'Item 2', 'Item 1']);
  });

  it('caps the list and says how many are not shown', () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ n: i + 1, groupKey: 'same'.padEnd(32, '0') }));
    const g = renderGroup(many);
    expect((g.summary ?? '').split('\n').filter((l) => l.startsWith('•'))).toHaveLength(GROUP_LIST_MAX);
    expect(g.summary).toContain(`…and ${12 - GROUP_LIST_MAX} more not shown.`);
    expect(g.count).toBe(12);
  });

  it('takes the worst status and labels it with a text marker, not colour alone', () => {
    const g = renderGroup([
      item({ n: 1, status: 'success' }),
      item({ n: 2, status: 'failure' }),
      item({ n: 3 }),
    ]);
    expect(g.status).toBe('failure');
    expect(g.summary).toContain('✗');
    expect(g.summary).toContain('✓');
  });

  it('is independent of the order the rows were read in', () => {
    expect(renderGroup([...items].reverse())).toEqual(renderGroup(items));
  });

  it('refuses fewer than two items (a single item goes out as itself)', () => {
    expect(() => renderGroup([item({ n: 1 })])).toThrow();
  });

  it('keeps long titles on one line and inside the budget', () => {
    const g = renderGroup([
      item({ n: 1, title: 'a\nb'.repeat(300) }),
      item({ n: 2, title: 'x'.repeat(400) }),
    ]);
    expect(g.title.length).toBeLessThanOrEqual(300);
    expect(g.title).not.toContain('\n');
    expect((g.summary ?? '').length).toBeLessThanOrEqual(COMBINED_SUMMARY_MAX_CHARS);
  });
});

describe('renderDigest', () => {
  it('says how many updates were held and why, singular and plural', () => {
    expect(renderDigest([item({ n: 1 })], 'quiet_hours').title).toBe('1 update while you were away');
    expect(renderDigest([item({ n: 1 })], 'quiet_hours').summary).toMatch(
      /^1 update held during quiet hours:/,
    );
    expect(renderDigest([item({ n: 1 }), item({ n: 2 })], 'digest').title).toBe('Summary: 2 updates');
    expect(renderDigest([item({ n: 1 }), item({ n: 2 })], 'digest').summary).toMatch(
      /^2 updates since the last summary:/,
    );
  });

  it('orders failures first, then newest first', () => {
    const d = renderDigest(
      [
        item({ n: 1, status: 'success' }),
        item({ n: 2, status: 'failure' }),
        item({ n: 3, status: 'info' }),
        item({ n: 4, status: 'success' }),
      ],
      'digest',
    );
    const order = (d.summary ?? '')
      .split('\n')
      .filter((l) => /^[✗!•✓]/.test(l))
      .map((l) => /Item (\d)/.exec(l)?.[1]);
    expect(order).toEqual(['2', '3', '4', '1']);
  });

  it('collapses entries with the same group key into one line with a count', () => {
    const same = 'same'.padEnd(32, '0');
    const d = renderDigest(
      [item({ n: 1, groupKey: same }), item({ n: 2, groupKey: same }), item({ n: 3 })],
      'digest',
    );
    const lines = (d.summary ?? '').split('\n').filter((l) => /^[✗!•✓]/.test(l));
    expect(lines).toHaveLength(2);
    expect(d.summary).toContain('(×2)');
    expect(d.count).toBe(3);
  });

  it('caps the entries and states what is not shown', () => {
    const many = Array.from({ length: 40 }, (_, i) => item({ n: i + 1, url: '' }));
    const d = renderDigest(many, 'digest');
    expect((d.summary ?? '').split('\n').filter((l) => /^[✗!•✓]/.test(l))).toHaveLength(DIGEST_LIST_MAX);
    expect(d.summary).toContain(`…and ${40 - DIGEST_LIST_MAX} more items not shown.`);
  });

  it('marks a resolved failure in text', () => {
    const d = renderDigest([item({ n: 1, status: 'success', resolved: true })], 'digest');
    expect(d.summary).toContain('(resolved)');
  });

  it('omits a link that is too long to be useful rather than cutting it', () => {
    const d = renderDigest([item({ n: 1, url: `https://example.test/${'a'.repeat(300)}` })], 'digest');
    expect(d.summary).not.toContain('https://example.test');
  });

  it('names the repository only when every item shares one', () => {
    expect(renderDigest([item({ n: 1 }), item({ n: 2 })], 'digest').repo).toBe('acme/web');
    expect(renderDigest([item({ n: 1 }), item({ n: 2, repo: 'acme/api' })], 'digest').repo).toBeUndefined();
  });

  it('refuses an empty list: an empty digest is not rendered at all', () => {
    expect(() => renderDigest([], 'digest')).toThrow();
  });
});

describe('worstStatus', () => {
  it.each([
    [['success', 'info'], 'info'],
    [['info', 'warning'], 'warning'],
    [['warning', 'failure', 'success'], 'failure'],
    [['success'], 'success'],
  ] as const)('%j is %s', (statuses, expected) =>
    expect(worstStatus(statuses.map((status, n) => item({ n, status })))).toBe(expected),
  );
});
