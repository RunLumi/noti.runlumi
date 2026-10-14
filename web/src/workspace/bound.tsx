import { useState } from 'react';
import { Notice } from '../components/ui';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';

/**
 * The workspace a form, wizard or dialog was opened for.
 *
 * Another tab can switch the session's active workspace while this one sits on a half-filled
 * form. The form must keep writing to the workspace it was opened for, or refuse, never to
 * "whatever is current now". `orgId` is therefore captured at mount and used for every request
 * the component makes (the server also requires `?org=` for people in several workspaces);
 * `stale` turns true once the live workspace differs, and the component disables its submit and
 * shows `StaleWorkspaceNotice`.
 */
export function useBoundWorkspace(live: string | null): {
  readonly orgId: string;
  readonly stale: boolean;
} {
  // First non-empty value wins, so a form mounted before `me` resolved still binds once.
  const [bound, setBound] = useState<string | null>(live);
  if (bound === null && live !== null) setBound(live);
  const orgId = bound ?? live ?? '';
  return { orgId, stale: bound !== null && live !== null && bound !== live };
}

export function StaleWorkspaceNotice({ show }: { readonly show: boolean }) {
  useLocale();
  if (!show) return null;
  return <Notice kind="error">{t('workspace.stale.form')}</Notice>;
}
