import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1, seedOrganization } from './support/d1';

describe('migration 0007', () => {
  it('removes legacy ciphertext from every outbox row and keeps the rows', () => {
    const { raw } = createFakeD1({ before: '0007' });
    const legacy = (id: string) =>
      JSON.stringify({
        id,
        integrationId: 'i',
        destination: 'lark',
        ciphertext: 'c2VjcmV0',
        larkSecretCiphertext: 'eA==',
      });
    raw
      .prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('p',?,'pending')")
      .run(legacy('p'));
    raw
      .prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('d',?,'dispatched')")
      .run(legacy('d'));
    raw
      .prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('x','not json','pending')")
      .run();

    applyMigration(raw, '0007_envelope_encryption.sql');

    const rows = raw.prepare('SELECT id,payload_json,state FROM notification_outbox ORDER BY id').all() as {
      id: string;
      payload_json: string;
      state: string;
    }[];
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['d', 'dispatched'],
      ['p', 'pending'],
      ['x', 'pending'],
    ]);
    for (const row of rows.filter((r) => r.id !== 'x')) {
      expect(JSON.parse(row.payload_json)).toEqual({ id: row.id, integrationId: 'i' });
    }
  });

  it('accepts the new invalid outbox state and rejects unknown ones', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'org');
    raw
      .prepare(
        "INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES('a','{}','invalid','org')",
      )
      .run();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES('b','{}','bogus','org')",
        )
        .run(),
    ).toThrow();
  });
});

describe('migration 0009', () => {
  it('keeps every outbox and delivery row, and maps legacy delivery states', () => {
    const { raw } = createFakeD1({ before: '0009' });
    raw
      .prepare(
        "INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES('o1','{}','dispatched','org')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES('o2','{}','invalid','org')",
      )
      .run();
    const insert = raw.prepare(
      'INSERT INTO deliveries(id,integration_id,state,attempts,last_error,organization_id) VALUES(?,?,?,?,?,?)',
    );
    insert.run('p', 'i', 'pending', 0, null, 'org');
    insert.run('s', 'i', 'sent', 1, null, 'org');
    insert.run('r', 'i', 'retrying', 2, 'provider_http_503', 'org');
    insert.run('f1', 'i', 'failed', 1, 'destination_credentials_invalid', 'org');
    insert.run('f2', 'i', 'failed', 1, 'destination_not_allowed', 'org');
    insert.run('f3', 'i', 'failed', 1, 'integration_unavailable', 'org');
    insert.run('x', 'i', 'weird', 1, 'something', 'org');

    applyMigration(raw, '0009_delivery_reliability.sql');

    expect(raw.prepare('SELECT id,state,organization_id FROM notification_outbox ORDER BY id').all()).toEqual(
      [
        { id: 'o1', state: 'dispatched', organization_id: 'org' },
        { id: 'o2', state: 'invalid', organization_id: 'org' },
      ],
    );
    const dead = (id: string, lastError: string, code: string) => ({
      id,
      state: 'dead_lettered',
      attempts: 1,
      last_error: lastError,
      last_error_code: code,
    });
    expect(
      raw.prepare('SELECT id,state,attempts,last_error,last_error_code FROM deliveries ORDER BY id').all(),
    ).toEqual([
      dead('f1', 'destination_credentials_invalid', 'destination_credentials_invalid'),
      dead('f2', 'destination_not_allowed', 'destination_url_rejected'),
      dead('f3', 'integration_unavailable', 'config_invalid'),
      { id: 'p', state: 'pending', attempts: 0, last_error: null, last_error_code: null },
      {
        id: 'r',
        state: 'retrying',
        attempts: 2,
        last_error: 'provider_http_503',
        last_error_code: 'internal_error',
      },
      { id: 's', state: 'sent', attempts: 1, last_error: null, last_error_code: null },
      dead('x', 'something', 'internal_error'),
    ]);
  });

  it('recreates the indexes and enforces the new state sets', () => {
    const { raw } = createFakeD1();
    const indexes = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'notification_outbox_pending',
        'notification_outbox_org_idx',
        'notification_outbox_lease',
        'deliveries_org_idx',
        'deliveries_state_next',
        'deliveries_replay_of',
        'deliveries_state_claimed',
        'notification_outbox_org_due',
      ]),
    );
    seedOrganization(raw, 'org');
    raw
      .prepare(
        "INSERT INTO notification_outbox(id,payload_json,state,organization_id) VALUES('a','{}','claimed','org')",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES('d','i','dead_lettered','org')",
      )
      .run();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO deliveries(id,integration_id,state,organization_id) VALUES('e','i','bogus','org')",
        )
        .run(),
    ).toThrow();
  });

  it('keeps legacy failed writable for one release, so a Worker rollback still works (M4)', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'org');
    // Exactly the statement the slice 2 consumer runs for a permanent failure.
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d','i','org','pending')",
      )
      .run();
    raw
      .prepare(
        'UPDATE deliveries SET state=?,attempts=attempts+1,last_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND integration_id=?',
      )
      .run('failed', 'destination_credentials_invalid', 'd', 'org', 'i');
    expect(raw.prepare("SELECT state FROM deliveries WHERE id='d'").get()).toEqual({ state: 'failed' });
  });

  it('retires rows that have no organization instead of stranding them (M5)', () => {
    const { raw } = createFakeD1({ before: '0009' });
    raw.prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('o','{}','pending')").run();
    raw
      .prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('od','{}','dispatched')")
      .run();
    raw.prepare("INSERT INTO deliveries(id,integration_id,state) VALUES('o','i','pending')").run();
    raw.prepare("INSERT INTO deliveries(id,integration_id,state) VALUES('r','i','retrying')").run();
    raw.prepare("INSERT INTO deliveries(id,integration_id,state) VALUES('s','i','sent')").run();

    applyMigration(raw, '0009_delivery_reliability.sql');

    expect(raw.prepare('SELECT id,state,last_error_code FROM notification_outbox ORDER BY id').all()).toEqual(
      [
        { id: 'o', state: 'invalid', last_error_code: 'config_invalid' },
        { id: 'od', state: 'dispatched', last_error_code: null },
      ],
    );
    expect(
      raw.prepare('SELECT id,state,last_error,last_error_code FROM deliveries ORDER BY id').all(),
    ).toEqual([
      {
        id: 'o',
        state: 'dead_lettered',
        last_error: 'organization_missing',
        last_error_code: 'config_invalid',
      },
      {
        id: 'r',
        state: 'dead_lettered',
        last_error: 'organization_missing',
        last_error_code: 'config_invalid',
      },
      { id: 's', state: 'sent', last_error: null, last_error_code: null },
    ]);
  });
});

describe('migration 0012', () => {
  const COLUMNS = [
    'id',
    'repo',
    'event_types',
    'destination',
    'webhook_ciphertext',
    'enabled',
    'lark_secret_ciphertext',
    'organization_id',
    'key_salt',
    'dek_wrapped',
    'kek_version',
    'webhook_envelope',
    'lark_secret_envelope',
    'credentials_quarantined_at',
    'credentials_quarantine_reason',
    'name',
    'destination_host',
    'created_by',
    'created_at',
    'updated_at',
  ];

  function schemaNames(raw: DatabaseSync, type: 'index' | 'trigger'): string[] {
    const sql =
      "SELECT name FROM sqlite_master WHERE type=? AND tbl_name='integrations' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    return (raw.prepare(sql).all(type) as { name: string }[]).map((r) => r.name);
  }

  function seed(raw: DatabaseSync): void {
    const insert = raw.prepare(
      `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,enabled,lark_secret_ciphertext,
         organization_id,key_salt,dek_wrapped,kek_version,webhook_envelope,lark_secret_envelope,
         credentials_quarantined_at,credentials_quarantine_reason,name,destination_host,created_by,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const blob = (...bytes: number[]) => new Uint8Array(bytes);
    // A fully populated sealed row, a v0 row, a quarantined row, and a row from before 0008.
    insert.run(
      'sealed',
      'acme/web',
      '["push"]',
      'slack',
      '',
      1,
      null,
      'org-a',
      blob(1, 2, 3),
      blob(4, 5, 6),
      2,
      blob(7, 8),
      blob(9),
      null,
      null,
      'Alerts',
      'hooks.slack.com',
      'user-1',
      '2026-01-01 00:00:00',
      '2026-01-02 00:00:00',
    );
    insert.run(
      'legacy',
      'acme/api',
      '["issues.opened"]',
      'lark',
      'Y2lwaGVy',
      0,
      'c2VjcmV0',
      'org-b',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    insert.run(
      'quarantined',
      'acme/ui',
      '[]',
      'lark',
      'x',
      1,
      null,
      'org-a',
      blob(1),
      blob(2),
      1,
      blob(3),
      null,
      '2026-02-02 00:00:00',
      'malformed_envelope',
      'Broken',
      'open.larksuite.com',
      null,
      '2026-02-01',
      '2026-02-02',
    );
    // 0008 made organization_id mandatory for new rows only; legacy rows stay readable.
    raw.exec('DROP TRIGGER integrations_org_required_insert');
    insert.run(
      'orphan',
      'old/repo',
      '[]',
      'slack',
      'b2xk',
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
  }

  const rows = (raw: DatabaseSync): unknown[] => raw.prepare('SELECT * FROM integrations ORDER BY id').all();

  it('preserves every row, column, index and trigger', () => {
    const { raw } = createFakeD1({ before: '0012' });
    seed(raw);
    raw.exec(
      "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d','sealed','org-a','sent')",
    );
    const beforeRows = rows(raw);
    const beforeIndexes = schemaNames(raw, 'index');
    expect(beforeRows).toHaveLength(4);
    expect(beforeIndexes).toEqual(
      expect.arrayContaining([
        'integrations_kek_version',
        'integrations_org_created',
        'integrations_org_idx',
        'integrations_repo',
      ]),
    );

    applyMigration(raw, '0012_teams_destination.sql');

    const columns = (raw.prepare('PRAGMA table_info(integrations)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toEqual(COLUMNS);
    // Values, NULLs and BLOBs survive unchanged.
    expect(rows(raw)).toEqual(beforeRows);
    expect(schemaNames(raw, 'index')).toEqual(beforeIndexes);
    // Triggers are dropped with the table, so 0012 must have recreated them.
    expect(schemaNames(raw, 'trigger')).toEqual([
      'integrations_org_immutable',
      'integrations_org_required_insert',
    ]);
    expect(raw.prepare("SELECT id,state FROM deliveries WHERE id='d'").get()).toEqual({
      id: 'd',
      state: 'sent',
    });
  });

  const insertRow = (raw: DatabaseSync, id: string, destination: string, org: string | null) =>
    raw
      .prepare(
        'INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id) VALUES(?,?,?,?,?,?)',
      )
      .run(id, 'a/b', '[]', destination, '', org);

  it('the recreated triggers still enforce the tenant contract', () => {
    const { raw } = createFakeD1();
    for (const org of ['org-a', 'org-b']) seedOrganization(raw, org);
    expect(() => insertRow(raw, 'x', 'slack', null)).toThrow(/organization_id is required/);
    expect(() => insertRow(raw, 'y', 'slack', '')).toThrow(/organization_id is required/);
    insertRow(raw, 'ok', 'slack', 'org-a');
    expect(() => raw.prepare("UPDATE integrations SET organization_id='org-b' WHERE id='ok'").run()).toThrow(
      /cannot change/,
    );
  });

  it('accepts teams and still rejects unknown destinations', () => {
    const { raw } = createFakeD1();
    seedOrganization(raw, 'org-a');
    for (const kind of ['lark', 'slack', 'teams']) insertRow(raw, kind, kind, 'org-a');
    expect(() => insertRow(raw, 'd', 'telegram', 'org-a')).toThrow();
  });
});

describe('migration 0013', () => {
  it('adds the delivery log indexes without changing rows, and is idempotent', () => {
    const { raw } = createFakeD1({ before: '0013' });
    raw
      .prepare(
        "INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d','i','o','dead_lettered')",
      )
      .run();
    const indexes = () =>
      (
        raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deliveries'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
    expect(indexes()).not.toContain('deliveries_org_updated');
    applyMigration(raw, '0013_delivery_log_indexes.sql');
    applyMigration(raw, '0013_delivery_log_indexes.sql');
    expect(indexes()).toEqual(expect.arrayContaining(['deliveries_org_updated', 'deliveries_org_created']));
    expect(raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toEqual({ n: 1 });
  });
});

describe('migration 0017', () => {
  it('adds sources and integrations.source_id without changing existing rows', () => {
    const { raw } = createFakeD1({ before: '0017' });
    raw.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('o','o','o',1)").run();
    raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,name)
         VALUES('i1','acme/web','["issues.opened"]','slack','c','o','Alerts')`,
      )
      .run();
    applyMigration(raw, '0017_generic_source.sql');

    expect(raw.prepare('SELECT id,repo,event_types,name,source_id FROM integrations').all()).toEqual([
      { id: 'i1', repo: 'acme/web', event_types: '["issues.opened"]', name: 'Alerts', source_id: null },
    ]);
    const names = (
      raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'sources_org_required_insert',
        'sources_org_immutable',
        'integrations_source_same_org',
        'integrations_org_required_insert',
        'integrations_org_immutable',
      ]),
    );
    // A source cascades from its organization; the unique endpoint id is enforced.
    const insert = (id: string, endpoint: string) =>
      raw
        .prepare(
          `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
           VALUES(?,'o','generic','n',?,x'00',x'00',x'00',1)`,
        )
        .run(id, endpoint);
    insert('s1', 'a'.repeat(22));
    expect(() => insert('s2', 'a'.repeat(22))).toThrow();
    expect(() => insert('s3', 'short')).toThrow();
    raw.prepare("DELETE FROM organization WHERE id='o'").run();
    expect(raw.prepare('SELECT COUNT(*) AS n FROM sources').get()).toEqual({ n: 0 });
  });
});
