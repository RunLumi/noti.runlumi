import ts from 'typescript';

/**
 * AST scan for outbound network capability in source text (F228). It is a REGRESSION GUARD, not a
 * proof: it parses with the TypeScript compiler so comments, strings, template interpolations and
 * regex literals are handled exactly, but it cannot follow a value through arbitrary aliasing
 * (`const g = self; g.fetch(...)` is not caught; `self.fetch`, `window.fetch`, `globalThis` in any
 * non-property position and every bare `fetch` reference are). Review still matters.
 *
 * What is flagged:
 *  - every `fetch` identifier that is a reference to the global (calls, `const f = fetch`,
 *    `fetch.bind`, `{ fetch }` shorthand, `{ fetch } = globalThis`, `x ? fetch : null`, default
 *    parameter values), anywhere, including a line-start call or a call split across lines;
 *  - `X.fetch` / `X['fetch']` for `globalThis`, `self`, `window`, `global`, and any other
 *    receiver that is not a Cloudflare binding on `env` or one of the in-process receivers listed
 *    in `IN_PROCESS_FETCH_RECEIVERS` (a service or assets binding or a Hono app: not the network);
 *  - `globalThis` used other than as `globalThis.<name other than fetch>`;
 *  - `WebSocket`, `EventSource`, `XMLHttpRequest`, `navigator.sendBeacon`, `eval`, `Function`;
 *  - imports, dynamic imports and `require` of `cloudflare:sockets`, Node network modules and
 *    well-known HTTP client packages; a dynamic import or `require` with a non-literal specifier.
 */

export interface EgressFinding {
  readonly kind: string;
  readonly line: number;
}

/**
 * `X.fetch(...)` receivers that are not the network. Keyed by repository-relative path. A
 * binding on `env` (`env.ASSETS.fetch`, `c.env.SERVICE.fetch`) is exempt in every file.
 */
export const IN_PROCESS_FETCH_RECEIVERS: Readonly<Record<string, readonly string[]>> = {
  // `start` is the TanStack Start server entry, `app` is the Hono app: both run in this isolate.
  'src/worker.ts': ['app', 'start'],
  'src/index.ts': ['app'],
  // `assets` is the ASSETS binding passed in by the caller.
  'src/web/shell.ts': ['assets'],
  // `options.fetch` is the injected test double of `sendRequest`; its default is the one global
  // reference, pinned by tests/security/egress.test.ts.
  'src/connectors/destinations/send.ts': ['options'],
};

const ENV_BINDING_RECEIVER = /^(?:this\.|c\.)?env\.[A-Za-z_][A-Za-z0-9_]*$/;
const GLOBAL_RECEIVERS = new Set(['globalThis', 'self', 'window', 'global']);
const NETWORK_GLOBALS = new Set(['WebSocket', 'EventSource', 'XMLHttpRequest']);
const NETWORK_MODULES =
  /^(?:cloudflare:sockets|(?:node:)?(?:http|https|http2|net|tls|dgram)|undici|node-fetch|cross-fetch|axios|got|ky|superagent)$/;

const DECLARATION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.ExportSpecifier,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.TypeParameter,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.js') || fileName.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parse(source: string, fileName = 'sample.ts'): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

/** The identifier is a name being declared or a property key, not a reference to a value. */
function isNameOnly(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return true;
  if (ts.isQualifiedName(p) && p.right === id) return true;
  if (ts.isBindingElement(p)) return false; // `{ fetch } = x` and `{ fetch: f } = x` both read it
  if (ts.isPropertyAssignment(p) && p.name === id) return true;
  if (DECLARATION_KINDS.has(p.kind) && (p as unknown as { name?: ts.Node }).name === id) return true;
  if (ts.isExportSpecifier(p) || ts.isImportSpecifier(p)) return true;
  return false;
}

function inTypePosition(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isTypeQueryNode(n) || ts.isTypeNode(n)) return true;
    if (ts.isStatement(n) || ts.isBlock(n)) return false;
  }
  return false;
}

function stringValue(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

function line(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function receiverAllowed(receiver: ts.Expression, fileName: string, sf: ts.SourceFile): boolean {
  const text = receiver.getText(sf);
  if (ENV_BINDING_RECEIVER.test(text)) return true;
  return ts.isIdentifier(receiver) && (IN_PROCESS_FETCH_RECEIVERS[fileName] ?? []).includes(receiver.text);
}

function checkModule(spec: ts.Node | undefined, kind: string, f: (k: string) => void): void {
  const value = stringValue(spec);
  if (value === undefined) f(`${kind} with a non-literal specifier`);
  else if (NETWORK_MODULES.test(value)) f(`${kind} of ${value}`);
}

/** Every outbound-capable construct in `source`. `fileName` is the repository-relative path. */
export function findOutbound(source: string, fileName = 'sample.ts'): EgressFinding[] {
  const sf = parse(source, fileName);
  const out: EgressFinding[] = [];
  const add = (node: ts.Node) => (kind: string) => void out.push({ kind, line: line(sf, node) });

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (!isNameOnly(node) && !inTypePosition(node)) {
        if (name === 'fetch') add(node)('global fetch reference');
        else if (NETWORK_GLOBALS.has(name)) add(node)(`${name} reference`);
        else if (name === 'eval' || name === 'Function') add(node)(`${name} reference`);
        else if (name === 'globalThis') {
          const p = node.parent;
          // `globalThis.fetch` is reported by the property rule below, once.
          const okUse = ts.isPropertyAccessExpression(p) && p.expression === node;
          if (!okUse && !(ts.isElementAccessExpression(p) && p.expression === node)) {
            add(node)('globalThis used as a value');
          }
        }
      }
    }
    if (ts.isPropertyAccessExpression(node)) {
      const prop = node.name.text;
      if (prop === 'sendBeacon') add(node)('sendBeacon');
      if (prop === 'fetch' && !receiverAllowed(node.expression, fileName, sf)) {
        const global = GLOBAL_RECEIVERS.has(node.expression.getText(sf));
        add(node)(global ? 'fetch on a global object' : '.fetch on an unrecognised receiver');
      }
    }
    if (ts.isElementAccessExpression(node)) {
      const key = stringValue(node.argumentExpression);
      const receiver = node.expression.getText(sf);
      if (key === 'fetch' || key === 'sendBeacon') add(node)(`['${key}'] access`);
      else if (GLOBAL_RECEIVERS.has(receiver) && key === undefined) add(node)('dynamic property of a global');
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) checkModule(node.moduleSpecifier, 'import', add(node));
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      checkModule(node.moduleReference.expression, 'import', add(node));
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        checkModule(node.arguments[0], 'dynamic import', add(node));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        checkModule(node.arguments[0], 'require', add(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------- call-site helpers (H2)

/** Every CallExpression whose callee is the bare identifier `name`. */
export function callsTo(sf: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The initializer of `const <name> = '<string>'` at the top level, if it is a plain string. */
export function topLevelStringConst(sf: ts.SourceFile, name: string): string | undefined {
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name) return stringValue(d.initializer);
    }
  }
  return undefined;
}

/**
 * Whether a call's first argument is a template literal that STARTS with `${<one of names>}`
 * (empty head), so the host comes from a constant and no input can choose it.
 */
export function startsWithConstant(
  arg: ts.Expression | undefined,
  names: readonly string[],
): string | undefined {
  if (!arg || !ts.isTemplateExpression(arg) || arg.head.text !== '') return undefined;
  const first = arg.templateSpans[0]?.expression;
  return first && ts.isIdentifier(first) && names.includes(first.text) ? first.text : undefined;
}

/** The top-level function declaration that contains `node`. */
export function enclosingFunction(node: ts.Node): ts.FunctionDeclaration | undefined {
  let found: ts.FunctionDeclaration | undefined;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n)) found = n;
  }
  return found;
}

/** Index of the statement of `fn`'s body that contains `node`, or -1. */
export function statementIndex(fn: ts.FunctionDeclaration, node: ts.Node): number {
  const statements = fn.body?.statements ?? [];
  return statements.findIndex((s) => s.pos <= node.pos && node.end <= s.end);
}
