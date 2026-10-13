export type DestinationKind = 'lark' | 'slack';

/**
 * Outbound SSRF guard, applied at write time (D9) and again before every send. The platform
 * does not filter egress, so this allowlist is ours to maintain; `redirect: 'error'` on the
 * fetch is the second half of the control.
 */
export function destinationAllowed(url: URL, destination: DestinationKind): boolean {
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password || url.port) return false;
  return destination === 'slack'
    ? url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/')
    : ['open.larksuite.com', 'open.feishu.cn'].includes(url.hostname) &&
        url.pathname.startsWith('/open-apis/bot/v2/hook/');
}
