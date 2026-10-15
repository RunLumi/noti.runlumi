import { describe, expect, it, vi } from 'vitest';
import { mintHostVerification } from '../../src/connectors/destinations/generic-webhook/verified';
import { sendRequest } from '../../src/connectors/destinations/send';
import type { ClassifiedResponse, OutboundRequest } from '../../src/connectors/destinations/types';

/** sendRequest refuses a customer host without proof of the host check, for exactly that host (review M3). */
const request: OutboundRequest = {
  kind: 'generic_webhook',
  url: 'https://hooks.example.com/noti',
  method: 'POST',
  headers: {},
  body: '{}',
};
const classify = (): ClassifiedResponse => ({ outcome: 'delivered', reason: 'ok' });

describe('sendRequest host verification for generic_webhook', () => {
  it('refuses without a verification, and never calls the network', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const out = await sendRequest(request, classify, { fetch });
    expect(out).toMatchObject({ outcome: 'permanent', reason: 'destination_url_rejected' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a verification minted for another host', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const out = await sendRequest(request, classify, {
      fetch,
      hostVerification: mintHostVerification('other.example.com'),
    });
    expect(out).toMatchObject({ outcome: 'permanent' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends with a verification for this host (case-insensitively)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const out = await sendRequest(request, classify, {
      fetch,
      hostVerification: mintHostVerification('HOOKS.example.com'),
    });
    expect(out.outcome).toBe('delivered');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('other kinds need no verification', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    const out = await sendRequest(
      {
        ...request,
        kind: 'discord',
        url: 'https://discord.com/api/webhooks/123456789012345678/TokenFixture',
      },
      classify,
      { fetch },
    );
    expect(out.outcome).toBe('delivered');
  });
});
