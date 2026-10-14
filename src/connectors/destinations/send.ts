import { classifyTransportError, permanent } from './classify';
import { checkDestinationUrl, type UrlPolicyOptions } from './url-policy';
import type { ClassifiedResponse, OutboundRequest, ProviderResponse } from './types';

/**
 * The only place destination network I/O happens (F91). The URL policy is re-checked here
 * as defence in depth: a stored row can be altered after it was validated (F96). Redirects
 * are never followed.
 */

/** Classifiers only ever need a short code; reading more invites echoing secrets. */
export const MAX_CLASSIFIED_BODY_BYTES = 2048;
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
export type ResponseClassifier = (res: ProviderResponse, now: number) => ClassifiedResponse;

export interface SendOptions {
  readonly fetch?: Fetcher;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  /** Deployment-specific URL policy, re-applied here exactly as at write time. */
  readonly urlPolicy?: UrlPolicyOptions;
}

/** Read at most `maxBytes` of the body, then cancel the rest of the stream. */
export async function readBodyPrefix(res: Response, maxBytes = MAX_CLASSIFIED_BODY_BYTES): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined.subarray(0, maxBytes));
}

export async function sendRequest(
  request: OutboundRequest,
  classify: ResponseClassifier,
  options: SendOptions = {},
): Promise<ClassifiedResponse> {
  if (!checkDestinationUrl(request.kind, request.url, options.urlPolicy).ok)
    return permanent('destination_url_rejected');
  // EGRESS-ALLOWED: the only outbound request to a customer-configured URL (F228). The policy
  // check above and this call are one function, so nothing can change between check and use;
  // tests/security/egress.test.ts fails if another module issues a request.
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  try {
    const res = await doFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 'manual' rather than 'error': the 3xx is returned unfollowed, so it can be classified
      // as a permanent `destination_redirected` instead of an ambiguous network TypeError.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
    });
    // The status is already known. A body that errors or stalls after a 2xx must not turn a
    // delivered message into a retry (a duplicate), so the read is guarded on its own.
    let bodyText = '';
    try {
      bodyText = await readBodyPrefix(res);
    } catch {
      bodyText = '';
    }
    return classify({ status: res.status, headers: res.headers, bodyText }, now());
  } catch (e: unknown) {
    return classifyTransportError(e);
  }
}
