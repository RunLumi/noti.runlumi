import { describe, expect, it } from 'vitest';
import { kekCheckValue } from '../../src/crypto/fingerprint';
import { parseKeyHex } from '../../src/crypto/envelope';
import { createFakeD1, seedOrganization } from '../support/d1';

// The script is plain ESM so an operator can run it without a build step; it has no type declarations.
interface Script {
  checkValue: (kekHex: string, environment: string) => Promise<string>;
  destroyCheckSql: (version: number) => string;
  destroyAuditSql: (input: {
    version: number;
    active: number;
    actor: string;
    reason: string;
    id?: string;
  }) => string;
  evaluateDestroyCheck: (row: unknown) => { safe: boolean; integrations: number; sources: number };
}
const scriptPath = '../../scripts/kek-destroy-check.mjs';
const script = (await import(/* @vite-ignore */ scriptPath)) as Script;

const KEK = '33'.repeat(32);

/** An integration/source row whose wrapped key sits under `version`, in the real envelope layout. */
function seedRows(
  raw: ReturnType<typeof createFakeD1>['raw'],
  rows: { integration?: number; source?: number },
) {
  seedOrganization(raw, 'org-a');
  const envelope = (version: number) => {
    const bytes = new Uint8Array(64);
    bytes[0] = 1;
    new DataView(bytes.buffer).setUint32(2, version, false);
    return bytes;
  };
  if (rows.integration !== undefined)
    raw
      .prepare(
        `INSERT INTO integrations(id,repo,event_types,destination,webhook_ciphertext,organization_id,dek_wrapped,key_salt,kek_version,webhook_envelope)
         VALUES('i1','acme/web','[]','slack','',?,?,?,?,?)`,
      )
      .run('org-a', envelope(rows.integration), new Uint8Array(16), rows.integration, new Uint8Array(40));
  if (rows.source !== undefined)
    raw
      .prepare(
        `INSERT INTO sources(id,organization_id,kind,name,endpoint_id,secret_envelope,key_salt,dek_wrapped,kek_version)
         VALUES('s1','org-a','generic','s','${'e'.repeat(22)}',?,?,?,?)`,
      )
      .run(new Uint8Array(40), new Uint8Array(16), envelope(rows.source), rows.source);
}

const count = (raw: ReturnType<typeof createFakeD1>['raw']) =>
  (raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='key.destroy'").get() as { n: number }).n;

describe('key check value (the operator side of KEK_CHECK_V<n>)', () => {
  it('matches the Worker’s computation for every environment', async () => {
    for (const environment of ['production', 'staging', 'development'] as const)
      expect(await script.checkValue(KEK, environment)).toBe(
        await kekCheckValue(parseKeyHex(KEK), environment),
      );
  });

  it('rejects a malformed KEK or environment without echoing the KEK', async () => {
    await expect(script.checkValue('short', 'production')).rejects.toThrow(/64 hex/);
    await expect(script.checkValue(KEK, 'prod')).rejects.toThrow(/environment/);
    await script
      .checkValue('short', 'production')
      .catch((e: Error) => expect(e.message).not.toContain('short'));
  });
});

describe('destroying a KEK version is blocked while rows remain (F37)', () => {
  it('counts rows wrapped under the version, per table', () => {
    const { raw } = createFakeD1();
    seedRows(raw, { integration: 1, source: 1 });
    const row = raw.prepare(script.destroyCheckSql(1)).get() as { integrations: number; sources: number };
    expect(row).toEqual({ integrations: 1, sources: 1 });
    expect(script.evaluateDestroyCheck(row)).toEqual({ safe: false, integrations: 1, sources: 1 });
    expect(script.evaluateDestroyCheck(raw.prepare(script.destroyCheckSql(2)).get())).toEqual({
      safe: true,
      integrations: 0,
      sources: 0,
    });
  });

  it('also trusts the version inside the wrapped-key envelope, so a stale column cannot hide a row', () => {
    const { raw } = createFakeD1();
    seedRows(raw, { integration: 1 });
    raw.prepare('UPDATE integrations SET kek_version=2').run(); // column says 2, the envelope still says 1
    expect(raw.prepare(script.destroyCheckSql(1)).get()).toMatchObject({ integrations: 1 });
    expect(raw.prepare(script.destroyCheckSql(2)).get()).toMatchObject({ integrations: 1 });
  });

  it('counts quarantined and revoked rows too: their keys are still wrapped under the old KEK', () => {
    const { raw } = createFakeD1();
    seedRows(raw, { integration: 1 });
    raw
      .prepare(
        "UPDATE integrations SET credentials_quarantined_at='x',credentials_quarantine_reason='revoked'",
      )
      .run();
    expect(raw.prepare(script.destroyCheckSql(1)).get()).toMatchObject({ integrations: 1 });
  });

  it('treats an unreadable answer as unsafe', () => {
    expect(script.evaluateDestroyCheck(undefined).safe).toBe(false);
    expect(script.evaluateDestroyCheck({ integrations: null, sources: 0 }).safe).toBe(false);
  });

  it('refuses to record a destruction while rows remain, and records it once none do', () => {
    const { raw } = createFakeD1();
    seedRows(raw, { integration: 1 });
    const input = { version: 1, active: 2, actor: 'ops@example.test', reason: 'retired' };
    raw.exec(script.destroyAuditSql(input));
    expect(count(raw)).toBe(0);

    raw.prepare('UPDATE integrations SET kek_version=2, dek_wrapped=zeroblob(64)').run();
    raw.exec(script.destroyAuditSql(input));
    expect(count(raw)).toBe(1);
    const event = raw.prepare("SELECT * FROM audit_events WHERE action='key.destroy'").get() as Record<
      string,
      unknown
    >;
    expect(event).toMatchObject({
      organization_id: null,
      actor_id: 'ops@example.test',
      subject_type: 'key',
      subject_id: 'kek_v1',
      outcome: 'success',
    });
    expect(JSON.parse(String(event.metadata_json))).toEqual({
      kekVersion: 1,
      reason: 'retired',
      activeVersion: 2,
    });
  });

  it('refuses the active version, bad reasons and unsafe actors before producing any SQL', () => {
    const ok = { version: 1, active: 2, actor: 'ops', reason: 'retired' };
    expect(() => script.destroyAuditSql({ ...ok, active: 1 })).toThrow(/ACTIVE/);
    expect(() => script.destroyAuditSql({ ...ok, reason: "x'); DROP TABLE audit_events;--" })).toThrow(
      /reason/,
    );
    expect(() => script.destroyAuditSql({ ...ok, actor: "a'; DELETE FROM integrations;--" })).toThrow(
      /actor/,
    );
    expect(() => script.destroyAuditSql({ ...ok, version: Number.NaN })).toThrow(/version/);
    expect(() => script.destroyCheckSql(Number('1; DROP TABLE x'))).toThrow(/version/);
  });
});
