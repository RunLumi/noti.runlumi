import type { ListFilters } from './delivery-view';

/**
 * SQL for the delivery log, kept apart from the routes so a test can run `EXPLAIN QUERY PLAN`
 * on exactly what the routes run. Migration 0013 adds the indexes these rely on.
 */
export const SELECT_VIEW = `
  d.id, d.integration_id, d.state, d.attempts, d.last_error_code, d.replay_of,
  d.created_at, d.updated_at, d.first_attempt_at, d.last_attempt_at, d.next_attempt_at,
  d.dead_lettered_at,
  i.name AS integration_name, i.repo AS integration_repo,
  i.destination AS integration_destination, i.destination_host AS integration_destination_host,
  i.enabled AS integration_enabled, i.credentials_quarantined_at AS integration_quarantined_at,
  (SELECT r.state FROM deliveries r
     WHERE r.replay_of = d.id AND r.organization_id = d.organization_id
     ORDER BY r.rowid DESC LIMIT 1) AS latest_replay_state`;

export const FROM_VIEW = `FROM deliveries d
  LEFT JOIN integrations i ON i.id = d.integration_id AND i.organization_id = d.organization_id`;

export interface BuiltQuery {
  readonly sql: string;
  readonly values: readonly (string | number)[];
}

export function buildListQuery(orgId: string, f: ListFilters): BuiltQuery {
  const where = ['d.organization_id = ?'];
  const values: (string | number)[] = [orgId];
  if (f.state === 'dead_lettered') where.push("d.state IN ('dead_lettered','failed')");
  else if (f.state) {
    where.push('d.state = ?');
    values.push(f.state);
  }
  if (f.integrationId) {
    where.push('d.integration_id = ?');
    values.push(f.integrationId);
  }
  if (f.from) {
    where.push('d.updated_at >= ?');
    values.push(f.from);
  }
  if (f.to) {
    where.push('d.updated_at <= ?');
    values.push(f.to);
  }
  if (f.cursor) {
    where.push('(d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))');
    values.push(f.cursor.updatedAt, f.cursor.updatedAt, f.cursor.id);
  }
  return {
    sql: `SELECT ${SELECT_VIEW} ${FROM_VIEW} WHERE ${where.join(' AND ')}
     ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`,
    values: [...values, f.limit + 1],
  };
}

/**
 * Binds: organization id, window start, window start (the second covers rows without
 * created_at). `INDEXED BY` because, without ANALYZE statistics, SQLite is free to pick the
 * single-column `deliveries_org_idx` and read every row of the workspace; this makes a missing
 * migration fail loudly instead of silently scanning.
 */
export const SUMMARY_SQL = `SELECT state, COUNT(*) AS n FROM deliveries INDEXED BY deliveries_org_created
  WHERE organization_id = ? AND (created_at >= ? OR (created_at IS NULL AND updated_at >= ?))
  GROUP BY state`;
