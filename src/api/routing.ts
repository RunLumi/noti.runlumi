import { Hono } from 'hono';
import { isGithubEventType } from '../connectors/sources/github/catalog';
import type { Bindings } from '../env';
import { asRecord } from '../lib/json';
import { parseFacts, parseFilters, readStoredFilters } from '../routing/filter-input';
import { evaluateFilters } from '../routing/filters';
import { heldStatus } from '../routing/noise-store';
import { decodeCursor, listRoutingLog, LOG_PAGE_DEFAULT, LOG_PAGE_MAX } from '../routing/provenance';
import { gate, invalid, loadRow, mutationRejected, rateLimited, readJson } from './integrations';

/**
 * Routing filters, read side and dry run (ADR 0010). Mounted under /api/integrations.
 *
 *   GET  /:id/routing-log       why events were delivered or held back (integration.read)
 *   POST /:id/filters/preview   pure dry run over a SAMPLE facts object; no delivery, no write
 *
 * Every query carries the resolved workspace; another workspace's integration is a 404.
 */
export const PREVIEWS_PER_MINUTE = 60;

const routing = new Hono<{ Bindings: Bindings }>();

routing.get('/:id/routing-log', async (c) => {
  const who = await gate(c, 'integration.read');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  if (!(await loadRow(c, who.orgId, id))) return c.json({ error: 'Not found' }, 404);

  const rawLimit = c.req.query('limit');
  const limit = rawLimit === undefined ? LOG_PAGE_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > LOG_PAGE_MAX)
    return c.json({ error: `limit must be 1–${LOG_PAGE_MAX}` }, 400);
  const rawCursor = c.req.query('cursor');
  const after = rawCursor === undefined ? null : decodeCursor(rawCursor);
  if (rawCursor !== undefined && !after) return c.json({ error: 'Invalid cursor' }, 400);

  const page = await listRoutingLog(c.env.DB, who.orgId, id, limit, after);
  return c.json({ entries: page.entries, nextCursor: page.nextCursor });
});

/**
 * How many updates noise control is holding for this integration and when the next release is
 * due, so held updates are visible and never a black hole (spec 11 F146).
 */
routing.get('/:id/noise-status', async (c) => {
  const who = await gate(c, 'integration.read');
  if (who instanceof Response) return who;
  const id = c.req.param('id');
  if (!(await loadRow(c, who.orgId, id))) return c.json({ error: 'Not found' }, 404);
  const status = await heldStatus(c.env.DB, who.orgId, id);
  return c.json({
    held: {
      count: status.count,
      nextReleaseAt: status.nextReleaseAt === null ? null : new Date(status.nextReleaseAt).toISOString(),
    },
  });
});

routing.post('/:id/filters/preview', async (c) => {
  // Same CSRF rules as every other mutation, although nothing is written.
  const rejected = mutationRejected(c);
  if (rejected) return rejected;
  const who = await gate(c, 'integration.read');
  if (who instanceof Response) return who;
  const limited = await rateLimited(c, who.userId, 'filters-preview', PREVIEWS_PER_MINUTE);
  if (limited) return limited;

  const row = await loadRow(c, who.orgId, c.req.param('id'));
  if (!row) return c.json({ error: 'Not found' }, 404);
  const read = await readJson(c);
  if (!read.ok) return read.response;
  const body = asRecord(read.body);
  if (!body) return invalid(c, [{ field: 'body', message: 'Expected a JSON object.' }]);

  if (typeof body.eventType !== 'string' || !isGithubEventType(body.eventType))
    return invalid(c, [{ field: 'eventType', message: 'Choose one of the supported events.' }]);
  const facts = parseFacts(body.facts ?? {});
  if (!facts.ok) return invalid(c, facts.errors);

  // Dry-run the draft the caller is editing, or the saved filters when none is sent.
  let config;
  if (body.filters === undefined) {
    const stored = readStoredFilters(row.filters_json);
    config = stored.kind === 'ok' ? stored.config : {};
  } else {
    const parsed = parseFilters(body.filters);
    if (!parsed.ok) return invalid(c, parsed.errors);
    config = parsed.value;
  }
  const decision = evaluateFilters(config, body.eventType, facts.value);
  return c.json({
    result: {
      outcome: decision.pass ? 'delivered' : 'filtered',
      filterId: decision.filterId,
      reason: decision.reason,
      unknownFact: decision.unknown,
    },
  });
});

export default routing;
