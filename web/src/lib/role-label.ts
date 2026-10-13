import { t } from '../i18n';

/** Display name for a workspace role. Anyone without an explicit admin role is a member. */
export function roleLabel(role: string | null | undefined): string {
  return t(role === 'admin' ? 'role.admin' : 'role.member');
}
