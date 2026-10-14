import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { STRIPE_EVENT_TYPES } from '../../src/connectors/sources/stripe/catalog';
import { formatAmount, mapStripe } from '../../src/connectors/sources/stripe/map';
import {
  STRIPE_TOLERANCE_SECONDS,
  parseStripeSignature,
  verifyStripe,
} from '../../src/connectors/sources/stripe/verify';
import { verifyStandardWebhook } from '../../src/connectors/sources/generic/signature';
import { SOURCE_INGRESS_LIMIT_PER_MINUTE } from '../../src/security/rate-limit';
import type { DeliveryMessage } from '../../src/env';
import { SLACK, keyOf, setup, type Harness } from './harness';
import {
  DISPUTE_CREATED,
  DISPUTE_LOST,
  INVOICE_PAYMENT_FAILED,
  PAYMENT_INTENT_FAILED,
  SETUP_INTENT_CREATED,
  SUBSCRIPTION_CANCEL_AT_END,
  SUBSCRIPTION_CREATED,
  SUBSCRIPTION_DELETED,
  SUBSCRIPTION_METADATA_ONLY,
  SUBSCRIPTION_PAST_DUE,
  THIN_EVENT,
} from './fixtures/stripe';
import { newStripeSecret, providerHelpers, stripeSignature, type ProviderSource } from './provider-harness';

vi.mock('../../src/auth/better-auth', async () => (await import('./harness')).mockAuth());
const { default: worker } = await import('../../src/index');

let h: Harness;
const { call, createProviderSource, postTo } = providerHelpers(worker, () => h);

beforeEach(() => {
  h = setup();
});
afterEach(() => vi.unstubAllGlobals());

const NOW = 1_800_000_000;
const verify = (secret: string, header: string | null, body: string, now = NOW) =>
  verifyStripe({
    secret,
    authMode: null,
    headers: new Headers(header === null ? {} : { 'stripe-signature': header }),
    raw: new TextEncoder().encode(body),
    nowSeconds: now,
  });

describe('Stripe-Signature verification', () => {
  const secret = newStripeSecret();
  const body = JSON.stringify(INVOICE_PAYMENT_FAILED);

  it('verifies HMAC-SHA256 over `t.body` keyed with the secret as a string', async () => {
    expect(await verify(secret, stripeSignature(secret, body, { ts: NOW }), body)).toEqual({
      ok: true,
      eventId: null,
    });
  });

  it('rejects tamper, a wrong secret, a missing or empty header and a JSON round trip', async () => {
    const header = stripeSignature(secret, body, { ts: NOW });
    expect((await verify(secret, header, body + '\n')).ok).toBe(false);
    expect((await verify(newStripeSecret(), header, body)).ok).toBe(false);
    expect((await verify(secret, null, body)).ok).toBe(false);
    expect((await verify(secret, '', body)).ok).toBe(false);
    const reparsed = JSON.stringify(JSON.parse(body), null, 2);
    expect((await verify(secret, header, reparsed)).ok).toBe(false);
  });

  it('ignores the v0 decoy scheme: a header with only v0 is refused', async () => {
    const onlyV0 = `t=${NOW},v0=${createHmac('sha256', secret).update(`${NOW}.${body}`).digest('hex')}`;
    expect((await verify(secret, onlyV0, body)).ok).toBe(false);
    const withDecoy = stripeSignature(secret, body, { ts: NOW, decoyV0: true });
    expect((await verify(secret, withDecoy, body)).ok).toBe(true);
  });

  it('accepts any of several v1 entries (a secret roll) but only valid ones', async () => {
    const old = newStripeSecret();
    const rolled = stripeSignature(old, body, { ts: NOW, extraSecrets: [secret] });
    expect((await verify(secret, rolled, body)).ok).toBe(true);
    expect(
      (await verify(secret, stripeSignature(old, body, { ts: NOW, extraSecrets: [old] }), body)).ok,
    ).toBe(false);
  });

  it('enforces the five minute tolerance in both directions and a numeric timestamp', async () => {
    expect(STRIPE_TOLERANCE_SECONDS).toBe(300);
    const header = stripeSignature(secret, body, { ts: NOW });
    expect((await verify(secret, header, body, NOW + 300)).ok).toBe(true);
    expect(await verify(secret, header, body, NOW + 301)).toEqual({ ok: false, reason: 'stale' });
    expect(await verify(secret, header, body, NOW - 301)).toEqual({ ok: false, reason: 'stale' });
    expect(parseStripeSignature(`t=abc,v1=${'a'.repeat(64)}`)).toBeNull();
    expect(parseStripeSignature(`t=${NOW},v1=short`)).toBeNull();
    expect(parseStripeSignature(`v1=${'a'.repeat(64)}`)).toBeNull();
  });

  it('uses the whsec_ secret as a string, the opposite of Standard Webhooks (same payload, opposite outcomes)', async () => {
    // A Standard Webhooks sender: key = base64-decoded part. A Stripe-style signature is keyed
    // with the string. Each verifier accepts only its own convention.
    const swSecret = 'whsec' + '_' + Buffer.alloc(32, 9).toString('base64');
    const id = 'msg_1';
    const swMac = createHmac('sha256', keyOf(swSecret)).update(`${id}.${NOW}.${body}`).digest('base64');
    const swHeaders = { id, timestamp: String(NOW), signature: `v1,${swMac}` };
    const swKey = new Uint8Array(keyOf(swSecret).buffer.slice(0) as ArrayBuffer);
    expect((await verifyStandardWebhook(swKey, swHeaders, new TextEncoder().encode(body), NOW)).ok).toBe(
      true,
    );
    // The same secret used by the Stripe verifier (as a string) does not verify an SW signature,
    expect(
      (await verify(swSecret, `t=${NOW},v1=${Buffer.from(swMac, 'base64').toString('hex')}`, body)).ok,
    ).toBe(false);
    // and a Stripe signature (string key) is not accepted by the Standard Webhooks verifier.
    const stripeHeader = stripeSignature(swSecret, body, { ts: NOW });
    expect((await verify(swSecret, stripeHeader, body)).ok).toBe(true);
    const stripeMac = Buffer.from(/v1=([0-9a-f]+)/.exec(stripeHeader)?.[1] ?? '', 'hex').toString('base64');
    expect(
      (
        await verifyStandardWebhook(
          swKey,
          { id, timestamp: String(NOW), signature: `v1,${stripeMac}` },
          new TextEncoder().encode(body),
          NOW,
        )
      ).ok,
    ).toBe(false);
  });
});

const map = (event: unknown, livemode: boolean | null = null) =>
  mapStripe({ headers: new Headers(), body: event, source: { livemode } });

describe('amount formatting', () => {
  it.each([
    [2000, 'usd', '20.00 USD'],
    [1099, 'EUR', '10.99 EUR'],
    [500, 'jpy', '500 JPY'],
    [1234, 'kwd', '1.234 KWD'],
    [500, 'isk', '5.00 ISK'],
    [500, 'ugx', '5.00 UGX'],
  ])('%d %s -> %s', (amount, currency, expected) => {
    expect(formatAmount(amount, currency)).toBe(expected);
  });

  it('refuses malformed input; a well-formed unknown code is shown with two decimals', () => {
    expect(formatAmount('2000', 'usd')).toBe('');
    expect(formatAmount(1.5, 'usd')).toBe('');
    expect(formatAmount(100, 'us')).toBe('');
    expect(formatAmount(100, 'usd; drop')).toBe('');
    expect(formatAmount(100, 'zzz')).toBe('1.00 ZZZ');
  });
});

describe('mapping the documented objects', () => {
  it('invoice.payment_failed: amount, number, attempt, retry date, ids; hosted link only', () => {
    expect(map(INVOICE_PAYMENT_FAILED)).toMatchObject({
      outcome: 'deliver',
      eventId: 'evt_1NG8Du2eZvKYlo2CUI79vXWy',
      display: {
        eventType: 'invoice.payment_failed',
        title: 'Invoice payment failed',
        status: 'failure',
        url: 'https://invoice.stripe.com/i/acct_1MtHb/test_YWNjdF8x',
        summary: '20.00 USD · ACME-0042 · attempt 1 · next retry 2023-06-13 · cus_NeZwdNtLEOXuvB',
      },
    });
  });

  it('never puts customer personal data in a notification', () => {
    for (const event of [
      INVOICE_PAYMENT_FAILED,
      PAYMENT_INTENT_FAILED,
      DISPUTE_CREATED,
      SUBSCRIPTION_PAST_DUE,
    ]) {
      const text = JSON.stringify(map(event));
      for (const pii of ['jennyrosen', 'Jenny', '+1555', 'example.com'])
        expect(text, `${pii} in ${event.type}`).not.toContain(pii);
    }
  });

  it('payment_intent.payment_failed', () => {
    expect(map(PAYMENT_INTENT_FAILED)).toMatchObject({
      display: {
        eventType: 'payment_intent.payment_failed',
        title: 'Payment failed',
        summary: '20.00 USD · pi_3MtwBwLkdIwHu7ix28a3tqPa',
      },
    });
  });

  it('disputes: created lists reason and due date, closed maps won/lost/other', () => {
    expect(map(DISPUTE_CREATED)).toMatchObject({
      display: {
        eventType: 'charge.dispute.created',
        title: 'Dispute opened',
        status: 'failure',
        summary: '10.00 USD · reason general · respond by 2023-04-23 · du_1MtJUT2eZvKYlo2CNaw2HvEv',
      },
    });
    expect(map(DISPUTE_LOST)).toMatchObject({ display: { title: 'Dispute lost', status: 'failure' } });
    const won = { ...DISPUTE_LOST, data: { object: { ...DISPUTE_LOST.data.object, status: 'won' } } };
    expect(map(won)).toMatchObject({ display: { title: 'Dispute won', status: 'success' } });
    const closed = {
      ...DISPUTE_LOST,
      data: { object: { ...DISPUTE_LOST.data.object, status: 'warning_closed' } },
    };
    expect(map(closed)).toMatchObject({ display: { title: 'Dispute warning closed', status: 'info' } });
  });

  it('subscriptions: created, deleted, status change, cancel-at-period-end; metadata edits are not notable', () => {
    expect(map(SUBSCRIPTION_CREATED)).toMatchObject({
      display: { title: 'Subscription created', status: 'info' },
    });
    expect(map(SUBSCRIPTION_DELETED)).toMatchObject({
      display: { title: 'Subscription canceled', status: 'warning' },
    });
    expect(map(SUBSCRIPTION_PAST_DUE)).toMatchObject({
      display: {
        title: 'Subscription active → past due',
        status: 'failure',
        summary: 'status past_due · sub_1MowQVLkdIwHu7ixeRlqHVzs · cus_Na6dX7aXxi11N4',
      },
    });
    expect(map(SUBSCRIPTION_CANCEL_AT_END)).toMatchObject({
      display: { title: 'Subscription set to cancel at period end', status: 'warning' },
    });
    expect(map(SUBSCRIPTION_METADATA_ONLY)).toEqual({ outcome: 'ignore', reason: 'update_not_notable' });
  });

  it('every catalogued type is produced by some fixture and nothing outside the catalogue is delivered', () => {
    const events = [
      INVOICE_PAYMENT_FAILED,
      PAYMENT_INTENT_FAILED,
      DISPUTE_CREATED,
      DISPUTE_LOST,
      SUBSCRIPTION_CREATED,
      SUBSCRIPTION_PAST_DUE,
      SUBSCRIPTION_DELETED,
    ];
    const produced = events.map((e) => {
      const r = map(e);
      return r.outcome === 'deliver' ? r.display.eventType : undefined;
    });
    expect(new Set(produced)).toEqual(new Set(STRIPE_EVENT_TYPES));
    expect(map(SETUP_INTENT_CREATED)).toEqual({ outcome: 'ignore', reason: 'event_not_supported' });
  });

  it('thin events, Connect events and the other mode are ignored; malformed events are 400', () => {
    expect(map(THIN_EVENT)).toEqual({ outcome: 'ignore', reason: 'thin_event_not_supported' });
    expect(map({ ...INVOICE_PAYMENT_FAILED, account: 'acct_1' })).toEqual({
      outcome: 'ignore',
      reason: 'connect_event_not_supported',
    });
    // Test event on a live source (and the reverse) is dropped, never rendered.
    expect(map(INVOICE_PAYMENT_FAILED, true)).toEqual({ outcome: 'ignore', reason: 'livemode_mismatch' });
    expect(map({ ...INVOICE_PAYMENT_FAILED, livemode: true }, false)).toEqual({
      outcome: 'ignore',
      reason: 'livemode_mismatch',
    });
    expect(map(INVOICE_PAYMENT_FAILED, false).outcome).toBe('deliver');
    expect(map({ ...INVOICE_PAYMENT_FAILED, id: 'bad id!' })).toMatchObject({
      outcome: 'reject',
      status: 400,
    });
    expect(map({ ...INVOICE_PAYMENT_FAILED, livemode: 'false' })).toMatchObject({
      outcome: 'reject',
      status: 400,
    });
    expect(map([1, 2])).toMatchObject({ outcome: 'reject', status: 400 });
  });

  it('drops a hosted invoice link that is not on stripe.com or not https', () => {
    for (const url of [
      'https://evil.example.com/i/x',
      'http://invoice.stripe.com/i/x',
      'https://stripe.com.evil.io/',
    ]) {
      const e = {
        ...INVOICE_PAYMENT_FAILED,
        data: { object: { ...INVOICE_PAYMENT_FAILED.data.object, hosted_invoice_url: url } },
      };
      expect(map(e)).toMatchObject({ display: { url: '' } });
    }
  });
});

describe('ingress end to end', () => {
  async function connect(src: ProviderSource, eventTypes?: string[]): Promise<string> {
    const res = await call('POST', '/api/integrations', {
      as: 'alice',
      body: {
        name: 'to slack',
        sourceId: src.id,
        destination: 'slack',
        webhookUrl: SLACK,
        ...(eventTypes ? { eventTypes } : {}),
      },
    });
    expect(res.status).toBe(201);
    return (await res.json<{ integration: { id: string } }>()).integration.id;
  }
  const count = (table: string, where = '1=1') =>
    (h.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
  const outbox = () =>
    (
      h.db.raw.prepare('SELECT payload_json FROM notification_outbox').all() as { payload_json: string }[]
    ).map((r) => JSON.parse(r.payload_json) as DeliveryMessage);
  const send = (
    src: ProviderSource,
    event: unknown,
    o: { secret?: string; ts?: number; sign?: boolean } = {},
  ) => {
    const body = JSON.stringify(event);
    return postTo(`/webhooks/stripe/${src.endpointId}`, body, {
      ...(o.sign === false
        ? {}
        : {
            'stripe-signature': stripeSignature(o.secret ?? src.secret, body, {
              ...(o.ts !== undefined ? { ts: o.ts } : {}),
              decoyV0: true,
            }),
          }),
    });
  };

  it('verifies, dedupes by event id and renders the canonical message for a test-mode source', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    const integration = await connect(src);
    const res = await send(src, INVOICE_PAYMENT_FAILED);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, persisted: 1 });
    expect(outbox()).toEqual([
      expect.objectContaining({
        integrationId: integration,
        organizationId: 'org-a',
        eventType: 'invoice.payment_failed',
        status: 'failure',
        title: 'Invoice payment failed',
      }),
    ]);
    expect(JSON.stringify(outbox())).not.toContain('jennyrosen');
  });

  it('a retry has a new signature and timestamp but the same event id: one notification', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connect(src);
    const now = Math.floor(Date.now() / 1000);
    expect((await send(src, INVOICE_PAYMENT_FAILED, { ts: now - 10 })).status).toBe(202);
    const retry = await send(src, INVOICE_PAYMENT_FAILED, { ts: now });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual({ accepted: true, persisted: 0, duplicate: true });
    expect(count('deliveries', "state != 'suppressed'")).toBe(1);
    expect(count('deliveries', "state = 'suppressed'")).toBe(1);
    expect(count('notification_outbox')).toBe(1);
  });

  it('refuses a forged, tampered, stale or unsigned request and never acts on it', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connect(src);
    expect((await send(src, INVOICE_PAYMENT_FAILED, { secret: newStripeSecret() })).status).toBe(401);
    expect((await send(src, INVOICE_PAYMENT_FAILED, { sign: false })).status).toBe(401);
    expect(
      (await send(src, INVOICE_PAYMENT_FAILED, { ts: Math.floor(Date.now() / 1000) - 3600 })).status,
    ).toBe(401);
    const body = JSON.stringify(INVOICE_PAYMENT_FAILED);
    const tampered = await postTo(`/webhooks/stripe/${src.endpointId}`, body.replace('2000', '1'), {
      'stripe-signature': stripeSignature(src.secret, body),
    });
    expect(tampered.status).toBe(401);
    expect(count('deliveries')).toBe(0);
  });

  it('a live event on a test source (and the reverse) is acknowledged with 200 and routed nowhere', async () => {
    const test = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connect(test);
    const res = await send(test, { ...INVOICE_PAYMENT_FAILED, livemode: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true, ignored: 'livemode_mismatch' });
    expect(count('deliveries')).toBe(0);
  });

  it('thin events and unlisted event types are acknowledged and ignored', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connect(src);
    expect(await (await send(src, THIN_EVENT)).json()).toEqual({
      accepted: true,
      ignored: 'thin_event_not_supported',
    });
    expect(await (await send(src, SETUP_INTENT_CREATED)).json()).toEqual({
      accepted: true,
      ignored: 'event_not_supported',
    });
    expect(count('deliveries')).toBe(0);
  });

  it('integrations select event types from the Stripe catalogue', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connect(src, ['charge.dispute.created']);
    expect(await (await send(src, INVOICE_PAYMENT_FAILED)).json()).toEqual({ accepted: true, persisted: 0 });
    expect(await (await send(src, DISPUTE_CREATED)).json()).toEqual({ accepted: true, persisted: 1 });
  });

  it('a flood is answered 429 with Retry-After so Stripe retries', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    await connect(src);
    h.db.raw
      .prepare('INSERT INTO api_rate_limits(key,window_start,count) VALUES(?,?,?)')
      .run(
        `ingress:source:${src.id}`,
        Math.floor(Date.now() / 60_000) * 60_000,
        SOURCE_INGRESS_LIMIT_PER_MINUTE,
      );
    const res = await send(src, INVOICE_PAYMENT_FAILED);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });

  it('test and live endpoints are separate sources with separate secrets', async () => {
    const test = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    const live = await createProviderSource('stripe', newStripeSecret(), { livemode: true });
    await connect(test);
    await connect(live);
    // The test source's secret does not authenticate against the live source's endpoint.
    expect((await send(live, INVOICE_PAYMENT_FAILED, { secret: test.secret })).status).toBe(401);
    expect(count('deliveries')).toBe(0);
    // A test event on its own endpoint delivers to its own chat only.
    expect((await send(test, INVOICE_PAYMENT_FAILED)).status).toBe(202);
    expect(count('deliveries')).toBe(1);
  });

  it('refuses oversize bodies, wrong content types and dead endpoints with identical answers', async () => {
    const src = await createProviderSource('stripe', newStripeSecret(), { livemode: false });
    const body = JSON.stringify(INVOICE_PAYMENT_FAILED);
    const headers = { 'stripe-signature': stripeSignature(src.secret, body) };
    expect(
      (await postTo(`/webhooks/stripe/${src.endpointId}`, 'x'.repeat(512 * 1024 + 1), headers)).status,
    ).toBe(413);
    expect((await postTo(`/webhooks/stripe/${src.endpointId}`, body, headers, 'text/plain')).status).toBe(
      415,
    );
    const dead = await postTo(`/webhooks/stripe/${'B'.repeat(24)}`, body, headers);
    expect(dead.status).toBe(404);
    expect(await dead.text()).toBe('Not found');
  });
});
