import { Hono, type Context } from 'hono';
import { auditStatement, requestOrigin } from '../audit/audit';
import { currentSession } from '../auth/workspace';
import type { Bindings } from '../env';
import { hit } from '../security/rate-limit';

/**
 * The signed-in person's own sessions (docs/specs/02 F20, docs/adr/0030-sessions-and-device-list.md).
 *
 *  - `GET  /api/workspace/me/sessions`               list, newest activity first, the caller's marked `current`;
 *  - `POST /api/workspace/me/sessions/:id/revoke`    end one other session;
 *  - `POST /api/workspace/me/sessions/revoke-others` end every session except the one making the request.
 *
 * Every statement is bound to the user id from the verified session, so another person's session is
 * indistinguishable from one that does not exist (404). These routes exist INSTEAD of Better Auth's own
 * `list-sessions` and `revoke-*` endpoints, which the Worker closes (`src/index.ts`): those return the
 * session token, and answer to a token the caller already holds, so they cannot be audited as one change.
 * Here the token is never selected, the delete and its audit row are one D1 batch, and a request that
 * changed nothing records nothing.
 */
export const SESSION_LIST_LIMIT = 100;
export const SESSION_REVOKES_PER_MINUTE = 30;
export const SESSION_LISTS_PER_MINUTE = 120;
const WINDOW_MS = 60_000;
const MAX_USER_AGENT = 256;
/** Better Auth ids are 32 characters from [A-Za-z0-9]; anything else cannot be a session. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Ctx = Context<{ Bindings: Bindings }>;

const sessions = new Hono<{ Bindings: Bindings }>();

/** The address with its last part hidden: enough to notice a stranger, not enough to locate a person. */
export function coarseAddress(ip: string | null): string | null {
  if (!ip) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.x`;
  if (ip.includes(':') && /^[0-9a-fA-F:.]+$/.test(ip)) return `${ip.split(':').slice(0, 3).join(':')}::x`;
  return null;
}

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();

function tooMany(c: Ctx, retryAfterSeconds: number): Response {
  return c.json({ error: 'Too many requests; try again shortly' }, 429, {
    'retry-after': String(retryAfterSeconds),
    'cache-control': 'no-store',
  });
}

function originRejected(c: Ctx): Response | null {
  const origin = c.req.header('origin');
  return !origin || origin !== new URL(c.env.APP_ORIGIN).origin ? c.json({ error: 'Forbidden' }, 403) : null;
}

interface SessionRow {
  id: string;
  created_at: number;
  updated_at: number;
  expires_at: number;
  ip_address: string | null;
  user_agent: string | null;
}

sessions.get('/', async (c) => {
  const s = await currentSession(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  const userId = s.user.id;
  const limit = await hit(c.env.DB, `session-list:${userId}`, SESSION_LISTS_PER_MINUTE, WINDOW_MS);
  if (limit.limited) return tooMany(c, limit.retryAfterSeconds);

  // Explicit columns, and never `token`: it is a usable credential (AR-1).
  const rows = await c.env.DB.prepare(
    `SELECT id, created_at, updated_at, expires_at, ip_address, user_agent
     FROM "session" WHERE user_id=?1 AND expires_at>?2
     ORDER BY updated_at DESC, id LIMIT ?3`,
  )
    .bind(userId, Date.now(), SESSION_LIST_LIMIT)
    .all<SessionRow>();
  return c.json(
    {
      sessions: rows.results.map((r) => ({
        id: r.id,
        current: r.id === s.session.id,
        createdAt: iso(r.created_at),
        lastActiveAt: iso(r.updated_at),
        expiresAt: iso(r.expires_at),
        ip: coarseAddress(r.ip_address),
        userAgent: r.user_agent ? r.user_agent.slice(0, MAX_USER_AGENT) : null,
      })),
    },
    200,
    { 'cache-control': 'no-store' },
  );
});

// Registered before `/:id/revoke` so the literal path is never read as an id.
sessions.post('/revoke-others', async (c) => {
  const refused = originRejected(c);
  if (refused) return refused;
  const s = await currentSession(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  const userId = s.user.id;
  const limit = await hit(c.env.DB, `session-revoke:${userId}`, SESSION_REVOKES_PER_MINUTE, WINDOW_MS);
  if (limit.limited) return tooMany(c, limit.retryAfterSeconds);

  const db = c.env.DB;
  const results = await db.batch([
    db.prepare('DELETE FROM "session" WHERE user_id=?1 AND id<>?2').bind(userId, s.session.id),
    // Recorded only if the delete removed something, with the exact count taken from SQLite.
    auditStatement(
      db,
      {
        organizationId: null,
        actorId: userId,
        action: 'session.revoke_others',
        subjectType: 'session',
        subjectId: null,
        outcome: 'success',
        ...requestOrigin(c.req.raw.headers),
      },
      undefined,
      { changesAs: 'revoked' },
    ),
  ]);
  return c.json({ revoked: results[0]?.meta?.changes ?? 0 }, 200, { 'cache-control': 'no-store' });
});

sessions.post('/:id/revoke', async (c) => {
  const refused = originRejected(c);
  if (refused) return refused;
  const s = await currentSession(c);
  if (!s) return c.json({ error: 'Unauthorized' }, 401);
  const userId = s.user.id;
  const id = c.req.param('id');
  const limit = await hit(c.env.DB, `session-revoke:${userId}`, SESSION_REVOKES_PER_MINUTE, WINDOW_MS);
  if (limit.limited) return tooMany(c, limit.retryAfterSeconds);
  if (!SESSION_ID.test(id)) return c.json({ error: 'Not found' }, 404);
  // Ending the session that is making the request is signing out, which has its own control.
  if (id === s.session.id) return c.json({ error: 'current_session' }, 409);

  const db = c.env.DB;
  const results = await db.batch([
    db.prepare('DELETE FROM "session" WHERE id=?1 AND user_id=?2').bind(id, userId),
    auditStatement(
      db,
      {
        organizationId: null,
        actorId: userId,
        action: 'session.revoke',
        subjectType: 'session',
        subjectId: id,
        outcome: 'success',
        ...requestOrigin(c.req.raw.headers),
      },
      undefined,
      { onlyIfPreviousStatementChangedRows: true },
    ),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return c.json({ error: 'Not found' }, 404);
  return c.json({ revoked: 1 }, 200, { 'cache-control': 'no-store' });
});

export default sessions;
