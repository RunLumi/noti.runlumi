/**
 * The closed lists the audit log is written and read with. Kept free of runtime types so the
 * dashboard can import them: its action labels are checked against `AUDIT_ACTIONS`.
 */
/** Every action the application records; the audit API and the dashboard's labels are checked against it. */
export const AUDIT_ACTIONS = [
  'integration.create',
  'integration.update',
  'integration.delete',
  'integration.credentials.rotate',
  'integration.credentials.revoke',
  'integration.auto_pause',
  'integration.test',
  'source.create',
  'source.update',
  'source.delete',
  'source.secret.rotate',
  'source.credentials.revoke',
  'delivery.replay',
  'delivery.bulk_replay',
  'access.denied',
  'github.installation.bind',
  'github.installation.bind_refused',
  'github.installation.lifecycle',
  'github.repository.out_of_scope',
  'github.webhook.refused',
  'workspace.export',
  'workspace.deletion.request',
  'workspace.deletion.cancel',
  'workspace.purged',
  'account.export',
  'account.delete',
  'key.destroy',
  'member.invite',
  'member.invite.accept',
  'member.invite.reject',
  'member.invite.cancel',
  'member.role.change',
  'member.remove',
  'session.revoke',
  'session.revoke_others',
  'session.revoke_all',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_SUBJECT_TYPES = [
  'integration',
  'source',
  'delivery',
  'organization',
  'capability',
  'github_installation',
  'repository',
  'key',
  'member',
  'invitation',
  'session',
] as const;
