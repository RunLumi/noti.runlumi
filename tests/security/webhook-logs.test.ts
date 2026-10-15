import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/connectors/sources/github/route';
import { createRig } from '../conformance/rig';
import { loadFixtureJson, loadManifest } from '../fixtures/load';
import { captureConsole, Planted } from '../support/log-capture';

vi.mock('../../src/auth/better-auth', async () => (await import('../sources/harness')).mockAuth());
const { default: worker } = await import('../../src/index');

/**
 * F234 and spec 15 F12 for the webhook path: a delivery whose signature is refused, and one that is
 * accepted, write nothing to the console that carries the webhook secret, the signature the sender
 * presented, or a hash prefix of either. The refusal is the path that logs, so it is the one that
 * matters: a secret echoed into a rejection line would leak to anyone who reads the logs.
 */

const entry = loadManifest().find((m) => m.id === 'github/pull_request.opened');
if (!entry) throw new Error('fixture github/pull_request.opened is missing');

let capture: ReturnType<typeof captureConsole>;

beforeEach(() => {
  capture = captureConsole();
});

afterEach(() => {
  capture.restore();
});

describe('webhook refusal and acceptance write no secret to the console (F12, F234)', () => {
  it('a delivery signed with the wrong key is refused, and neither the secret nor the presented signature is logged', async () => {
    const rig = await createRig('github', worker);
    const secret = rig.h.env.GITHUB_WEBHOOK_SECRET ?? '';
    expect(secret.length).toBeGreaterThanOrEqual(16);

    const body = rig.encode(loadFixtureJson(entry));
    // The sender signed with a key that is not ours. The header value is planted so the test can look for it.
    const presented = `sha256=${createHmac('sha256', 'a-key-that-is-not-the-secret').update(body).digest('hex')}`;
    const planted = new Planted();
    planted.add('webhook secret', secret);
    planted.add('presented signature', presented);
    planted.add('presented signature digest', presented.slice('sha256='.length));

    const res = await rig.post(body, {
      signature: 'none',
      headers: { ...entry.headers, 'x-hub-signature-256': presented },
    });
    expect(res.status).toBe(401);
    expect(rig.count('deliveries')).toBe(0);

    // A delivery with no signature at all is refused the same way.
    const unsigned = await rig.post(body, { signature: 'none', headers: { ...entry.headers } });
    expect(unsigned.status).toBe(401);

    // Control: the capture is live (the planted values must be absent from everything written).
    console.info('control-line-for-webhook-capture');
    const text = capture.lines.join('\n');
    expect(text).toContain('control-line-for-webhook-capture');
    expect(planted.leaked(text)).toEqual([]);
  });

  it('an oversized delivery is refused with a line that names the cap and nothing from the request', async () => {
    const rig = await createRig('github', worker);
    const secret = rig.h.env.GITHUB_WEBHOOK_SECRET ?? '';
    const presented = `sha256=${createHmac('sha256', 'another-key').update('x').digest('hex')}`;
    const planted = new Planted();
    planted.add('webhook secret', secret);
    planted.add('presented signature', presented);

    // The one webhook-side line the route writes (sampled, and only once per isolate): it must appear, and
    // it must not carry the body, the header or the secret.
    const res = await rig.post('x'.repeat(MAX_BODY_BYTES + 1), {
      signature: 'none',
      headers: { ...entry.headers, 'x-hub-signature-256': presented },
    });
    expect(res.status).toBe(413);
    const text = capture.lines.join('\n');
    expect(text).toContain('github_event_too_large');
    expect(planted.leaked(text)).toEqual([]);
  });

  it('an accepted delivery writes no secret either', async () => {
    const rig = await createRig('github', worker);
    const secret = rig.h.env.GITHUB_WEBHOOK_SECRET ?? '';
    const planted = new Planted();
    planted.add('webhook secret', secret);

    const res = await rig.post(rig.encode(loadFixtureJson(entry)), { headers: entry.headers });
    expect(res.status).toBe(202);

    const text = capture.lines.join('\n');
    expect(planted.leaked(text)).toEqual([]);
    // The matcher itself finds the value when it is present.
    expect(planted.leaked(`echoed ${secret}`)).toContain('webhook secret');
  });
});
