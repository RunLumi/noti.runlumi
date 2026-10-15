import { describe, expect, it } from 'vitest';
import { REDACTED, isDeniedKey, redact, scrubString } from '../../src/platform/redact';

/** Synthetic fixture, assembled at runtime so it is obviously not a real credential. */
const SECRET = ['fixture', 'value', 'abcdef0123456789'].join('_');
const SLACK_HOOK = 'https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX';
const LARK_HOOK = 'https://open.larksuite.com/open-apis/bot/v2/hook/0f0e-secret-uuid?sign=abc123';

/** No substring of length >= 6 of the secret may appear in the output (F12: no prefixes). */
function expectNoFragment(output: unknown, secret: string): void {
  const text = JSON.stringify(output);
  for (let i = 0; i + 6 <= secret.length; i++) {
    expect(text).not.toContain(secret.slice(i, i + 6));
  }
}

describe('isDeniedKey (F12 denylist)', () => {
  it.each([
    'webhook_url',
    'webhookUrl',
    'url',
    'secret',
    'larkSecretCiphertext',
    'token',
    'access_token',
    'Authorization',
    'cookie',
    'Set-Cookie',
    'x-hub-signature-256',
    'sign',
    'password',
    'ciphertext',
    'api_key',
    'apikey',
    'privateKey',
    'email',
    'installation_id',
    'installationId',
  ])('denies %s', (key) => {
    expect(isDeniedKey(key)).toBe(true);
  });

  it.each([
    'assignee',
    'design',
    'monkey',
    'delivery_id',
    'workspace_id',
    'event_type',
    'correlation_id',
    'status',
  ])('allows %s', (key) => {
    expect(isDeniedKey(key)).toBe(false);
  });
});

describe('scrubString', () => {
  it('keeps only scheme and host of URLs', () => {
    expect(scrubString(`POST ${SLACK_HOOK} failed`)).toBe(`POST https://hooks.slack.com/${REDACTED} failed`);
    expect(scrubString(LARK_HOOK)).toBe(`https://open.larksuite.com/${REDACTED}`);
    expect(scrubString('see https://example.com')).toBe('see https://example.com');
  });

  it('drops userinfo and ports', () => {
    expect(scrubString('https://user:pa55word@internal.example:8443/x')).toBe(
      `https://internal.example/${REDACTED}`,
    );
  });

  it('removes bearer and basic credentials', () => {
    expect(scrubString(`Authorization: Bearer ${SECRET}`)).not.toContain(SECRET);
    expect(scrubString(`bearer ${SECRET}`)).toBe(`bearer ${REDACTED}`);
    expect(scrubString(`Basic dXNlcjpwYXNz`)).toBe(`Basic ${REDACTED}`);
  });

  it('removes sign=, token= and similar assignments', () => {
    expect(scrubString('timestamp=1&sign=abc123def')).toBe(`timestamp=1&sign=${REDACTED}`);
    expect(scrubString(`token: ${SECRET}`)).toBe(`token: ${REDACTED}`);
    expect(scrubString('status=500 retry=2')).toBe('status=500 retry=2');
  });

  it('removes known token formats and signature digests', () => {
    expect(scrubString('ghp_abcdefghijklmnop0123')).toBe(REDACTED);
    expect(scrubString('xoxb-1234-5678-abcdef')).toBe(REDACTED);
    expect(scrubString('github_pat_11ABCDEFG_xyz')).toBe(REDACTED);
    expect(scrubString('sk_live_abcdefgh1234')).toBe(REDACTED);
    expect(scrubString('sha256=0123456789abcdef0123456789abcdef')).toBe(`sha256=${REDACTED}`);
  });

  it('removes secrets from echoed JSON bodies', () => {
    const body = `{"code":19021,"msg":"sign match fail","secret":"${SECRET}","webhook":"x","n":7,"token":12345}`;
    const out = scrubString(body);
    expect(out).toContain('"code":19021');
    expect(out).toContain('"msg":"sign match fail"');
    expect(out).toContain(`"secret":"${REDACTED}"`);
    expect(out).toContain(`"token":"${REDACTED}"`);
    expect(out).not.toContain(SECRET);
  });

  it('truncates after scrubbing, never exposing a secret prefix', () => {
    const long = `${'a'.repeat(30)} Bearer ${SECRET} ${'b'.repeat(100)}`;
    const out = scrubString(long, 40);
    expect(out).toMatch(/…\[truncated \d+ chars\]$/);
    expectNoFragment(out, SECRET);
  });

  it('never cuts a [redacted] marker in half when it truncates (ADR 0051)', () => {
    // `token=` + the marker ends at 16; a cut at 12 would leave `token=[reda`.
    expect(scrubString(`token=${SECRET} tail`, 12)).toBe(`token=…[truncated ${REDACTED.length + 5} chars]`);
    expect(scrubString(`token=${SECRET} tail`, 16)).toBe(`token=${REDACTED}…[truncated 5 chars]`);
  });

  it('caps hostile input before scanning and reports everything dropped', () => {
    const out = scrubString('x'.repeat(10_000), 10);
    expect(out).toBe(`${'x'.repeat(10)}…[truncated 9990 chars]`);
  });
});

describe('redact', () => {
  it('redact_removes_nested_secret_fields', () => {
    const input = {
      delivery_id: 'd1',
      destination: { type: 'slack', webhook_url: SLACK_HOOK, nested: { credentials: { a: SECRET } } },
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    };
    const out = redact(input);
    expect(out).toEqual({
      delivery_id: 'd1',
      destination: { type: 'slack', webhook_url: REDACTED, nested: { credentials: REDACTED } },
      headers: { authorization: REDACTED, 'content-type': 'application/json' },
    });
    expectNoFragment(out, SECRET);
  });

  it('redact_preserves_error_name_and_code', () => {
    const err = Object.assign(new TypeError(`fetch ${SLACK_HOOK} failed with token=${SECRET}`), {
      code: 'ECONNRESET',
    });
    const out = redact(err);
    expect(out).toEqual({
      name: 'TypeError',
      message: `fetch https://hooks.slack.com/${REDACTED} failed with token=${REDACTED}`,
      code: 'ECONNRESET',
    });
  });

  it('keeps numeric error codes and redacts causes recursively; drops stacks', () => {
    const cause = new Error(`inner ${LARK_HOOK}`);
    const err = Object.assign(new Error('outer', { cause }), { code: 42 });
    const out = redact(err) as Record<string, unknown>;
    expect(out.code).toBe(42);
    expect(out.cause).toEqual({ name: 'Error', message: `inner https://open.larksuite.com/${REDACTED}` });
    expect(JSON.stringify(out)).not.toContain('stack');
  });

  it('ignores non-primitive error codes', () => {
    const err = Object.assign(new Error('x'), { code: { nested: true } });
    expect(redact(err)).toEqual({ name: 'Error', message: 'x' });
  });

  it('redact_never_emits_a_secret_prefix', () => {
    const inputs: unknown[] = [
      { password: SECRET },
      { sign: SECRET },
      [`Bearer ${SECRET}`],
      `token=${SECRET}`,
      new Map([['secret', SECRET]]),
      { list: [{ key: SECRET }] },
      `{"client_secret":"${SECRET}"}`,
    ];
    inputs.forEach((input) => expectNoFragment(redact(input), SECRET));
  });

  it('handles primitives and special objects', () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeNull();
    expect(redact(true)).toBe(true);
    expect(redact(3.5)).toBe(3.5);
    expect(redact(Number.NaN)).toBe('NaN');
    expect(redact(Infinity)).toBe('Infinity');
    expect(redact(10n)).toBe('10');
    expect(redact(Symbol('s'))).toBe('[symbol]');
    expect(redact(() => 1)).toBe('[function]');
    expect(redact(new Date(0))).toBe('1970-01-01T00:00:00.000Z');
    expect(redact(new Date(Number.NaN))).toBe('[invalid-date]');
    expect(redact(new URL(SLACK_HOOK))).toBe(`https://hooks.slack.com/${REDACTED}`);
    expect(redact(new Uint8Array(4))).toBe('[binary 4 bytes]');
    expect(redact(new ArrayBuffer(2))).toBe('[binary 2 bytes]');
    expect(redact(new Set(['a', 1]))).toEqual(['a', 1]);
    expect(redact([undefined])).toEqual([null]);
  });

  it('redacts Headers and Map entries by key and scrubs keys themselves', () => {
    const headers = new Headers({ Authorization: `Bearer ${SECRET}`, 'X-Request-Id': 'r1' });
    expect(redact(headers)).toEqual({ authorization: REDACTED, 'x-request-id': 'r1' });
    const byUrl = new Map([[SLACK_HOOK, 'ok']]);
    expect(redact(byUrl)).toEqual({ [`https://hooks.slack.com/${REDACTED}`]: 'ok' });
  });

  it('handles cycles without losing siblings', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    a.child = { parent: a };
    expect(redact(a)).toEqual({ name: 'a', self: '[circular]', child: { parent: '[circular]' } });
  });

  it('does not mistake a repeated (non-cyclic) reference for a cycle', () => {
    const shared = { v: 1 };
    expect(redact({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });

  it('enforces the depth limit', () => {
    expect(redact({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({ a: { b: '[max-depth]' } });
  });

  it('enforces breadth limits on arrays and objects', () => {
    expect(redact([1, 2, 3, 4], { maxEntries: 2 })).toEqual([1, 2, '[2 more items]']);
    expect(redact({ a: 1, b: 2, c: 3 }, { maxEntries: 2 })).toEqual({
      a: 1,
      b: 2,
      '[truncated]': '1 more keys',
    });
  });

  it('drops a field whose getter throws instead of the whole line', () => {
    const hostile = {
      ok: 1,
      get boom(): never {
        throw new Error('nope');
      },
    };
    expect(redact(hostile)).toEqual({ ok: 1 });
  });

  it('never throws, even when the error itself is hostile', () => {
    const err = new Error('x');
    Object.defineProperty(err, 'name', {
      get(): never {
        throw new Error('nope');
      },
    });
    expect(redact(err)).toBe('[unredactable]');
  });

  it('log_output_contains_no_denylisted_key value (synthetic provider responses)', () => {
    const responses = [
      { ok: false, error: 'invalid_token', response_metadata: { access_token: SECRET } },
      { code: 19021, msg: 'sign match fail', data: { sign: SECRET, timestamp: '1' } },
      { message: 'Unknown Webhook', webhook: { url: SLACK_HOOK, token: SECRET } },
      { errors: [{ detail: `Header Authorization: Bearer ${SECRET}` }] },
    ];
    responses.forEach((r) => expectNoFragment(redact(r), SECRET));
  });
});
