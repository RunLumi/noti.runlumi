import { describe, expect, it } from 'vitest';
import {
  REDACTED_EMAIL,
  REDACTED_PHONE,
  redactContactDetails,
} from '../../src/connectors/destinations/redact';
import { escapeText } from '../../src/connectors/destinations/markup';
import {
  MAX_FIELD_INPUT_CHARS,
  boundInput,
  prepareNotification,
} from '../../src/connectors/destinations/render';
import { capabilitiesFor } from '../../src/connectors/destinations/capabilities';
import { checkDestinationUrl } from '../../src/connectors/destinations/url-policy';
import { classifyTransportError } from '../../src/connectors/destinations/classify';
import { larkAdapter, sendRequest, slackAdapter, teamsAdapter } from '../../src/connectors/destinations';
import { BASE, NOW, response } from './fixtures';

function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe('H1: redaction and rendering are linear on hostile input', () => {
  it.each([
    ['a'.repeat(200_000)],
    ['a@'.repeat(100_000)],
    ['a.'.repeat(100_000) + '@'],
    ['@' + 'a-'.repeat(100_000)],
    ['1 '.repeat(100_000)],
    ['+1'.repeat(100_000)],
  ])('redactContactDetails on a 200k-char input finishes in < 50 ms (#%#)', (input) => {
    redactContactDetails('warm up a@b.co 1234 5678 9');
    expect(timed(() => redactContactDetails(input))).toBeLessThan(50);
  });

  it('bounds every field before segmentation, without splitting a surrogate pair', () => {
    const huge = 'x'.repeat(MAX_FIELD_INPUT_CHARS - 1) + '😀' + 'y'.repeat(10);
    const bounded = boundInput(huge);
    expect(bounded.length).toBe(MAX_FIELD_INPUT_CHARS - 1);
    const prepared = prepareNotification(
      { ...BASE, title: huge, summary: huge, actor: huge, repo: huge, linkLabel: huge },
      capabilitiesFor('lark'),
    );
    for (const v of [
      prepared.notification.title,
      prepared.notification.summary,
      prepared.notification.actor,
    ]) {
      expect((v ?? '').length).toBeLessThanOrEqual(MAX_FIELD_INPUT_CHARS);
    }
  });

  it('renders a 200k-char event on every adapter quickly and within budget', () => {
    const n = {
      ...BASE,
      title: 'a@'.repeat(100_000),
      summary: 'a'.repeat(200_000),
      actor: 'b'.repeat(200_000),
    };
    for (const adapter of [slackAdapter, teamsAdapter, larkAdapter]) {
      const caps = capabilitiesFor(adapter.kind);
      let ok = false;
      const ms = timed(() => {
        const r = adapter.render(n, caps);
        ok = r.ok && r.message.bytes <= caps.maxBodyBytes && r.message.truncatedFields.includes('summary');
      });
      expect(ok).toBe(true);
      expect(ms).toBeLessThan(500);
    }
  });
});

describe('M1: escaping applies to every code point inside a grapheme cluster', () => {
  it.each([
    ['<́', 'slack_mrkdwn', '&lt;́'],
    ['&‍', 'slack_mrkdwn', '&amp;‍'],
    ['>️', 'slack_mrkdwn', '&gt;️'],
    ['<́at id=all>', 'lark_md', '＜́at id=all＞'],
    ['[́x]‍(y)', 'lark_md', '［́x］‍(y)'],
    ['[️x]', 'adaptive_card_md', '［️x］'],
  ] as const)('escapes %j in %s', (input, dialect, expected) => {
    expect(escapeText(input, dialect)).toBe(expected);
  });

  it('cannot smuggle a Slack mention through a combining mark', () => {
    expect(escapeText('<́!here>', 'slack_mrkdwn')).not.toContain('<');
  });
});

describe('M2: phone masking requires a plausible phone shape', () => {
  it.each([
    'Released on 2026-10-13',
    'Build 20261013 passed',
    'Run 12345678 passed',
    'Bump to v1.2.3.4.5.6.7.8',
    'Deployed 2026-10-13 12:00:00 UTC',
    'Run id 1234567890 finished',
    'sha a1234567890b',
  ])('does not mask %j', (text) => {
    expect(redactContactDetails(text)).toEqual({ text, redacted: false });
  });

  it.each([
    ['call +84 912 345 678', `call ${REDACTED_PHONE}`],
    ['call +1-415-555-0100 now', `call ${REDACTED_PHONE} now`],
    ['mobile 13812345678', `mobile ${REDACTED_PHONE}`],
    ['office 028 3823 4567', `office ${REDACTED_PHONE}`],
    ['mail jane.doe@example.com.', `mail ${REDACTED_EMAIL}.`],
  ])('masks %j', (text, expected) => {
    expect(redactContactDetails(text).text).toBe(expected);
  });

  it('does not treat a bare @mention or a scoped package as an email', () => {
    for (const text of ['@octocat', 'npm i @scope/pkg', 'a@b', 'user@localhost']) {
      expect(redactContactDetails(text).redacted).toBe(false);
    }
  });
});

describe('M3: Lark DLP masking covers every free-text field', () => {
  it('masks actor, repo and link label, and reports them', () => {
    const r = larkAdapter.render(
      {
        ...BASE,
        actor: 'jane@example.com',
        repo: 'org/+84 912 345 678',
        linkLabel: 'mail ops@example.org',
      },
      capabilitiesFor('lark'),
    );
    if (!r.ok) throw new Error('render');
    const json = JSON.stringify(r.message.payload);
    expect(json).not.toContain('jane@example.com');
    expect(json).not.toContain('ops@example.org');
    expect(json).not.toContain('912 345');
    expect(r.message.redactedFields).toEqual(expect.arrayContaining(['meta', 'link']));
  });

  it('does not redact for destinations without DLP', () => {
    const r = slackAdapter.render({ ...BASE, actor: 'jane@example.com' }, capabilitiesFor('slack'));
    expect(r.ok && r.message.redactedFields).toEqual([]);
  });
});

describe('M5: unknown Lark code with an unambiguous HTTP status', () => {
  it.each([
    [401, 'destination_unauthorized'],
    [403, 'destination_unauthorized'],
    [404, 'destination_revoked'],
    [410, 'destination_revoked'],
  ])('HTTP %i maps to permanent %s and stays flagged unmapped', (status, reason) => {
    expect(larkAdapter.classifyResponse(response(status, '{"code":777777}'), NOW)).toEqual({
      outcome: 'permanent',
      reason,
      unmapped: true,
    });
  });

  it('keeps an unknown code on HTTP 400 retryable, since Lark throttles with 400', () => {
    expect(larkAdapter.classifyResponse(response(400, '{"code":777777}'), NOW)).toMatchObject({
      outcome: 'retryable',
      unmapped: true,
    });
  });
});

describe('L1: Slack webhook path shape', () => {
  it.each([
    ['https://hooks.slack.com/services/T0001/B0001/abcDEF123', 'ok'],
    ['https://hooks.slack.com/services/T0001', 'path'],
    ['https://hooks.slack.com/services/T0001/B0001', 'path'],
    ['https://hooks.slack.com/services/T0001/B0001/', 'path'],
    ['https://hooks.slack.com/services/T0001//abc', 'path'],
    ['https://hooks.slack.com/services/X0001/B0001/abc', 'path'],
    ['https://hooks.slack.com/services/T0001/B0001/abc/extra', 'path'],
  ])('%s → %s', (url, expected) => {
    const r = checkDestinationUrl('slack', url);
    expect(r.ok ? 'ok' : r.rule).toBe(expected);
  });
});

describe('L3: redirects are permanent, never retried or followed', () => {
  it.each([301, 302, 307, 308, 0])('HTTP %i is destination_redirected for every adapter', (status) => {
    for (const adapter of [slackAdapter, teamsAdapter, larkAdapter]) {
      expect(
        adapter.classifyResponse(response(status, '', { location: 'https://evil.example' }), NOW),
      ).toEqual({
        outcome: 'permanent',
        reason: 'destination_redirected',
      });
    }
  });

  it('sendRequest asks fetch not to follow redirects', async () => {
    let redirect: RequestRedirect | undefined;
    const r = await sendRequest(
      {
        kind: 'teams',
        url: 'https://prod.westus.logic.azure.com/workflows/x',
        method: 'POST',
        headers: {},
        body: '{}',
      },
      (res, at) => teamsAdapter.classifyResponse(res, at),
      {
        fetch: (_u, init) => {
          redirect = init.redirect;
          return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://x' } }));
        },
      },
    );
    expect(redirect).toBe('manual');
    expect(r).toEqual({ outcome: 'permanent', reason: 'destination_redirected' });
    expect(classifyTransportError(new TypeError('fetch failed')).reason).toBe('network_error');
  });
});

describe('L7: emphasised titles cannot break their markup', () => {
  it('keeps Slack bold intact with `*` and newlines in the title', () => {
    const r = slackAdapter.render(
      { ...BASE, title: '*urgent*\nfix *all* the things' },
      capabilitiesFor('slack'),
      {
        startAt: 'markdown',
      },
    );
    if (!r.ok) throw new Error('render');
    const text = r.message.payload.text;
    const firstLine = typeof text === 'string' ? text.split('\n')[0] : undefined;
    expect(firstLine).toBe('*Failed: ∗urgent∗ fix ∗all∗ the things*');
  });

  it('keeps Lark and Teams `**` wrapping intact', () => {
    for (const adapter of [larkAdapter, teamsAdapter]) {
      const r = adapter.render({ ...BASE, title: 'a ** b\r\nc' }, capabilitiesFor(adapter.kind), {
        startAt: 'markdown',
      });
      expect(r.ok && JSON.stringify(r.message.payload)).toContain('**Failed: a ∗∗ b c**');
    }
  });

  it('collapses newlines in card titles too', () => {
    const r = slackAdapter.render({ ...BASE, title: 'one\n\ntwo' }, capabilitiesFor('slack'));
    expect(r.ok && JSON.stringify(r.message.payload)).toContain('"text":"Failed: one two"');
  });
});
