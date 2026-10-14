import type { DatabaseSync } from 'node:sqlite';
import { seedOrganization } from './d1';

/** Legacy-shaped rows for migration 0026 and its preflight: every derivable and underivable shape. */
export function seedLegacy(raw: DatabaseSync): void {
  // Legacy rows could exist with no tenant before the 0008 triggers; simulate that history.
  raw.exec('DROP TRIGGER integrations_org_required_insert; DROP TRIGGER integrations_source_same_org');
  for (const org of ['org-a', 'org-b']) seedOrganization(raw, org);
  raw.exec(`
    INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
      VALUES('src-a','org-a','generic','Deploys','ep-aaaaaaaaaaaaaaaaaaaaaaaa',x'00',x'00',x'00',1);
  `);
  const integ = raw.prepare(
    `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,enabled,organization_id,name,source_id)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  );
  integ.run('i-ok', 'acme/web', '[]', 'slack', 'ciphertext-marker', 1, 'org-a', 'Alerts', null);
  integ.run('i-b', 'acme/api', '[]', 'teams', 'x', 1, 'org-b', null, null);
  integ.run('i-src', 'source:src-a', '[]', 'lark', 'x', 1, null, 'Via source', 'src-a');
  integ.run('i-orphan', 'acme/old', '[]', 'slack', 'ciphertext-marker', 1, null, 'Old', null);
  integ.run('i-dangling', 'acme/ghost', '[]', 'slack', 'ciphertext-marker', 1, 'ghost', null, null);
  integ.run('i-empty', 'acme/empty', '[]', 'slack', 'x', 1, '', null, null);
  // Legacy free text is unbounded: a very long repo and name with astral and combining characters.
  const long = `é${'x'.repeat(2400)}😀`;
  integ.run(
    'i-long',
    long,
    '[]',
    'slack',
    'ciphertext-marker',
    1,
    null,
    `👩‍👩‍👧 e\u0301${'ü'.repeat(900)}`,
    null,
  );
  // An id that differs from a real organization only by case is never "corrected": it is quarantined.
  integ.run('i-case', 'acme/case', '[]', 'slack', 'x', 1, 'ORG-A', null, null);

  const deliv = raw.prepare(
    'INSERT INTO deliveries(id,integration_id,state,organization_id,created_at) VALUES(?,?,?,?,?)',
  );
  deliv.run('d-derive', 'i-ok', 'sent', null, '2026-01-01');
  deliv.run('d-via-source', 'i-src', 'sent', null, '2026-01-01');
  deliv.run('d-set', 'i-b', 'sent', 'org-b', '2026-01-02');
  deliv.run('d-orphan', 'i-orphan', 'sent', null, '2026-01-03');
  deliv.run('d-no-integration', 'gone', 'sent', null, '2026-01-03');
  deliv.run('d-dangling', 'i-b', 'sent', 'ghost', '2026-01-04');
  // Cross-tenant anomaly: a valid organization that is not its integration's. Kept, reported by the preflight.
  deliv.run('d-mismatch', 'i-b', 'sent', 'org-a', '2026-01-05');

  const outbox = raw.prepare(
    'INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES(?,?,?,?)',
  );
  outbox.run('d-derive', '{"id":"d-derive"}', 'dispatched', null);
  outbox.run('o-payload', '{"id":"o-payload","integrationId":"i-ok"}', 'pending', null);
  outbox.run('o-badjson', 'not json', 'invalid', null);
  outbox.run(
    'o-orphan',
    '{"id":"o-orphan","integrationId":"i-orphan","body":"event-body-marker"}',
    'pending',
    null,
  );
  outbox.run('o-set', '{}', 'dispatched', 'org-b');

  const held = raw.prepare(
    `INSERT INTO held_events(id,organization_id,integration_id,hold_reason,group_key,release_at,held_at,event_type,
       title,url,repo,actor,status,summary) VALUES(?,?,?,'digest',?,1,1,'push','event-body-marker','','','','info','')`,
  );
  held.run('h-ok', 'org-a', 'i-ok', 'k'.repeat(32));
  held.run('h-dangling', 'ghost', 'i-ok', 'k'.repeat(32));
  const route = raw.prepare(
    `INSERT INTO routing_decisions(id,organization_id,integration_id,event_type,outcome,reason,decided_at)
     VALUES(?,?,?,'push','delivered','ok',1)`,
  );
  route.run('r-ok', 'org-a', 'i-ok');
  route.run('r-dangling', 'ghost', 'i-ok');
  const noise = raw.prepare(
    'INSERT INTO noise_open_failures(organization_id,integration_id,key_hash,opened_at) VALUES(?,?,?,1)',
  );
  noise.run('org-a', 'i-ok', 'k'.repeat(32));
  noise.run('ghost', 'i-ok', 'k'.repeat(32));

  // Delivery ledger depth (0025): the new deliveries columns carry values, and the new tables hold rows
  // that point at deliveries by id (no foreign key), including at one that will be quarantined.
  raw.exec(`
    UPDATE deliveries SET state='suppressed', duplicate_of='d-derive', suppressed_reason='duplicate',
      possible_duplicate=1, provider_message_id='pm-1' WHERE id IN ('d-set','d-derive');
    INSERT INTO event_dedup(organization_id,delivery_id,dedup_key,integration_id,first_seen,last_seen,hit_count,expires_at)
      VALUES('org-a','d-derive','k1','i-ok',1,2,3,99);
    INSERT INTO delivery_attempts(id,organization_id,delivery_id,integration_id,attempt,started_at,finished_at,outcome,
      status_class,possible_duplicate,repeat_count)
      VALUES('a1','org-a','d-orphan','i-orphan',1,1,2,'delivered','2xx',1,4);
    INSERT INTO destination_health(organization_id,integration_id,state,updated_at) VALUES('org-a','i-ok','closed',1);
  `);
}
