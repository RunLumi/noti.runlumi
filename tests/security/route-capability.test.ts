import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { DOMAIN_CAPABILITIES } from '../../src/auth/permissions';
import { MIDDLEWARE_PATHS, ROUTE_POLICY, type RoutePolicy } from '../../src/auth/route-policy';
import { listTsFiles } from '../support/sql-scope';
import { must } from '../support/must';

/**
 * F232: every route the Worker registers maps to a decision, and the handler really contains
 * the guard the decision claims. Two independent enumerations are compared:
 *
 *  1. RUNTIME: `app.routes` of the real Hono app (what is actually reachable);
 *  2. SOURCE: every `<router>.<method>('/path', handler)` registration found by parsing `src/`.
 *
 * Both must equal `ROUTE_POLICY` (src/auth/route-policy.ts). A new route therefore fails this
 * file until someone writes down how it is guarded. LIMITS: the guard is checked by what the
 * handler's own source (or the function it names) contains, not by executing it, so a gate that is
 * present but wrongly ordered is out of its reach; the cross-workspace tests and the isolation
 * drill (tests/drill) exercise behaviour. A route registered with a computed path that is not a
 * literal is only seen by the runtime enumeration, which is why both exist.
 */
vi.mock('../../src/auth/better-auth', () => ({
  createAuth: () => ({ api: {}, handler: () => new Response(null) }),
}));

const { app } = await import('../../src/index');
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const GUARD_CALLS = new Set(['gate', 'mutationGate', 'authorize']);
const SESSION_CALLS = new Set(['current', 'currentSession']);
const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all']);

interface Registration {
  readonly file: string;
  readonly method: string;
  readonly local: string;
  readonly handler: ts.Node | null;
  readonly source: ts.SourceFile;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
}

function registrations(file: string): Registration[] {
  const source = parse(file);
  const out: Registration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      METHODS.has(node.expression.name.text)
    ) {
      const [path, ...rest] = node.arguments;
      if (
        path &&
        (ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path)) &&
        path.text.startsWith('/')
      ) {
        out.push({
          file,
          method: node.expression.name.text.toUpperCase(),
          local: path.text,
          handler: rest.at(-1) ?? null,
          source,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** The function a registration points at: an inline function, or a named one in the same file. */
function resolveHandler(handler: ts.Node | null, source: ts.SourceFile): ts.Node | null {
  if (!handler) return null;
  if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) return handler;
  if (ts.isIdentifier(handler)) return findNamed(source, handler.text);
  return null;
}

function findNamed(source: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node;
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

interface Calls {
  /** callee identifier -> the string-literal arguments it was called with */
  readonly names: Map<string, string[][]>;
  readonly text: string;
}

function calls(node: ts.Node, source: ts.SourceFile): Calls {
  const names = new Map<string, string[][]>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression)
        ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name.text
          : null;
      if (callee) {
        const literals = n.arguments.map((a) => (ts.isStringLiteral(a) ? a.text : ''));
        names.set(callee, [...(names.get(callee) ?? []), literals]);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { names, text: node.getText(source) };
}

function handlerFor(policy: RoutePolicy): { node: ts.Node; source: ts.SourceFile } | null {
  if ('name' in policy.handler) {
    const source = parse(policy.file);
    const node = findNamed(source, policy.handler.name);
    return node ? { node, source } : null;
  }
  const { local } = policy.handler;
  const reg = registrations(policy.file).find((r) => r.method === policy.method && r.local === local);
  if (!reg) return null;
  const node = resolveHandler(reg.handler, reg.source);
  return node ? { node, source: reg.source } : null;
}

const key = (method: string, path: string): string => `${method} ${path}`;

describe('route policy matches the routes the app registers (F232)', () => {
  const runtime = (app.routes as readonly { method: string; path: string }[]).filter(
    (r) => !(r.method === 'ALL' && MIDDLEWARE_PATHS.includes(r.path)),
  );

  it('registers the global middleware first: correlation, security headers, same-origin check', () => {
    const middleware = (app.routes as readonly { method: string; path: string }[]).filter(
      (r) => r.method === 'ALL' && MIDDLEWARE_PATHS.includes(r.path),
    );
    expect(middleware.map((m) => m.path)).toEqual(['/*', '/*', '/*', '/api/*', '/*']);
  });

  it('has a policy for every registered route, and no policy for a route that is not registered', () => {
    const registered = new Set(runtime.map((r) => key(r.method, r.path)));
    const listed = new Set(ROUTE_POLICY.map((p) => key(p.method, p.path)));
    expect(
      [...registered].filter((k) => !listed.has(k)),
      'registered but not in ROUTE_POLICY (src/auth/route-policy.ts): decide how it is guarded',
    ).toEqual([]);
    expect(
      [...listed].filter((k) => !registered.has(k)),
      'in ROUTE_POLICY but not registered by the app',
    ).toEqual([]);
    expect(listed.size, 'duplicate policy entries').toBe(ROUTE_POLICY.length);
  });

  it('finds every literal route registration in src/ in the policy, so none hides behind a mount', () => {
    const files = listTsFiles(join(root, 'src')).map((f) => f.slice(root.length + 1));
    const found = files.flatMap((f) => registrations(f));
    expect(found.length).toBeGreaterThanOrEqual(35);
    const missing = found.filter(
      (r) =>
        !ROUTE_POLICY.some(
          (p) =>
            p.method === r.method &&
            ((p.file === r.file && 'local' in p.handler && p.handler.local === r.local) ||
              // The root app has no mount prefix, so its registrations are full paths.
              (r.file === 'src/index.ts' && p.path === r.local)),
        ),
    );
    expect(missing.map((r) => `${r.file}: ${r.method} ${r.local}`)).toEqual([]);
  });
});

/** The statements of a handler's body (an inline function, or a named function declaration). */
function bodyStatements(node: ts.Node): readonly ts.Statement[] | null {
  const fn = ts.isVariableDeclaration(node) ? node.initializer : node;
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)))
    return null;
  return fn.body && ts.isBlock(fn.body) ? fn.body.statements : null;
}

/** `await f(...)` / `f(...)` as the initializer of a declaration or as an expression statement. */
function topLevelCall(statement: ts.Statement): ts.CallExpression | null {
  let expr: ts.Expression | undefined;
  if (ts.isVariableStatement(statement)) expr = statement.declarationList.declarations[0]?.initializer;
  else if (ts.isExpressionStatement(statement)) expr = statement.expression;
  while (expr && (ts.isAwaitExpression(expr) || ts.isParenthesizedExpression(expr))) expr = expr.expression;
  return expr && ts.isCallExpression(expr) ? expr : null;
}

const DB_USE = /\.prepare\(|\.batch\(|\.exec\(|\bDB\b/;

/**
 * The guard must be an UNCONDITIONAL top-level statement of the handler, and nothing before it may
 * touch the database. A guard inside an `if`, a callback or after a read is not a guard.
 */
function orderingProblem(
  node: ts.Node,
  source: ts.SourceFile,
  isGuard: (call: ts.CallExpression) => boolean,
  what: string,
): string | null {
  const statements = bodyStatements(node);
  if (!statements) return 'handler body is not a block of statements this check can read';
  const at = statements.findIndex((st) => {
    const call = topLevelCall(st);
    return call !== null && isGuard(call);
  });
  if (at < 0) return `${what} must be an unconditional top-level statement of the handler`;
  const early = statements.slice(0, at).find((st) => DB_USE.test(st.getText(source)));
  return early
    ? `the handler touches the database before ${what}: ${early.getText(source).slice(0, 60)}`
    : null;
}

function calleeName(call: ts.CallExpression): string | null {
  if (ts.isIdentifier(call.expression)) return call.expression.text;
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;
}

/** Why the handler does not contain the guard its policy claims, or null when it does. */
function guardProblem(policy: RoutePolicy): string | null {
  const located = handlerFor(policy);
  if (!located) return `${policy.file}: no handler found for ${JSON.stringify(policy.handler)}`;
  const { node, source } = located;
  const c = calls(node, source);
  const access = policy.access;
  switch (access.kind) {
    case 'capability':
      return orderingProblem(
        node,
        source,
        (call) => {
          const name = calleeName(call);
          const arg = call.arguments[1];
          return (
            !!name &&
            GUARD_CALLS.has(name) &&
            !!arg &&
            ts.isStringLiteral(arg) &&
            arg.text === access.capability
          );
        },
        `gate/mutationGate/authorize with '${access.capability}'`,
      );
    case 'member':
      return orderingProblem(
        node,
        source,
        (call) => calleeName(call) === 'resolveWorkspace',
        'resolving the workspace membership',
      );
    case 'self':
    case 'session':
      return orderingProblem(
        node,
        source,
        (call) => SESSION_CALLS.has(calleeName(call) ?? '') || calleeName(call) === 'resolveWorkspace',
        'reading the session',
      );
    case 'signed-webhook':
      // A call in the handler's own code, never a mention in a comment or a string.
      return c.names.has(access.verifiedBy) ? null : `handler must call ${access.verifiedBy}(...)`;
    case 'auth-handler':
      return c.names.has('handler') ? null : 'handler must hand the request to Better Auth';
    case 'public':
      return access.reason.length >= 30 ? null : 'a public route needs a real reason';
  }
}

describe('every route has the guard its policy claims (F232)', () => {
  it.each(ROUTE_POLICY.map((p) => [key(p.method, p.path), p] as const))('%s', (_name, policy) => {
    expect(guardProblem(policy)).toBeNull();
  });

  it('notices a handler that lacks the guard its policy claims', () => {
    const real = must(ROUTE_POLICY.find((p) => p.path === '/api/sources/:id/rotate'));
    expect(guardProblem(real)).toBeNull();
    // Claim a capability the handler never checks, or a guard kind it never uses.
    expect(guardProblem({ ...real, access: { kind: 'capability', capability: 'source.read' } })).toMatch(
      /gate\/mutationGate\/authorize/,
    );
    expect(guardProblem({ ...real, access: { kind: 'session' } })).toMatch(/reading the session/);
    expect(guardProblem({ ...real, access: { kind: 'member' } })).toMatch(
      /resolving the workspace membership/,
    );
    expect(guardProblem({ ...real, handler: { local: '/does-not-exist' } })).toMatch(/no handler found/);
    const health = must(ROUTE_POLICY.find((p) => p.path === '/health'));
    expect(guardProblem({ ...health, access: { kind: 'capability', capability: 'audit.read' } })).toMatch(
      /gate\/mutationGate\/authorize/,
    );
  });

  describe('the guard must be unconditional, first, and before any database use', () => {
    const problem = (body: string): string | null => {
      const source = ts.createSourceFile(
        'x.ts',
        `const h = async (c) => {\n${body}\n};`,
        ts.ScriptTarget.Latest,
        true,
      );
      const node = must(findNamed(source, 'h'));
      return orderingProblem(
        node,
        source,
        (call) => calleeName(call) === 'gate' && ts.isStringLiteral(must(call.arguments[1])),
        'gate',
      );
    };
    it('accepts a leading guard, with origin checks that do not touch the database before it', () => {
      expect(
        problem(
          "const o = c.req.header('origin'); if (!o) return 1; const who = await gate(c, 'a.b'); c.env.DB.prepare('x');",
        ),
      ).toBeNull();
      expect(problem("await gate(c, 'a.b'); c.env.DB.prepare('x');")).toBeNull();
    });
    it('rejects a guard inside a condition, a callback or a ternary', () => {
      expect(problem("if (x) { await gate(c, 'a.b'); } c.env.DB.prepare('x');")).toMatch(
        /unconditional top-level/,
      );
      expect(problem("items.forEach(async () => { await gate(c, 'a.b'); });")).toMatch(
        /unconditional top-level/,
      );
      expect(problem("const who = x ? await gate(c, 'a.b') : null;")).toMatch(/unconditional top-level/);
    });
    it('rejects a read that runs before the guard', () => {
      expect(
        problem("const row = await c.env.DB.prepare('x').first(); const who = await gate(c, 'a.b');"),
      ).toMatch(/touches the database before/);
      expect(problem("const r = await hit(c.env.DB, 'k'); await gate(c, 'a.b');")).toMatch(
        /touches the database before/,
      );
    });
    it('does not accept a verification that is only mentioned in a comment', () => {
      const source = ts.createSourceFile(
        'w.ts',
        'async function hook(c) { // verifyGithubSignature(body)\n  return 1; }',
        ts.ScriptTarget.Latest,
        true,
      );
      expect(calls(must(findNamed(source, 'hook')), source).names.has('verifyGithubSignature')).toBe(false);
    });
  });

  it('keeps the public list tiny and explicit', () => {
    const publicRoutes = ROUTE_POLICY.filter((p) => p.access.kind === 'public').map((p) =>
      key(p.method, p.path),
    );
    expect(publicRoutes).toEqual(['GET /health', 'GET /health/ready']);
  });

  it('never leaves a state-changing route open: it is a capability, a session flow, a signed webhook or Better Auth', () => {
    const mutating = ROUTE_POLICY.filter((p) => ['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(p.method));
    for (const p of mutating) {
      expect(
        ['capability', 'session', 'self', 'signed-webhook', 'auth-handler'],
        key(p.method, p.path),
      ).toContain(p.access.kind);
    }
  });

  it('enforces every domain capability on at least one route, and names none that does not exist', () => {
    const used = new Set(
      ROUTE_POLICY.flatMap((p) => (p.access.kind === 'capability' ? [p.access.capability] : [])),
    );
    for (const capability of DOMAIN_CAPABILITIES) {
      // `source.*`, `delivery.*`, `audit.read`, `workspace.*`, `integration.*` are all routed today.
      expect(used.has(capability), `${capability} is defined but no route requires it`).toBe(true);
    }
    for (const capability of used) expect(DOMAIN_CAPABILITIES).toContain(capability);
  });
});
