import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';

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
    raw.prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('a','{}','invalid')").run();
    expect(() =>
      raw.prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('b','{}','bogus')").run(),
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
    raw.prepare("INSERT INTO notification_outbox(id,payload_json,state) VALUES('a','{}','claimed')").run();
    raw.prepare("INSERT INTO deliveries(id,integration_id,state) VALUES('d','i','dead_lettered')").run();
    expect(() =>
      raw.prepare("INSERT INTO deliveries(id,integration_id,state) VALUES('e','i','bogus')").run(),
    ).toThrow();
  });

  it('keeps legacy failed writable for one release, so a Worker rollback still works (M4)', () => {
    const { raw } = createFakeD1();
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
