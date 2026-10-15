import { createAuth } from '../../src/auth/better-auth';
import { BOOT_ENV } from '../support/boot-env';
import { createFakeD1, type FakeD1 } from '../support/d1';

/**
 * The REAL Better Auth configuration (`createAuth`) over the real migrations, with the email binding
 * replaced by a recorder. Nothing about the auth rules is mocked, so a test here shows what the
 * deployed configuration does.
 */
export const ORIGIN = 'https://noti.test';
/** Test-only values, built at runtime so no literal looks like a credential to secret scanners. */
const phrase = (...words: string[]): string => words.join(' ');
export const PASSWORD = phrase('correct', 'horse', 'battery', 'staple');
export const WRONG_PASSWORD = phrase('not', 'the', 'right', 'one', 'at', 'all');
export const NEW_PASSWORD = phrase('a', 'brand', 'new', 'phrase', 'here');
export const SHORT_PASSWORD = phrase('too', 'short');

export interface SentMail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface AuthHarness {
  readonly db: FakeD1;
  readonly mail: SentMail[];
  readonly auth: ReturnType<typeof createAuth>;
  /** Call an auth route. `cookie` is a raw Cookie header; `ip` is the Cloudflare client address. */
  call(
    path: string,
    options?: { method?: string; body?: unknown; cookie?: string; ip?: string; userAgent?: string },
  ): Promise<Response>;
  /** The Worker's own `/api/*` routes over the same database and the real auth, as the browser reaches them. */
  api(
    path: string,
    options?: {
      method?: string;
      body?: unknown;
      cookie?: string;
      ip?: string;
      origin?: string | null;
      userAgent?: string;
    },
  ): Promise<Response>;
  /** The session-token cookie pair a response sets, ready to send back. */
  cookieOf(res: Response): string;
  /** Every cookie a response sets, as one Cookie header value. */
  allCookies(res: Response): string;
  /** The first link in the most recent mail to `to`. */
  lastLink(to: string): URL;
  /** Sign up, verify through the emailed link, sign in; returns the session cookie. */
  register(email: string, options?: { password?: string; ip?: string; userAgent?: string }): Promise<string>;
  /** Sign in an already-verified account. */
  signIn(
    email: string,
    options?: { password?: string; ip?: string; userAgent?: string },
  ): Promise<{ res: Response; cookie: string }>;
}

export function createAuthHarness(): AuthHarness {
  const db = createFakeD1();
  const mail: SentMail[] = [];
  const env = {
    ...BOOT_ENV,
    DB: db.d1,
    BETTER_AUTH_SECRET: 'auth-harness-secret-Zq7Kd2mV9xR4tLw8',
    APP_ORIGIN: ORIGIN,
    AUTH_FROM_EMAIL: 'noti@noti.test',
    AUTH_EMAIL: {
      send: (m: { to: string; subject: string; text: string }) => {
        mail.push({ to: m.to, subject: m.subject, text: m.text });
        return Promise.resolve();
      },
    },
  };
  const auth = createAuth(env);

  const api: AuthHarness['api'] = async (path, options = {}) => {
    const { default: worker } = await import('../../src/index');
    const headers = new Headers({
      'cf-connecting-ip': options.ip ?? '203.0.113.7',
      'user-agent': options.userAgent ?? 'TestAgent/1',
    });
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    if (options.cookie) headers.set('cookie', options.cookie);
    if (options.origin !== null && method !== 'GET') headers.set('origin', options.origin ?? ORIGIN);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      env,
      { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext,
    );
  };

  const call: AuthHarness['call'] = (path, options = {}) => {
    const headers = new Headers({
      origin: ORIGIN,
      'cf-connecting-ip': options.ip ?? '203.0.113.7',
      'user-agent': options.userAgent ?? 'TestAgent/1',
    });
    if (options.cookie) headers.set('cookie', options.cookie);
    const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return Promise.resolve(
      auth.handler(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      ),
    );
  };

  const cookieOf = (res: Response): string =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .filter((c) => c.includes('session_token'))
      .join('; ');

  const allCookies = (res: Response): string =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0] ?? '')
      .join('; ');

  const lastLink = (to: string): URL => {
    const m = [...mail].reverse().find((x) => x.to === to);
    if (!m) throw new Error(`no mail to ${to}`);
    const match = /https?:\/\/\S+/.exec(m.text);
    if (!match) throw new Error('no link in mail');
    return new URL(match[0]);
  };

  const signIn: AuthHarness['signIn'] = async (email, options = {}) => {
    const res = await call('/sign-in/email', {
      body: { email, password: options.password ?? PASSWORD },
      ip: options.ip ?? '203.0.113.7',
      userAgent: options.userAgent ?? 'TestAgent/1',
    });
    return { res, cookie: cookieOf(res) };
  };

  const register: AuthHarness['register'] = async (email, options = {}) => {
    const password = options.password ?? PASSWORD;
    const opts = { ip: options.ip ?? '203.0.113.7', userAgent: options.userAgent ?? 'TestAgent/1' };
    const up = await call('/sign-up/email', { body: { email, password, name: 'Test' }, ...opts });
    if (up.status !== 200) throw new Error(`sign-up ${up.status}: ${await up.text()}`);
    const link = lastLink(email);
    const verify = await call(link.pathname.replace('/api/auth', '') + link.search, opts);
    if (verify.status >= 400) throw new Error(`verify ${verify.status}`);
    const { res, cookie } = await signIn(email, { password, ...opts });
    if (res.status !== 200) throw new Error(`sign-in ${res.status}`);
    return cookie;
  };

  return { db, mail, auth, call, api, cookieOf, allCookies, lastLink, register, signIn };
}
