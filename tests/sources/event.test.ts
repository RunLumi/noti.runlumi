import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  parseGenericEvent,
  statusOfSeverity,
  toDisplayFields,
} from '../../src/connectors/sources/generic/event';
import { SUMMARY_MAX_CHARS } from '../../src/env';

const base = { type: 'deploy.failed', title: 'Deploy failed on production' };
const fields = (r: ReturnType<typeof parseGenericEvent>) => (r.ok ? [] : r.errors.map((e) => e.field));

describe('parseGenericEvent', () => {
  it('accepts the minimal event and defaults severity to info', () => {
    expect(parseGenericEvent(base)).toEqual({ ok: true, event: { ...base, severity: 'info', fields: [] } });
  });

  it('accepts the full documented envelope', () => {
    const r = parseGenericEvent({
      ...base,
      summary: 'Exit code 1\nsee logs',
      url: 'https://ci.example.com/runs/42?x=1',
      severity: 'critical',
      actor: 'deploy-bot',
      fields: { env: 'prod', attempt: 2, canary: false },
    });
    expect(r.ok && r.event.fields).toEqual([
      ['env', 'prod'],
      ['attempt', '2'],
      ['canary', 'false'],
    ]);
    expect(r.ok && r.event.url).toBe('https://ci.example.com/runs/42?x=1');
  });

  it('rejects non-objects and unknown keys', () => {
    for (const body of [null, [], 'x', 3]) expect(parseGenericEvent(body).ok).toBe(false);
    expect(fields(parseGenericEvent({ ...base, extra: 1 }))).toEqual(['extra']);
  });

  it('requires type and title with bounded, single-line text', () => {
    expect(fields(parseGenericEvent({}))).toEqual(['type', 'title']);
    expect(fields(parseGenericEvent({ ...base, type: 'has space' }))).toEqual(['type']);
    expect(fields(parseGenericEvent({ ...base, type: 'x'.repeat(LIMITS.type + 1) }))).toEqual(['type']);
    expect(fields(parseGenericEvent({ ...base, title: 'x'.repeat(LIMITS.title + 1) }))).toEqual(['title']);
    expect(fields(parseGenericEvent({ ...base, title: 'two\nlines' }))).toEqual(['title']);
    expect(fields(parseGenericEvent({ ...base, title: '   ' }))).toEqual(['title']);
    expect(fields(parseGenericEvent({ ...base, title: 42 }))).toEqual(['title']);
  });

  it('rejects bidi controls and separators in single-line fields', () => {
    for (const bad of ['a\u202eb', 'a\u2066b', 'a\u2028b', 'a\u0000b', 'a\u0085b'])
      expect(fields(parseGenericEvent({ ...base, title: bad, actor: bad }))).toEqual(['title', 'actor']);
    expect(fields(parseGenericEvent({ ...base, summary: 'a\u202eb' }))).toEqual(['summary']);
    expect(fields(parseGenericEvent({ ...base, summary: 'a\u0000b' }))).toEqual(['summary']);
  });

  it('only accepts absolute https URLs without credentials, and normalises them', () => {
    for (const url of [
      'http://example.com/x',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com',
      '//example.com',
      '/relative',
      'https://user:pw@example.com/',
      'https://',
      'not a url',
      `https://example.com/${'a'.repeat(LIMITS.url)}`,
      'https://example.com/\u202e',
      42,
    ])
      expect(fields(parseGenericEvent({ ...base, url }))).toEqual(['url']);
    const ok = parseGenericEvent({ ...base, url: 'HTTPS://Example.com/a b' });
    expect(ok.ok && ok.event.url).toBe('https://example.com/a%20b');
  });

  it('constrains severity to the closed set', () => {
    for (const s of ['info', 'warning', 'error', 'critical'])
      expect(parseGenericEvent({ ...base, severity: s }).ok).toBe(true);
    expect(fields(parseGenericEvent({ ...base, severity: 'fatal' }))).toEqual(['severity']);
    expect(fields(parseGenericEvent({ ...base, severity: 1 }))).toEqual(['severity']);
  });

  it('bounds fields by count, key shape and value size and type', () => {
    const many = Object.fromEntries(Array.from({ length: LIMITS.fieldCount + 1 }, (_, i) => [`k${i}`, 'v']));
    expect(fields(parseGenericEvent({ ...base, fields: many }))).toEqual(['fields']);
    for (const bad of [
      { 'bad/key': 'v' },
      { '': 'v' },
      { k: { nested: 1 } },
      { k: [1] },
      { k: null },
      { k: '' },
      { k: 'x'.repeat(LIMITS.fieldValue + 1) },
      { k: 'a\nb' },
      { k: Infinity },
      ['not', 'object'],
    ])
      expect(fields(parseGenericEvent({ ...base, fields: bad }))).toEqual(['fields']);
    expect(fields(parseGenericEvent({ ...base, fields: 'x' }))).toEqual(['fields']);
    const longKey = { ['x'.repeat(LIMITS.fieldKey + 1)]: 'v' };
    expect(fields(parseGenericEvent({ ...base, fields: longKey }))).toEqual(['fields']);
  });

  it('never echoes input values in error messages', () => {
    const r = parseGenericEvent({
      type: 'SECRETVALUE bad type',
      title: 'x'.repeat(999),
      url: 'http://SECRETVALUE.test',
    });
    expect(JSON.stringify(r)).not.toContain('SECRETVALUE');
  });
});

describe('mapping to the canonical display fields', () => {
  it('maps severity to the shared status vocabulary', () => {
    expect(statusOfSeverity('info')).toBe('info');
    expect(statusOfSeverity('warning')).toBe('warning');
    expect(statusOfSeverity('error')).toBe('failure');
    expect(statusOfSeverity('critical')).toBe('failure');
  });

  it('maps every field and leaves optional ones out when absent', () => {
    const parsed = parseGenericEvent({
      ...base,
      summary: 'Boom',
      url: 'https://ci.example.com/1',
      actor: 'bot',
      severity: 'error',
      fields: { env: 'prod' },
    });
    expect(parsed.ok && toDisplayFields(parsed.event)).toEqual({
      title: base.title,
      url: 'https://ci.example.com/1',
      status: 'failure',
      eventType: 'deploy.failed',
      actor: 'bot',
      summary: 'Boom\nenv: prod',
    });
    const minimal = parseGenericEvent(base);
    expect(minimal.ok && toDisplayFields(minimal.event)).toEqual({
      title: base.title,
      url: '',
      status: 'info',
      eventType: 'deploy.failed',
    });
  });

  it('cuts the summary to the shared budget with a visible ellipsis', () => {
    const parsed = parseGenericEvent({ ...base, summary: 'y'.repeat(900) });
    const out = parsed.ok ? toDisplayFields(parsed.event) : null;
    expect(out?.summary).toHaveLength(SUMMARY_MAX_CHARS);
    expect(out?.summary?.endsWith('…')).toBe(true);
  });
});
