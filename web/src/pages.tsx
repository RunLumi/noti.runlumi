import lumiLogo from '../../brand/lumi-fulltext.svg';
import { TeamManagement } from './team';
import { PasskeysPanel } from './passkeys';
import { IntegrationsStat } from './integrations/IntegrationsStat';
import { DeliveryStats } from './deliveries/DeliveryStats';
import { DeliveryLogPage } from './deliveries/DeliveryLogPage';
import { WorkspaceDataPanel } from './workspace/WorkspaceDataPanel';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IconActivity,
  IconArrowRight,
  IconBell,
  IconChevronRight,
  IconLayoutDashboard,
  IconLogout,
  IconPlugConnected,
  IconPlus,
  IconSettings,
  IconShieldCheck,
  IconUsers,
  IconWebhook,
  IconBolt,
} from '@tabler/icons-react';
import { authApi } from './lib/api';
import { Badge, Button, Card, Input, Notice } from './components/ui';
import { t } from './i18n';
import { LocaleSwitcher } from './i18n/LocaleSwitcher';
import { RouteA11y } from './a11y/RouteA11y';
import { SkipLink } from './a11y/SkipLink';
import { routeTitleId } from './a11y/route-titles';
import { roleLabel } from './lib/role-label';
const privatePaths = ['/', '/integrations', '/sources', '/activity', '/team', '/settings', '/onboarding'];
/** `/integrations/new` and `/integrations/:id` live under the Integrations section. */
const sectionOf = (pathname: string) => '/' + (pathname.split('/')[1] ?? '');
function Logo() {
  return (
    <div className="brand">
      <img className="brand-logo" src={lumiLogo} alt="Lumi" />
      <span className="brand-product">Noti</span>
    </div>
  );
}
export function AppShell() {
  return (
    <>
      <RouteA11y />
      <ShellContent />
    </>
  );
}
function ShellContent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const section = sectionOf(pathname);
  const isPrivate = privatePaths.includes(section);
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me, retry: false, enabled: isPrivate });
  const nav = useNavigate();
  useEffect(() => {
    if (!isPrivate || me.isPending) return;
    if (me.isError) {
      void nav({ to: '/signin' });
      return;
    }
    if (me.data && !me.data.user.org_id && pathname !== '/onboarding') {
      void nav({ to: '/onboarding' });
      return;
    }
    if (me.data?.user.org_id && pathname === '/onboarding') void nav({ to: '/' });
  }, [isPrivate, me.isPending, me.isError, me.data, pathname, nav]);
  if (!isPrivate) return <Outlet />;
  if (me.isPending)
    return (
      <div className="center-screen">
        <Logo />
        <p>{t('shell.loading')}</p>
      </div>
    );
  if (me.isError) return null;
  return (
    <div className="app">
      <SkipLink />
      <aside className="sidebar">
        <Link to="/" className="logo-link">
          <Logo />
        </Link>
        <div className="workspace">
          <div className="workspace-icon">N</div>
          <div>
            <b>{me.data.user.org_name || t('shell.workspaceFallback')}</b>
            <small>{t('shell.workspaceKind')}</small>
          </div>
        </div>
        <nav aria-label={t('shell.navLabel')}>
          {[
            { to: '/', icon: IconLayoutDashboard, label: t('nav.overview') },
            { to: '/integrations', icon: IconWebhook, label: t('nav.integrations') },
            { to: '/sources', icon: IconPlugConnected, label: t('sources.nav') },
            { to: '/activity', icon: IconActivity, label: t('nav.activity') },
            { to: '/team', icon: IconUsers, label: t('nav.team') },
            { to: '/settings', icon: IconSettings, label: t('nav.settings') },
          ].map((item) => (
            <Link
              key={item.to}
              to={item.to as '/'}
              activeOptions={{ exact: true }}
              aria-current={pathname === item.to ? 'page' : undefined}
              className={'nav-link ' + (section === item.to ? 'selected' : '')}
            >
              <item.icon size={18} aria-hidden="true" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-locale">
          <LocaleSwitcher />
        </div>
        <div className="sidebar-bottom">
          <div className="avatar" aria-hidden="true">
            {me.data.user.email[0].toUpperCase()}
          </div>
          <div className="user-meta">
            <b>{me.data.user.email}</b>
            <small>{roleLabel(me.data.user.role)}</small>
          </div>
        </div>
      </aside>
      <main className="main" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <span>
            {t('shell.breadcrumbRoot')} <IconChevronRight size={14} aria-hidden="true" />{' '}
            {t(routeTitleId(section))}
          </span>
          <Badge variant="neutral">{t('shell.preview')}</Badge>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
function Header({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Overview() {
  return (
    <>
      <Header
        eyebrow={t('home.eyebrow')}
        title={t('home.title')}
        description={t('home.description')}
        action={
          <Link to="/integrations/new" className="btn btn-primary">
            <IconPlus size={16} aria-hidden="true" /> {t('home.newIntegration')}
          </Link>
        }
      />
      <div className="stats">
        <IntegrationsStat />
        <DeliveryStats />
      </div>
      <div className="two-col">
        <Card className="panel">
          <h2>{t('home.start.title')}</h2>
          <div className="step">
            <span>01</span>
            <div>
              <b>{t('home.start.step1.title')}</b>
              <p>{t('home.start.step1.body')}</p>
            </div>
          </div>
          <div className="step">
            <span>02</span>
            <div>
              <b>{t('home.start.step2.title')}</b>
              <p>{t('home.start.step2.body')}</p>
            </div>
          </div>
          <div className="step">
            <span>03</span>
            <div>
              <b>{t('home.start.step3.title')}</b>
              <p>{t('home.start.step3.body')}</p>
            </div>
          </div>
        </Card>
        <Card className="panel">
          <h2>{t('home.clarity.title')}</h2>
          <p className="muted">{t('home.clarity.body')}</p>
          <div className="benefit">
            <IconShieldCheck size={20} aria-hidden="true" />
            <div>
              <b>{t('home.clarity.private.title')}</b>
              <p>{t('home.clarity.private.body')}</p>
            </div>
          </div>
          <div className="benefit">
            <IconBell size={20} aria-hidden="true" />
            <div>
              <b>{t('home.clarity.useful.title')}</b>
              <p>{t('home.clarity.useful.body')}</p>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
export function Activity() {
  return <DeliveryLogPage />;
}
export function Team() {
  return <TeamManagement />;
}
export function Settings() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: authApi.me });
  const logout = useMutation({
    mutationFn: authApi.signout,
    onSettled: async () => {
      qc.clear();
      await nav({ to: '/signin' });
    },
  });
  return (
    <>
      <Header
        eyebrow={t('account.eyebrow')}
        title={t('account.title')}
        description={t('account.description')}
      />
      <Card className="panel">
        <h2>{t('account.panel')}</h2>
        <div className="setting-row">
          <span>{t('account.email')}</span>
          <b>{me.data?.user.email}</b>
        </div>
        <div className="setting-row">
          <span>{t('account.role')}</span>
          <Badge>{roleLabel(me.data?.user.role)}</Badge>
        </div>
        <div className="setting-row">
          <span>{t('account.auth')}</span>
          <span>{t('account.authValue')}</span>
        </div>
        <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <IconLogout size={16} aria-hidden="true" /> {t('account.signOut')}
        </Button>
      </Card>
      <PasskeysPanel />
      <WorkspaceDataPanel />
    </>
  );
}
function AuthFrame({
  children,
  title,
  description,
}: {
  children: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="auth-layout">
      <SkipLink />
      <aside className="auth-brand" aria-label="Lumi Noti">
        <Logo />
        <div className="auth-hero">
          <span className="hero-pill">{t('auth.hero.pill')}</span>
          <h1>
            {t('auth.hero.line1')}
            <br />
            {t('auth.hero.line2')}
          </h1>
          <p>{t('auth.hero.body')}</p>
          <div className="hero-flow" role="group" aria-label={t('auth.hero.flowLabel')}>
            <span>GitHub</span>
            <IconArrowRight size={18} aria-hidden="true" />
            <span className="flow-core">
              <IconBolt size={16} aria-hidden="true" /> Noti
            </span>
            <IconArrowRight size={18} aria-hidden="true" />
            <span>Lark · Slack</span>
          </div>
          <p className="flow-caption">{t('auth.hero.flowCaption')}</p>
        </div>
        <small>{t('auth.hero.ecosystem')}</small>
      </aside>
      <main className="auth-side" id="main-content" tabIndex={-1}>
        <div className="auth-locale">
          <LocaleSwitcher compact />
        </div>
        <div className="auth-box">
          <h1>{title}</h1>
          <p className="muted">{description}</p>
          {children}
        </div>
        <p className="auth-footer">{t('auth.footer')}</p>
      </main>
    </div>
  );
}
export function AuthPage({ mode }: { mode: 'signin' | 'signup' | 'forgot' }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [orgName, setOrgName] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const signup = mode === 'signup',
    forgot = mode === 'forgot';
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      if (signup) {
        const r = await authApi.signup(email, password, orgName);
        setMessage(r.message);
      } else if (forgot) {
        const r = await authApi.forgot(email);
        setMessage(r.message);
      } else {
        await authApi.signin(email, password);
        await qc.invalidateQueries({ queryKey: ['me'] });
        const back = new URLSearchParams(window.location.search).get('returnTo');
        if (back?.startsWith('/invite?id=')) window.location.assign(back);
        else await nav({ to: '/' });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('auth.error.generic'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame
      title={t(signup ? 'auth.signup.title' : forgot ? 'auth.forgot.title' : 'auth.signin.title')}
      description={t(
        signup ? 'auth.signup.description' : forgot ? 'auth.forgot.description' : 'auth.signin.description',
      )}
    >
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        {signup && (
          <label>
            {t('auth.field.name')}
            <Input
              required
              maxLength={100}
              autoComplete="name"
              placeholder={t('auth.field.namePlaceholder')}
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </label>
        )}
        <label>
          {t('auth.field.email')}
          <Input
            required
            type="email"
            autoComplete="email"
            placeholder={t('auth.field.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {!forgot && (
          <label>
            {t('auth.field.password')}
            <Input
              required
              type="password"
              minLength={signup ? 12 : undefined}
              maxLength={128}
              autoComplete={signup ? 'new-password' : 'current-password'}
              placeholder={t(signup ? 'auth.field.passwordNewPlaceholder' : 'auth.field.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        <Button type="submit" disabled={busy}>
          {busy
            ? t('auth.busy')
            : t(signup ? 'auth.submit.signup' : forgot ? 'auth.submit.forgot' : 'auth.submit.signin')}{' '}
          <IconArrowRight size={16} aria-hidden="true" />
        </Button>
      </form>
      {!signup && !forgot && (
        <button
          type="button"
          className="btn btn-outline"
          style={{ width: '100%', marginTop: 13 }}
          disabled={busy}
          onClick={() => {
            void (async () => {
              setError('');
              setBusy(true);
              try {
                await authApi.signinPasskey();
                await qc.invalidateQueries({ queryKey: ['me'] });
                const back = new URLSearchParams(window.location.search).get('returnTo');
                if (back?.startsWith('/invite?id=')) window.location.assign(back);
                else await nav({ to: '/' });
              } catch (e) {
                setError(e instanceof Error ? e.message : t('auth.error.passkey'));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {t('auth.passkey')}
        </button>
      )}
      {!signup && !forgot && (
        <div className="auth-links">
          <Link to="/forgot-password">{t('auth.forgotLink')}</Link>
          <span>
            {t('auth.newToNoti')} <Link to="/signup">{t('auth.createAccountLink')}</Link>
          </span>
        </div>
      )}
      {signup && (
        <p className="auth-switch">
          {t('auth.haveAccount')} <Link to="/signin">{t('auth.signinLink')}</Link>
        </p>
      )}
      {forgot && (
        <p className="auth-switch">
          <Link to="/signin">{t('auth.backToSignin')}</Link>
        </p>
      )}
      {!forgot && (
        <p className="passkey-note">
          <IconShieldCheck size={16} aria-hidden="true" /> {t('auth.passkeyNote')}
        </p>
      )}
    </AuthFrame>
  );
}
export function VerifyPage() {
  const [message, setMessage] = useState(t('auth.verify.pending')),
    [error, setError] = useState(false);
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token');
    if (!token) {
      setError(true);
      setMessage(t('auth.verify.missingToken'));
      return;
    }
    void authApi
      .verify(token)
      .then(() => setMessage(t('auth.verify.done')))
      .catch((e) => {
        setError(true);
        setMessage(e instanceof Error ? e.message : t('auth.verify.failed'));
      });
  }, []);
  return (
    <AuthFrame title={t('auth.verify.title')} description={t('auth.verify.description')}>
      <Notice kind={error ? 'error' : 'info'}>{message}</Notice>
      <p className="auth-switch">
        <Link to="/signin">{t('auth.verify.toSignin')}</Link>
      </p>
    </AuthFrame>
  );
}
export function ResetPage() {
  const token = new URLSearchParams(location.search).get('token') || '';
  const [password, setPassword] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await authApi.reset(token, password);
      setMessage(t('auth.reset.done'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('auth.reset.failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title={t('auth.reset.title')} description={t('auth.reset.description')}>
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <label>
          {t('auth.reset.field')}
          <Input
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        <Button disabled={!token || busy} type="submit">
          {t('auth.reset.submit')}
        </Button>
      </form>
      <p className="auth-switch">
        <Link to="/signin">{t('auth.backToSignin')}</Link>
      </p>
    </AuthFrame>
  );
}
