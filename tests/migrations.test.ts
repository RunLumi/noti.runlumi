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
