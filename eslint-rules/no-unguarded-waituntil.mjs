/**
 * Flags `waitUntil(...)` calls whose promise is not settled (ADR 0041, F169).
 *
 * A background promise is accepted when the argument is one of:
 *  - `<expr>.catch(...)`, or `<expr>.then(onFulfilled, onRejected)` with both handlers;
 *  - a call to `settleBackground(...)` (src/platform/background.ts), which never rejects;
 *  - an identifier whose single declaration is initialised with one of the forms above.
 *
 * Anything else, including `waitUntil(Promise.all([...]))` and a plain variable, is reported,
 * because an unhandled rejection in a background task leaves no record of which task failed.
 * Scoped to `src/` by eslint.config.js; the rule itself does not know about paths.
 */
const GUARD_HELPER = 'settleBackground';

function resolveInit(identifier, scope) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(identifier.name);
    if (!variable) continue;
    if (variable.defs.length !== 1) return null;
    // A reassigned binding is not the promise we saw initialised.
    if (variable.references.some((ref) => ref.isWrite() && !ref.init)) return null;
    const def = variable.defs[0];
    return def.node.type === 'VariableDeclarator' && def.node.init ? def.node.init : null;
  }
  return null;
}

function isGuarded(node, scope, depth = 0) {
  if (depth > 3 || !node) return false;
  if (node.type === 'Identifier') return isGuarded(resolveInit(node, scope), scope, depth + 1);
  if (node.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier') return callee.name === GUARD_HELPER;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    if (callee.property.name === 'catch') return true;
    if (callee.property.name === 'then') return node.arguments.length >= 2;
  }
  return false;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require waitUntil() promises to be settled (ADR 0041, F169)',
    },
    schema: [],
    messages: {
      unguarded:
        'waitUntil() must receive a promise settled with settleBackground(...) or .catch(...). ' +
        'An unhandled background rejection leaves no record of which task failed.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.type !== 'Identifier' ||
          callee.property.name !== 'waitUntil'
        )
          return;
        const [task] = node.arguments;
        if (!task) return;
        const scope = context.sourceCode.getScope(node);
        if (!isGuarded(task, scope)) context.report({ node: task, messageId: 'unguarded' });
      },
    };
  },
};

export default rule;
