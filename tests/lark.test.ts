import { describe, it, expect } from 'vitest';
import {
  larkSignature,
  larkPayload,
  larkCard,
  larkAccepted,
} from '../src/connectors/destinations/lark/webhook';
describe('Lark webhook adapter', () => {
  it('signs deterministically', async () => {
    expect(await larkSignature('secret', 123456)).toBe(await larkSignature('secret', 123456));
    expect(await larkSignature('other', 123456)).not.toBe(await larkSignature('secret', 123456));
  });
  it('omits optional signature', async () => {
    const p = await larkPayload({ title: 'Issue', url: 'https://github.com/example/repo/issues/1' });
    expect(p.sign).toBeUndefined();
  });
  it('includes timestamp and signature when configured', async () => {
    const p = await larkPayload(
      { title: 'Issue', url: 'https://github.com/example/repo/issues/1' },
      'secret',
      123456000,
    );
    expect(p.timestamp).toBe('123456');
    expect(p.sign).toBe(await larkSignature('secret', 123456));
  });
  it('renders a status-aware card', () => {
    const card = larkCard({ title: 'Failed', url: 'https://github.com/example', status: 'failure' });
    expect(card.header?.template).toBe('red');
    // Legacy titles keep their original text: no status prefix.
    expect(card.header?.title.content).toBe('Failed');
  });
  it('routes legacy helpers through DLP masking and the byte budget', async () => {
    const event = {
      title: 'Fix by jane@example.com',
      url: 'https://github.com/example',
      actor: 'call +84 912 345 678',
      repo: 'x'.repeat(200_000),
    };
    const card = JSON.stringify(larkCard(event));
    expect(card).not.toContain('jane@example.com');
    expect(card).not.toContain('912 345');
    const payload = await larkPayload(event, 'secret', 123456000);
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(20_000);
    expect(JSON.stringify(payload)).not.toContain('jane@example.com');
  });
  it('checks Lark response status', () => {
    expect(larkAccepted({ code: 0 })).toBe(true);
    expect(larkAccepted({ code: 19001 })).toBe(false);
    expect(larkAccepted({})).toBe(false);
  });
});
