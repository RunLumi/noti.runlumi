/**
 * Append-only audit events (docs/specs/02-identity-tenancy.md F28).
 *
 * Callers pass structured metadata built from values we control (ids, enum names, counts,
 * hostnames). Free text, URLs with paths and credentials never belong here; the type below
 * only admits primitives and string arrays, and the serialised size is capped.
 */
export type AuditAction =
  | 'integration.create'
  | 'integration.update'
  | 'integration.delete'
  | 'integration.credentials.rotate'
  | 'access.denied';

export type AuditMetadata = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface AuditEntry {
  readonly organizationId: string | null;
  readonly actorId: string | null;
  readonly action: AuditAction;
  readonly subjectType: 'integration' | 'organization' | 'capability';
  readonly subjectId: string | null;
  readonly outcome: 'success' | 'denied';
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly metadata?: AuditMetadata;
}

const MAX_METADATA_BYTES = 4096;
const MAX_USER_AGENT = 256;

/** Serialise metadata, dropping it (not truncating JSON into garbage) if it is too large. */
export function serialiseMetadata(metadata: AuditMetadata | undefined): string {
  const json = JSON.stringify(metadata ?? {});
  return new TextEncoder().encode(json).length <= MAX_METADATA_BYTES ? json : '{"truncated":true}';
}

/** A statement for `db.batch`, so an audit row commits with the change it describes. */
export function auditStatement(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events(id,organization_id,actor_id,action,subject_type,subject_id,outcome,ip,user_agent,metadata_json)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      crypto.randomUUID(),
      entry.organizationId,
      entry.actorId,
      entry.action,
      entry.subjectType,
      entry.subjectId,
      entry.outcome,
      entry.ip ?? null,
      entry.userAgent ? entry.userAgent.slice(0, MAX_USER_AGENT) : null,
      serialiseMetadata(entry.metadata),
    );
}

export async function recordAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}

/** Request attribution. `cf-connecting-ip` is set by Cloudflare's edge, not the client. */
export function requestOrigin(headers: Headers): { ip: string | null; userAgent: string | null } {
  return { ip: headers.get('cf-connecting-ip'), userAgent: headers.get('user-agent') };
}
