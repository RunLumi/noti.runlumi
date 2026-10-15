import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { IconUserPlus, IconUsers, IconLogout } from '@tabler/icons-react';
import { authClient, assertAuthSuccess } from './lib/auth-client';
import { api, authApi } from './lib/api';
import { Badge, Button, Card, Input } from './components/ui';
import { t } from './i18n';
import { dropOtherWorkspaces } from './workspace/switching';
import { roleLabel } from './lib/role-label';
import { useLocale } from './i18n/LocaleProvider';
import { PendingInvitations } from './team/PendingInvitations';

/** Query key for a workspace's member list. */
export const teamKey = (orgId: string) => ['team', orgId] as const;

type Member = {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  createdAt: string;
};
export function TeamManagement() {
  useLocale();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const orgId = me.data?.user.org_id;
  // Keyed by workspace and asked for by name, so a switch can never show the other one's members.
  const team = useQuery({
    queryKey: teamKey(orgId ?? ''),
    queryFn: () => api<{ members: Member[] }>(`/api/workspace/team?org=${encodeURIComponent(orgId ?? '')}`),
    enabled: Boolean(orgId),
  });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const isAdmin = me.data?.user.role === 'admin';
  const refresh = () => qc.invalidateQueries({ queryKey: teamKey(orgId ?? '') });

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      assertAuthSuccess(
        await authClient.organization.inviteMember({
          email: email.trim().toLowerCase(),
          role,
          organizationId: orgId,
        }),
      );
      setEmail('');
      setMessage(t('team.invite.sent'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.invite.error'));
    } finally {
      setBusy(false);
    }
  }
  async function changeRole(memberId: string, newRole: 'admin' | 'member') {
    if (!orgId) return;
    setError('');
    try {
      assertAuthSuccess(
        await authClient.organization.updateMemberRole({
          memberId,
          role: newRole,
          organizationId: orgId,
        }),
      );
      await refresh();
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.members.roleError'));
    }
  }
  async function remove(memberId: string) {
    if (!orgId || !window.confirm(t('team.members.removeConfirm'))) return;
    setError('');
    try {
      assertAuthSuccess(
        await authClient.organization.removeMember({
          memberIdOrEmail: memberId,
          organizationId: orgId,
        }),
      );
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.members.removeError'));
    }
  }
  async function leave() {
    if (!orgId || !window.confirm(t('team.membership.leaveConfirm'))) return;
    setError('');
    try {
      assertAuthSuccess(await authClient.organization.leave({ organizationId: orgId }));
      // Whatever workspace they still have becomes active; with none, the shell opens onboarding.
      dropOtherWorkspaces(qc, '');
      await qc.invalidateQueries({ queryKey: ['me'] });
      await navigate({ to: '/' });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('team.membership.leaveError'));
    }
  }
  return (
    <div className="team-management">
      <header className="page-header">
        <div>
          <p className="eyebrow">{t('team.eyebrow')}</p>
          <h1>{t('team.title')}</h1>
          <p className="muted">{t('team.description')}</p>
        </div>
      </header>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {isAdmin && (
        <Card className="panel">
          <h2>
            <IconUserPlus size={19} aria-hidden="true" /> {t('team.invite.title')}
          </h2>
          <form className="invite-form" onSubmit={(e) => void invite(e)}>
            <label className="grow">
              {t('team.invite.email')}
              <Input
                required
                type="email"
                value={email}
                placeholder={t('team.invite.emailPlaceholder')}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              {t('team.invite.role')}
              <select
                className="input"
                value={role}
                onChange={(e) => setRole(e.target.value as 'admin' | 'member')}
              >
                <option value="member">{t('role.member')}</option>
                <option value="admin">{t('role.admin')}</option>
              </select>
            </label>
            <Button disabled={busy || !email.trim()} type="submit">
              {busy ? t('team.invite.sending') : t('team.invite.submit')}
            </Button>
          </form>
        </Card>
      )}
      <Card className="panel" style={{ marginTop: 20 }}>
        <h2>
          <IconUsers size={19} aria-hidden="true" /> {t('team.members.title')}
        </h2>
        {team.isLoading ? (
          <p>{t('team.members.loading')}</p>
        ) : team.isError ? (
          <p role="alert">{t('team.members.error')}</p>
        ) : (
          team.data?.members.map((m) => (
            <div className="team-entry" key={m.id}>
              <div className="avatar" aria-hidden="true">
                {(m.name || m.email)[0].toUpperCase()}
              </div>
              <div className="grow">
                <strong>{m.name || m.email}</strong>
                <p className="muted">{m.email}</p>
              </div>
              {isAdmin && m.userId !== me.data?.user.id ? (
                <select
                  aria-label={t('team.members.roleFor', { email: m.email })}
                  className="role-select"
                  value={m.role}
                  onChange={(e) => void changeRole(m.id, e.target.value as 'admin' | 'member')}
                >
                  <option value="member">{t('role.member')}</option>
                  <option value="admin">{t('role.admin')}</option>
                </select>
              ) : (
                <Badge>{roleLabel(m.role)}</Badge>
              )}
              {isAdmin && m.userId !== me.data?.user.id && (
                <Button
                  variant="ghost"
                  aria-label={t('team.members.removeFor', { email: m.email })}
                  onClick={() => void remove(m.id)}
                >
                  {t('team.members.remove')}
                </Button>
              )}
            </div>
          ))
        )}
      </Card>
      {isAdmin && orgId && <PendingInvitations orgId={orgId} />}
      <Card className="panel" style={{ marginTop: 20 }}>
        <h2>{t('team.membership.title')}</h2>
        <p className="muted">{t('team.membership.body')}</p>
        <Button variant="outline" onClick={() => void leave()}>
          <IconLogout size={16} aria-hidden="true" /> {t('team.membership.leave')}
        </Button>
      </Card>
    </div>
  );
}
