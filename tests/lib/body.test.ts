import { describe, expect, it } from 'vitest';
import { declaredLength, readBodyCapped } from '../../src/lib/body';

const CAP = 1024;

function source(chunks: number, size: number) {
  const chunk = new Uint8Array(size).fill(0x62);
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close();
      state.pulled++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

const request = (body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) =>
  ({ body, headers: new Headers(headers) }) as Pick<Request, 'body' | 'headers'>;

describe('declaredLength', () => {
  it('reads plain non-negative integers and treats everything else as unknown', () => {
    expect(declaredLength('0')).toBe(0);
    expect(declaredLength(' 42 ')).toBe(42);
    for (const bad of [null, undefined, '', 'abc', '-1', '1.5', '1e3', '0x10', '12 34', '9'.repeat(16)])
      expect(declaredLength(bad)).toBeNull();
  });
});

describe('readBodyCapped', () => {
  it('returns the exact bytes for a body under and exactly at the cap', async () => {
    const small = await readBodyCapped(request(source(2, 100).body), CAP);
    expect(small.ok && small.bytes.length).toBe(200);
    const exact = await readBodyCapped(request(source(4, 256).body), CAP);
    expect(exact.ok && exact.bytes.length).toBe(CAP);
  });

  it('refuses one byte over the cap and stops reading (chunked, no Content-Length)', async () => {
    const { body, state } = source(100, 256); // 25 KiB offered
    expect(await readBodyCapped(request(body), CAP)).toEqual({ ok: false, reason: 'too_large' });
    expect(state.pulled).toBeLessThanOrEqual(6);
    expect(state.cancelled).toBe(true);
  });

  it('refuses a declared length over the cap without reading at all', async () => {
    const { body, state } = source(100, 256);
    const res = await readBodyCapped(request(body, { 'content-length': String(CAP + 1) }), CAP);
    expect(res).toEqual({ ok: false, reason: 'too_large' });
    expect(state.pulled).toBe(0);
  });

  it('does not trust a small declared length', async () => {
    const { body } = source(100, 256);
    expect((await readBodyCapped(request(body, { 'content-length': '5' }), CAP)).ok).toBe(false);
  });

  it('counts the stream when the declared length is missing or not a number', async () => {
    const variants: Record<string, string>[] = [
      {},
      { 'content-length': 'NaN' },
      { 'content-length': '' },
      { 'content-length': '-5' },
    ];
    for (const header of variants) {
      expect((await readBodyCapped(request(source(100, 256).body, header), CAP)).ok).toBe(false);
      expect((await readBodyCapped(request(source(1, 10).body, header), CAP)).ok).toBe(true);
    }
  });

  it('treats a missing body as empty', async () => {
    const res = await readBodyCapped(request(null), CAP);
    expect(res.ok && res.bytes.length).toBe(0);
  });

  it('counts bytes, not characters (multi-byte text is not under-counted)', async () => {
    const encoded = new TextEncoder().encode('é'.repeat(600)); // 1200 bytes, 600 characters
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    expect((await readBodyCapped(request(body), CAP)).ok).toBe(false);
  });
});
