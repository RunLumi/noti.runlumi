import { log } from './log';

const READY_D1_TIMEOUT_MS = 3000;

/** Does D1 answer `SELECT 1` within 3 seconds? Never throws; the timer is always cleared. */
export async function d1Answers(db: D1Database): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), READY_D1_TIMEOUT_MS);
    });
    return (await Promise.race([probe, timeout]))?.ok === 1;
  } catch {
    log('error', 'ready_d1_failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
