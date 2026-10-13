import { describe, it, expect } from 'vitest';
import { classifyGithubEvent, verifyGithubSignature } from '../src/connectors/sources/github/events';

/** Verbatim from GitHub's webhook validation documentation. Do not regenerate. */
const GITHUB_KNOWN_ANSWER = {
  secret: "It's a Secret to Everybody",
  signature: 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
} as const;

describe('GitHub source', () => {
  it('distinguishes merged and closed PRs', () => {
    expect(classifyGithubEvent('pull_request', { action: 'closed', pull_request: { merged: true } })).toBe(
      'pull_request.merged',
    );
    expect(classifyGithubEvent('pull_request', { action: 'closed', pull_request: { merged: false } })).toBe(
      'pull_request.closed',
    );
  });
  it('classifies completed workflow by conclusion', () => {
    expect(
      classifyGithubEvent('workflow_run', { action: 'completed', workflow_run: { conclusion: 'failure' } }),
    ).toBe('workflow_run.failure');
  });
  it('rejects malformed signatures', async () => {
    expect(await verifyGithubSignature('{}', 'sha256=abc', 'secret')).toBe(false);
  });
  it('accepts valid HMAC and rejects modified body', async () => {
    const body = '{"repository":{"full_name":"example/repo"}}',
      secret = 'top-secret';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
    const signature = 'sha256=' + [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(await verifyGithubSignature(body, signature, secret)).toBe(true);
    expect(await verifyGithubSignature(body + ' ', signature, secret)).toBe(false);
  });

  // Known-answer vector taken verbatim from GitHub's own documentation
  // (docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
  // If this fails, our HMAC or hex encoding is wrong — do not "fix" it by regenerating
  // the expected value.
  it('matches the documented GitHub known-answer vector', async () => {
    expect(
      await verifyGithubSignature('Hello, World!', GITHUB_KNOWN_ANSWER.signature, GITHUB_KNOWN_ANSWER.secret),
    ).toBe(true);
  });

  it('rejects a signature computed with a different secret', async () => {
    expect(await verifyGithubSignature('Hello, World!', GITHUB_KNOWN_ANSWER.signature, 'wrong-secret')).toBe(
      false,
    );
  });

  // The shape guard must run BEFORE verification so digest length can never be used as
  // an oracle, and so a truncated digest cannot reach the comparison.
  it.each([
    ['sha1=', 'sha1=' + 'a'.repeat(40)],
    ['missing algorithm prefix', 'a'.repeat(64)],
    ['too short', 'sha256=' + 'a'.repeat(63)],
    ['too long', 'sha256=' + 'a'.repeat(65)],
    ['non-hex characters', 'sha256=' + 'z'.repeat(64)],
    ['empty', ''],
  ])('rejects a malformed signature header (%s)', async (_label, header) => {
    expect(await verifyGithubSignature('Hello, World!', header, GITHUB_KNOWN_ANSWER.secret)).toBe(false);
  });

  it('rejects an empty secret rather than skipping verification', async () => {
    expect(await verifyGithubSignature('Hello, World!', GITHUB_KNOWN_ANSWER.signature, '')).toBe(false);
  });
});
