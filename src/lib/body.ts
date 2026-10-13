/**
 * Bounded request-body reader (security review M1).
 *
 * `request.text()` and `request.arrayBuffer()` buffer the whole body before any size check
 * can run, and `Content-Length` is attacker controlled: it may be absent (chunked), wrong or
 * not a number. This reader counts the bytes it actually receives from `request.body` and
 * stops at `maxBytes + 1`, so memory and CPU spent on an oversize or lying request are
 * bounded by the cap, not by what the sender chooses to send.
 *
 * A declared length is only a fast path: a finite, non-negative integer above the cap is
 * refused without reading. A missing, empty, non-numeric, negative or fractional value is
 * treated as unknown and the stream is counted instead. A declared length below the cap is
 * never trusted; the bytes read are what count.
 */
export type BodyRead =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | { readonly ok: false; readonly reason: 'too_large' };

const DIGITS = /^\d{1,15}$/;

/** The declared length, or null when absent or malformed ("unknown"). */
export function declaredLength(header: string | null | undefined): number | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  return DIGITS.test(trimmed) ? Number(trimmed) : null;
}

export async function readBodyCapped(
  request: Pick<Request, 'body' | 'headers'>,
  maxBytes: number,
): Promise<BodyRead> {
  const declared = declaredLength(request.headers.get('content-length'));
  if (declared !== null && declared > maxBytes) {
    // Do not read: release the stream so the runtime can discard it.
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'too_large' };
  }
  const stream = request.body;
  if (!stream) return { ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
