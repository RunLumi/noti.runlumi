import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';

describe('migration 0024', () => {
  it('adds the fingerprint and revocation columns without changing existing rows', () => {
    const { raw } = createFakeD1({ before: '0024' });
    raw.prepare("INSERT INTO \"organization\"(id,name,slug,created_at) VALUES('o','o','o',1)").run();
    raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id)
         VALUES('i','a/b','[]','slack','x','o')`,
      )
      .run();
    applyMigration(raw, '0024_credential_lifecycle.sql');
    expect(
      raw.prepare('SELECT id,credential_fingerprint,credentials_quarantined_at FROM integrations').all(),
    ).toEqual([{ id: 'i', credential_fingerprint: null, credentials_quarantined_at: null }]);
    const sources = (
      raw.prepare('PRAGMA table_info(sources)').all() as { name: string; notnull: number }[]
    ).filter((c) => c.name === 'credential_fingerprint' || c.name === 'credentials_revoked_at');
    expect(sources.map((c) => [c.name, c.notnull])).toEqual([
      ['credential_fingerprint', 0],
      ['credentials_revoked_at', 0],
    ]);
  });
});
