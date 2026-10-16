import { describe, expect, it, vi } from 'vitest';

const script = '../scripts/check-deployment-migrations.mjs';
const { checkMigrations } = (await import(/* @vite-ignore */ script)) as {
  checkMigrations: (config: object, fetchImpl?: typeof fetch) => Promise<{ applied: number }>;
};
const config = {
  accountId: 'a'.repeat(32),
  databaseId: '12345678-1234-1234-1234-123456789abc',
  token: crypto.randomUUID(),
  local: ['0001_init.sql', '0002_next.sql'],
};
const reply = (names: string[]) =>
  new Response(
    JSON.stringify({
      success: true,
      result: [{ success: true, results: names.map((name) => ({ name })) }],
    }),
  );

describe('deployment migration ledger gate', () => {
  it('permits a compatible schema using only a read-only query', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply([...config.local, 'retired.sql']));
    await expect(checkMigrations(config, fetchImpl)).resolves.toEqual({ applied: 2 });
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('Expected migration ledger request');
    const [url, init] = call;
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
    );
    expect(JSON.parse(init?.body as string)).toEqual({ sql: 'SELECT name FROM d1_migrations' });
  });

  it('blocks a deploy when a schema migration has not been applied', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(reply(['0001_init.sql']));
    await expect(checkMigrations(config, fetchImpl)).rejects.toThrow('0002_next.sql');
  });

  it('refuses missing credentials before making any request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(checkMigrations({ ...config, token: '' }, fetchImpl)).rejects.toThrow('required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not include an upstream error body in diagnostics', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('private-error-data', { status: 403 }));
    await expect(checkMigrations(config, fetchImpl)).rejects.toThrow('HTTP 403');
    await expect(checkMigrations(config, fetchImpl)).rejects.not.toThrow('private-error-data');
  });

  it.each([
    { success: false, errors: ['private-error-data'] },
    { success: true, result: [] },
    { success: true, result: [{ success: false, results: [] }] },
    { success: true, result: [{ success: true, results: [{ name: 17 }] }] },
  ])('rejects an incomplete or malformed ledger response', async (body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    await expect(checkMigrations(config, fetchImpl)).rejects.toThrow(
      'Invalid deployment migration ledger response',
    );
  });
});
