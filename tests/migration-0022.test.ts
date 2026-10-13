import { describe, expect, it } from 'vitest';
import { applyMigration, createFakeD1 } from './support/d1';

describe('migration 0022', () => {
  it('adds is_test (default 0) and keeps every existing delivery as a real one', () => {
    const { raw } = createFakeD1({ before: '0022' });
    raw
      .prepare("INSERT INTO deliveries(id,integration_id,organization_id,state) VALUES('d1','i','o','sent')")
      .run();
    applyMigration(raw, '0022_test_deliveries.sql');
    expect(raw.prepare('SELECT id,is_test FROM deliveries').all()).toEqual([{ id: 'd1', is_test: 0 }]);
    const columns = raw.prepare('PRAGMA table_info(deliveries)').all() as { name: string; notnull: number }[];
    expect(columns.find((c) => c.name === 'is_test')?.notnull).toBe(1);
  });
});
