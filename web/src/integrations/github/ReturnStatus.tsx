import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Notice } from '../../components/ui';
import { t, type MessageId } from '../../i18n';

/** Every status the server's `/github/callback` and `/github/setup` can return (docs/API.md). */
const RETURN_MESSAGES = {
  connected: 'github.return.connected',
  state_invalid: 'github.return.state_invalid',
  state_user_mismatch: 'github.return.state_user_mismatch',
  installation_id_invalid: 'github.return.installation_id_invalid',
  oauth_failed: 'github.return.oauth_failed',
  installation_not_accessible: 'github.return.installation_not_accessible',
  installation_admin_required: 'github.return.installation_admin_required',
  installation_bound_elsewhere: 'github.return.installation_bound_elsewhere',
  installation_deleted: 'github.return.installation_deleted',
  installation_too_large: 'github.return.installation_too_large',
  workspace_access_lost: 'github.return.workspace_access_lost',
  github_unavailable: 'github.return.github_unavailable',
  not_configured: 'github.return.not_configured',
  signin_required: 'github.return.signin_required',
  unexpected_error: 'github.return.unexpected_error',
} as const satisfies Record<string, MessageId>;

export type ReturnStatusCode = keyof typeof RETURN_MESSAGES;

export function returnMessage(code: string | null): { id: MessageId; ok: boolean } | null {
  if (code === null) return null;
  // An unknown value is still an outcome the person should hear about, never silence.
  const id = Object.hasOwn(RETURN_MESSAGES, code)
    ? RETURN_MESSAGES[code as ReturnStatusCode]
    : 'github.return.unexpected_error';
  return { id, ok: code === 'connected' };
}

/**
 * Reads `?github=<status>` once, explains it in plain words, and removes it from the address
 * bar (`history.replaceState`) so a reload or a shared link does not repeat it.
 */
export function GithubReturnStatus({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [message] = useState(() => returnMessage(new URLSearchParams(window.location.search).get('github')));
  useEffect(() => {
    if (!message) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('github');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    void qc.invalidateQueries({ queryKey: ['github', orgId] });
  }, [message, qc, orgId]);
  if (!message) return null;
  return (
    <Notice kind={message.ok ? 'success' : 'error'}>
      <p>{t(message.id)}</p>
      {message.ok && (
        <p>
          <Link to="/integrations/new" className="text-link">
            {t('github.return.next')}
          </Link>
        </p>
      )}
    </Notice>
  );
}
