import { createHmac, randomBytes } from 'node:crypto';
import { expect } from 'vitest';
import { caller, signHeaders, type Harness } from './harness';

/**
 * Helpers for the GitLab and Stripe source tests. Secrets are generated at run time (nothing
 * secret-shaped is committed), and every signature is produced by node:crypto, independently
 * of the code under test.
 */
export const WHSEC = 'whsec' + '_';

/** A GitLab signing token: whsec_ + base64 of 32 random bytes. */
export const newSigningToken = (): string => WHSEC + Buffer.from(randomBytes(32)).toString('base64');
/** A GitLab secret token the person typed. */
export const newSecretToken = (): string => 'tok-' + Buffer.from(randomBytes(12)).toString('hex');
/** A Stripe endpoint secret: whsec_ + 64 hex characters (the shape `stripe listen` prints). */
export const newStripeSecret = (): string => WHSEC + Buffer.from(randomBytes(32)).toString('hex');

/** Standard Webhooks headers as GitLab sends them (key = base64-decoded part of the token). */
export const gitlabSignHeaders = (token: string, body: string, options: { id?: string; ts?: number } = {}) =>
  signHeaders(token, body, options);

/** `Stripe-Signature` per docs.stripe.com/webhooks: HMAC-SHA256 hex over `t.body`, key = the secret string. */
export function stripeSignature(
  secret: string,
  body: string,
  options: { ts?: number; extraSecrets?: string[]; decoyV0?: boolean } = {},
): string {
  const t = options.ts ?? Math.floor(Date.now() / 1000);
  const mac = (s: string) => createHmac('sha256', s).update(`${t}.${body}`).digest('hex');
  const parts = [`t=${t}`, `v1=${mac(secret)}`];
  for (const extra of options.extraSecrets ?? []) parts.push(`v1=${mac(extra)}`);
  if (options.decoyV0) parts.push(`v0=${'6f'.repeat(32)}`);
  return parts.join(',');
}

export interface ProviderSource {
  id: string;
  endpointId: string;
  endpointUrl: string;
  secret: string;
}

export function providerHelpers(worker: Parameters<typeof caller>[0], h: () => Harness) {
  const call = caller(worker, h);

  async function createProviderSource(
    kind: 'gitlab' | 'stripe',
    secret: string,
    extra: Record<string, unknown> = {},
    as = 'alice',
  ): Promise<ProviderSource> {
    const res = await call('POST', '/api/sources', {
      as,
      body: { name: `${kind} source`, kind, secret, ...extra },
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ source: { id: string; endpointId: string; endpointUrl: string } }>();
    return { ...body.source, secret };
  }

  async function postTo(
    path: string,
    body: string | Uint8Array,
    headers: Record<string, string>,
    contentType: string | null = 'application/json',
  ): Promise<Response> {
    const all = new Headers(headers);
    if (contentType !== null) all.set('content-type', contentType);
    return worker.fetch(
      new Request(`https://noti.test${path}`, {
        method: 'POST',
        headers: all,
        body: typeof body === 'string' ? body : body.slice().buffer,
      }),
      h().env,
      { waitUntil: h().waitUntil, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
  }

  return { call, createProviderSource, postTo };
}
