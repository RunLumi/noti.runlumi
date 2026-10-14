import { beforeEach, describe, expect, it } from 'vitest';
import { createAuthHarness, ORIGIN, type AuthHarness } from './harness';
import { createSoftPasskey, type SoftPasskey } from './webauthn';

/**
 * Spec 02 F19. The passkey sign-in ceremony is run for real against the deployed configuration with a
 * software authenticator (`webauthn.ts`), so the signature, challenge, origin, relying-party and
 * counter checks are the library's own. What this does NOT prove: any browser or hardware behaviour.
 */
const RP_ID = new URL(ORIGIN).hostname;
let h: AuthHarness;
let key: SoftPasskey;
let userId: string;

function addPasskey(user: string, counter: number, passkey: SoftPasskey = key): void {
  h.db.raw
    .prepare(
      `INSERT INTO passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      `pk-${passkey.credentialId}`,
      'Laptop',
      passkey.publicKeyB64,
      user,
      passkey.credentialId,
      counter,
      'singleDevice',
      0,
      1,
    );
}

const storedCounter = (): number =>
  Number(
    (
      h.db.raw.prepare('SELECT counter FROM passkey WHERE credential_id=?').get(key.credentialId) as {
        counter: number;
      }
    ).counter,
  );
const sessions = (): number =>
  Number((h.db.raw.prepare('SELECT COUNT(*) AS n FROM "session"').get() as { n: number }).n);

/** Ask for a challenge, answer it with `counter`, post the answer. */
async function signInWithPasskey(
  counter: number,
  options: { origin?: string; rpId?: string; passkey?: SoftPasskey; ip?: string } = {},
): Promise<Response> {
  const ip = options.ip ?? '192.0.2.1';
  const opts = await h.call('/passkey/generate-authenticate-options', { ip });
  const { challenge } = await opts.json<{ challenge: string }>();
  const assertion = (options.passkey ?? key).assert({
    challenge,
    origin: options.origin ?? ORIGIN,
    rpId: options.rpId ?? RP_ID,
    counter,
  });
  return h.call('/passkey/verify-authentication', {
    body: { response: assertion },
    cookie: h.allCookies(opts),
    ip,
  });
}

beforeEach(async () => {
  h = createAuthHarness();
  await h.register('pk@example.test', { ip: '10.9.0.1' });
  userId = (h.db.raw.prepare(`SELECT id FROM "user"`).get() as { id: string }).id;
  key = createSoftPasskey('credential-one');
  addPasskey(userId, 5);
});

describe('passkey sign-in', () => {
  it('signs in with a valid assertion and stores the new counter', async () => {
    const before = sessions();
    const res = await signInWithPasskey(6);
    expect(res.status).toBe(200);
    expect(h.cookieOf(res)).toContain('session_token');
    expect(sessions()).toBe(before + 1);
    expect(storedCounter()).toBe(6);
  });

  it('refuses a counter that does not advance (a replayed or cloned authenticator) and keeps the old counter', async () => {
    expect((await signInWithPasskey(6)).status).toBe(200);
    const before = sessions();
    const same = await signInWithPasskey(6, { ip: '192.0.2.2' });
    expect(same.status).toBeGreaterThanOrEqual(400);
    const behind = await signInWithPasskey(3, { ip: '192.0.2.3' });
    expect(behind.status).toBeGreaterThanOrEqual(400);
    expect(h.cookieOf(behind)).toBe('');
    expect(sessions()).toBe(before);
    expect(storedCounter()).toBe(6);
  });

  it('accepts authenticators that never count (stored 0, presented 0), as synced passkeys do', async () => {
    h.db.raw.prepare('UPDATE passkey SET counter=0').run();
    expect((await signInWithPasskey(0)).status).toBe(200);
    expect(storedCounter()).toBe(0);
  });

  it('a challenge answers one ceremony only', async () => {
    const ip = '192.0.2.4';
    const opts = await h.call('/passkey/generate-authenticate-options', { ip });
    const { challenge } = await opts.json<{ challenge: string }>();
    const assertion = key.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 7 });
    const post = () =>
      h.call('/passkey/verify-authentication', {
        body: { response: assertion },
        cookie: h.allCookies(opts),
        ip,
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an assertion made for another origin or another relying party', async () => {
    expect(
      (await signInWithPasskey(7, { origin: 'https://evil.test', ip: '192.0.2.5' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await signInWithPasskey(7, { rpId: 'evil.test', ip: '192.0.2.6' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(storedCounter()).toBe(5);
  });

  it('refuses a signature made by a different key under a known credential id', async () => {
    const impostor = createSoftPasskey('credential-one');
    const res = await signInWithPasskey(9, { passkey: impostor, ip: '192.0.2.7' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(storedCounter()).toBe(5);
  });

  it('refuses an unknown credential', async () => {
    const stranger = createSoftPasskey('never-registered');
    expect(
      (await signInWithPasskey(1, { passkey: stranger, ip: '192.0.2.8' })).status,
    ).toBeGreaterThanOrEqual(400);
  });
});

describe('a passkey is not proof of ownership of an email address (F19)', () => {
  it('a passkey on an account whose email was never verified yields no session', async () => {
    // How such a row could exist: it should not (registering needs a session, which needs a verified
    // email), so the row is inserted directly. The point is the second line of defence.
    h.db.raw.prepare('UPDATE "user" SET email_verified=0').run();
    h.db.raw.prepare('DELETE FROM "session"').run();
    const res = await signInWithPasskey(6, { ip: '192.0.2.9' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.cookieOf(res)).toBe('');
    expect(sessions()).toBe(0);
  });
});
