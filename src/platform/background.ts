import { log } from './log';

/**
 * Settle a promise handed to `ExecutionContext.waitUntil` (ADR 0041, F169).
 *
 * A rejected background task otherwise surfaces only as an unhandled rejection, with no
 * structured record of which task failed. The returned promise never rejects: the failure
 * is logged once through `log()` (so it is redacted like every other line) and the caller's
 * request has already been answered from durable state. `eslint-rules/no-unguarded-waituntil.mjs`
 * requires every `waitUntil(...)` argument in `src/` to be wrapped this way or with `.catch`.
 */
export function settleBackground(task: Promise<unknown>, label: string): Promise<void> {
  return task.then(
    () => undefined,
    (error: unknown) => {
      log('error', 'background_task_failed', { task: label, error });
    },
  );
}
