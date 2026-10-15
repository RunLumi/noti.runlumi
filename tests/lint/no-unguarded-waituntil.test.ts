import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from '../../eslint-rules/no-unguarded-waituntil.mjs';

/**
 * ADR 0041 / F169: every `waitUntil(...)` promise in src/ must be settled, so a background
 * failure is logged rather than lost. These cases pin what the rule accepts and refuses.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

const unguarded = (code: string) => ({ code, errors: [{ messageId: 'unguarded' as const }] });

tester.run('no-unguarded-waituntil', rule, {
  valid: [
    'ctx.waitUntil(settleBackground(dispatchOutbox(env), "outbox_dispatch"));',
    'ctx.waitUntil(task().catch(() => undefined));',
    'ctx.waitUntil(task().then(() => undefined, () => undefined));',
    'const p = task().catch(log); ctx.waitUntil(p);',
    'const p = settleBackground(task(), "x"); ctx.waitUntil(p);',
    'ctx.waitUntil(settleBackground(task().catch(() => undefined), "x"));',
    'ctx.run(task());',
    'obj.waitUntilDone(task());',
  ],
  invalid: [
    unguarded('ctx.waitUntil(dispatchOutbox(env));'),
    unguarded('ctx.waitUntil(Promise.all([a(), b()]));'),
    unguarded('ctx.waitUntil(task().then(() => undefined));'),
    unguarded('const p = task(); ctx.waitUntil(p);'),
    unguarded('let p = task().catch(log); p = other(); ctx.waitUntil(p);'),
    unguarded('ctx.executionCtx.waitUntil(send(input));'),
  ],
});
