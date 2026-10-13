import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconBuilding, IconUserPlus } from '@tabler/icons-react';
import { authClient, assertAuthSuccess } from './lib/auth-client';
import { authApi } from './lib/api';
import { adoptWorkspace } from './workspace/switching';
import { Card, Button, Input } from './components/ui';
import { t } from './i18n';
import { useLocale } from './i18n/LocaleProvider';

function slug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 36) || 'team'
  );
}
export function OnboardingPage() {
  useLocale();
  const nav = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  // A person who already has a workspace can add another from the switcher; the page then
  // offers a way back instead of being a one-way first-run step.
  const additional = (me.data?.user.organizations.length ?? 0) > 0;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    let created: { id?: string } | null | undefined;
    try {
      created = assertAuthSuccess(
        await authClient.organization.create({
          name: name.trim(),
          slug: slug(name) + '-' + crypto.randomUUID().slice(0, 8),
        }),
      );
    } catch (e) {
      // The workspace was NOT created: the form stays and the person may try again.
      setError(e instanceof Error ? e.message : t('onboarding.error'));
      setBusy(false);
      return;
    }
    // From here the workspace exists. Nothing below may show an error that invites a retry,
    // because a retry would create a second workspace.
    try {
      if (created?.id) await adoptWorkspace(qc, created.id);
      else await qc.invalidateQueries({ queryKey: ['me'] });
    } finally {
      await nav({ to: '/' });
      setBusy(false);
    }
  }
  return (
    <div className="onboarding">
      <Card className="panel">
        <div className="empty-icon" aria-hidden="true">
          <IconBuilding />
        </div>
        <h1>{t(additional ? 'onboarding.titleAdditional' : 'onboarding.title')}</h1>
        <p className="muted">{t(additional ? 'onboarding.bodyAdditional' : 'onboarding.body')}</p>
        <form onSubmit={(e) => void submit(e)} className="auth-form">
          <label>
            {t('onboarding.field')}
            <Input
              required
              minLength={2}
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('onboarding.placeholder')}
            />
          </label>
          {error && (
            <p role="alert" className="text-error">
              {error}
            </p>
          )}
          <Button disabled={busy || name.trim().length < 2} type="submit">
            {busy ? t('onboarding.submitting') : t('onboarding.submit')}
          </Button>
        </form>
        {additional ? (
          <p>
            <Link to="/">{t('onboarding.cancel')}</Link>
          </p>
        ) : (
          <p className="muted">{t('onboarding.joinHint')}</p>
        )}
      </Card>
    </div>
  );
}

export function InvitePage() {
  useLocale();
  const id = new URLSearchParams(window.location.search).get('id');
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me, retry: false });
  const nav = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const loginRedirect = '/signin?returnTo=' + encodeURIComponent('/invite?id=' + (id || ''));
  async function accept() {
    if (!id) return;
    setError('');
    setBusy(true);
    try {
      const before = new Set(me.data?.user.organizations.map((o) => o.orgId));
      const joined = assertAuthSuccess(await authClient.organization.acceptInvitation({ invitationId: id }));
      // The invited workspace: named by the answer, else the one that is new in `me`.
      let orgId = joined?.member?.organizationId ?? joined?.invitation?.organizationId ?? null;
      if (!orgId) {
        const fresh = await qc.fetchQuery({ queryKey: ['me'], queryFn: authApi.me, staleTime: 0 });
        const added = fresh.user.organizations.filter((o) => !before.has(o.orgId));
        orgId = added.length === 1 ? (added[0]?.orgId ?? null) : null;
      }
      if (orgId) await adoptWorkspace(qc, orgId);
      else await qc.invalidateQueries({ queryKey: ['me'] });
      await nav({ to: '/' });
    } catch (e) {
      // Includes "already a member of that organization", shown as the server words it.
      setError(e instanceof Error ? e.message : t('invite.error'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="invite-screen">
      <Card className="panel">
        <div className="empty-icon" aria-hidden="true">
          <IconUserPlus />
        </div>
        <h1>{t('invite.title')}</h1>
        {!id ? (
          <p role="alert">{t('invite.missingId')}</p>
        ) : me.isPending ? (
          <p>{t('invite.checking')}</p>
        ) : me.isError ? (
          <>
            <p>{t('invite.signinBody')}</p>
            <a className="btn btn-primary" href={loginRedirect}>
              {t('invite.signinAction')}
            </a>
            <p>
              <Link to="/signup">{t('invite.signupLink')}</Link>
            </p>
          </>
        ) : (
          <>
            <p className="muted">{t('invite.signedInAs', { email: me.data.user.email })}</p>
            <Button disabled={busy} onClick={() => void accept()}>
              {busy ? t('invite.accepting') : t('invite.accept')}
            </Button>
          </>
        )}
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
      </Card>
    </div>
  );
}
