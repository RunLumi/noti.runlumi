// @vitest-environment jsdom
import '../a11y/testing/environment';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ADMIN } from '../a11y/testing/fixtures';
import { clearRequests, renderApp, requests } from '../a11y/testing/render';
import { setLocale } from '../i18n/locale';

/**
 * Spec 02 F16: the web client never writes an email address to the console or to an analytics or logging
 * call. Two checks:
 *
 *  1. Static: no source file in `web/src` (tests and test fixtures aside) calls `console.*`, a beacon, a
 *     known analytics or error-reporting global, or imports a known analytics or logging package. Read from
 *     the TypeScript syntax tree, so a sample snippet inside a string literal (`sources/snippets.ts`) is not
 *     code and is not flagged. There is no allowlist: the client has no logging call at all, which is the
 *     strongest form of "never logs the address".
 *  2. Behavioural: the sign-in, sign-up and forgot-password forms, typed into and submitted (success and
 *     failure), make no console call and no beacon that contains the address, and never put it in a URL.
 *     The address travels only in the JSON body of Better Auth's own `/api/auth/*` request.
 */

const SRC = join(process.cwd(), 'web', 'src');

const ANALYTICS_GLOBALS = new Set([
  'gtag',
  'dataLayer',
  'ga',
  'posthog',
  'mixpanel',
  'amplitude',
  'analytics',
  'Sentry',
  'DD_RUM',
  'DD_LOGS',
  'datadogRum',
  'datadogLogs',
  'LogRocket',
  'FS',
  'heap',
  'plausible',
  'umami',
  '_paq',
  'clarity',
  'hj',
  'Intercom',
  'reportError',
]);
const ANALYTICS_PACKAGES =
  /^(@sentry\/|posthog|mixpanel|@amplitude\/|amplitude-js|@segment\/|analytics($|-|\/)|@datadog\/|logrocket|@fullstory\/|react-ga|@vercel\/analytics|plausible|@bugsnag\/|rollbar|loglevel|pino|winston|debug$|@microsoft\/applicationinsights)/;

interface LoggingFinding {
  readonly kind: 'console' | 'beacon' | 'analytics-call' | 'analytics-import';
  readonly line: number;
  readonly text: string;
}

/** The root identifier of `a.b.c(...)` (`a`), or of `a(...)`, and the first property after it (`b`). */
function callee(expression: ts.Expression): { root: string | null; first: string | null } {
  let e = expression;
  let first: string | null = null;
  while (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    if (ts.isPropertyAccessExpression(e)) first = e.name.text;
    e = e.expression;
  }
  return { root: ts.isIdentifier(e) ? e.text : null, first };
}

/** Every logging or analytics call and import in `source`, read from its syntax tree. */
function scanLogging(fileName: string, source: string): LoggingFinding[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: LoggingFinding[] = [];
  const add = (kind: LoggingFinding['kind'], node: ts.Node) =>
    findings.push({
      kind,
      line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      text: node.getText(file).slice(0, 80),
    });
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (ANALYTICS_PACKAGES.test(node.moduleSpecifier.text)) add('analytics-import', node);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      // A dynamic import(): the module name is the first argument.
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteral(arg) && ANALYTICS_PACKAGES.test(arg.text)) add('analytics-import', node);
    }
    // Any reference to `console` is flagged, not only calls: `const log = console.log` would hide a call.
    if (ts.isIdentifier(node) && node.text === 'console') add('console', node);
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'sendBeacon') add('beacon', node);
    if (ts.isCallExpression(node)) {
      const { root, first } = callee(node.expression);
      const global = root === 'window' || root === 'globalThis' || root === 'self' ? first : root;
      if (global && ANALYTICS_GLOBALS.has(global)) add('analytics-call', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (path === join(SRC, 'a11y', 'testing')) continue; // test fixtures and the mock server
      out.push(...sourceFiles(path));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('the client source has no logging or analytics call (static)', () => {
  it('finds none in web/src', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50); // the walk reached the application, not an empty folder
    const findings = files.flatMap((path) =>
      scanLogging(path, readFileSync(path, 'utf8')).map(
        (f) => `${relative(SRC, path).split(sep).join('/')}:${f.line} ${f.kind} ${f.text}`,
      ),
    );
    expect(findings).toEqual([]);
  });

  it('the scan reads code, not strings: the sample snippet that mentions console.log is text', () => {
    const snippets = readFileSync(join(SRC, 'sources', 'snippets.ts'), 'utf8');
    expect(snippets).toContain('console.log(');
    expect(scanLogging('snippets.ts', snippets)).toEqual([]);
  });

  it('the scan itself catches what it is meant to (fixtures)', () => {
    const kinds = (code: string) => scanLogging('fixture.tsx', code).map((f) => f.kind);
    expect(kinds('console.log(email);')).toEqual(['console']);
    expect(kinds('const say = console.info; say(email);')).toEqual(['console']);
    expect(kinds('globalThis.console.error({ email });')).toEqual(['console']);
    expect(kinds("navigator.sendBeacon('/t', email);")).toEqual(['beacon']);
    expect(kinds("posthog.capture('signin', { email });")).toEqual(['analytics-call']);
    expect(kinds("window.gtag('event', 'login', { email });")).toEqual(['analytics-call']);
    expect(kinds('window.dataLayer.push({ email });')).toEqual(['analytics-call']);
    expect(kinds("import * as Sentry from '@sentry/react';")).toEqual(['analytics-import']);
    expect(kinds("void import('posthog-js');")).toEqual(['analytics-import']);
    expect(kinds("const label = 'console.log(x)'; const t = `posthog.capture()`;")).toEqual([]);
  });
});

describe('the auth forms never write the address anywhere but the request body (behavioural)', () => {
  const EMAIL = 'ada.private@example.test';
  const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table'] as const;
  let spies: MockInstance[] = [];
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearRequests();
    spies = METHODS.map((m) => vi.spyOn(console, m));
    beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  });
  afterEach(() => {
    cleanup();
    for (const spy of spies) spy.mockRestore();
    setLocale('en', { persist: false });
  });

  /** Fails if any console call, beacon or request URL so far carried the address in any common form. */
  function expectNoAddressLeaked() {
    const forms = [EMAIL, encodeURIComponent(EMAIL), EMAIL.toUpperCase(), EMAIL.split('@')[0] ?? EMAIL];
    const consoleText = spies
      .flatMap((spy) => spy.mock.calls)
      .map((args) =>
        args.map((a) => (typeof a === 'string' ? a : (JSON.stringify(a) ?? String(a)))).join(' '),
      )
      .join('\n');
    for (const form of forms) {
      expect(consoleText, `console carried ${form}`).not.toContain(form);
      expect(requests.join('\n'), `a URL carried ${form}`).not.toContain(form);
    }
    expect(beacon).not.toHaveBeenCalled();
  }

  async function typeCredentials(user: ReturnType<typeof userEvent.setup>, withPassword = true) {
    await user.type(await screen.findByLabelText('Work email', {}, { timeout: 5000 }), EMAIL);
    if (withPassword) await user.type(screen.getByLabelText('Password'), 'correct-horse-battery');
  }

  it('sign-in refused (wrong address or password)', async () => {
    const user = userEvent.setup();
    await renderApp('/signin', { api: { me: 'unauthenticated', signIn: 'invalid' } });
    await typeCredentials(user);
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Invalid email or password', {}, { timeout: 5000 });
    expect(requests).toContain('POST /api/auth/sign-in/email');
    expectNoAddressLeaked();
  });

  it('sign-in accepted, through to the next page', async () => {
    const user = userEvent.setup();
    const app = await renderApp('/signin', { api: { me: 'unauthenticated', signIn: 'ok' } });
    await typeCredentials(user);
    app.api.me = ADMIN;
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(app.router.state.location.pathname).toBe('/'), { timeout: 5000 });
    expectNoAddressLeaked();
  });

  it('sign-up, including the failure of an unreachable server', async () => {
    const user = userEvent.setup();
    await renderApp('/signup', { api: { me: 'unauthenticated', signupMode: 'error' } });
    await user.type(await screen.findByLabelText('Your name', {}, { timeout: 5000 }), 'Ada');
    await typeCredentials(user);
    await user.click(screen.getByRole('button', { name: /Create account/ }));
    await screen.findByText(/Check your email|verification/i, {}, { timeout: 5000 });
    expect(requests).toContain('POST /api/auth/sign-up/email');
    expectNoAddressLeaked();
  });

  it('forgot password (the reset request is not mocked, so it fails)', async () => {
    const user = userEvent.setup();
    await renderApp('/forgot-password', { api: { me: 'unauthenticated' } });
    await typeCredentials(user, false);
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await vi.waitFor(() => expect(requests).toContain('POST /api/auth/request-password-reset'), {
      timeout: 5000,
    });
    await screen.findByRole('button', { name: 'Send reset link' }, { timeout: 5000 });
    expectNoAddressLeaked();
  });
});
