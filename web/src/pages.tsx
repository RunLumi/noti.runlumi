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
  IconPlus,
  IconSettings,
  IconShieldCheck,
  IconUsers,
  IconWebhook,
  IconBolt,
} from '@tabler/icons-react';
import { authApi } from './lib/api';
import { Badge, Button, Card, Input, Notice } from './components/ui';
const privatePaths = ['/', '/integrations', '/activity', '/team', '/settings', '/onboarding'];
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
        <p>Loading your workspace…</p>
      </div>
    );
  if (me.isError) return null;
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link to="/" className="logo-link">
          <Logo />
        </Link>
        <div className="workspace">
          <div className="workspace-icon">N</div>
          <div>
            <b>{me.data.user.org_name || 'Setup workspace'}</b>
            <small>Organization</small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {[
            { to: '/', icon: IconLayoutDashboard, label: 'Overview' },
            { to: '/integrations', icon: IconWebhook, label: 'Integrations' },
            { to: '/activity', icon: IconActivity, label: 'Activity' },
            { to: '/team', icon: IconUsers, label: 'Team' },
            { to: '/settings', icon: IconSettings, label: 'Settings' },
          ].map((item) => (
            <Link
              key={item.to}
              to={item.to as '/'}
              activeOptions={{ exact: true }}
              aria-current={pathname === item.to ? 'page' : undefined}
              className={'nav-link ' + (section === item.to ? 'selected' : '')}
            >
              <item.icon size={18} />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="avatar">{me.data.user.email[0].toUpperCase()}</div>
          <div className="user-meta">
            <b>{me.data.user.email}</b>
            <small>{me.data.user.role}</small>
          </div>
        </div>
      </aside>
      <main className="main" id="main-content" tabIndex={-1}>
        <header className="topbar">
          <span>
            Workspace <IconChevronRight size={14} aria-hidden="true" />{' '}
            {section === '/' ? 'Overview' : section.slice(1)}
          </span>
          <Badge variant="neutral">Preview</Badge>
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
        eyebrow="WORKSPACE"
        title="Your notifications, in one place"
        description="Connect your tools, reduce noise, and keep the right people in the loop."
        action={
          <Link to="/integrations/new" className="btn btn-primary">
            <IconPlus size={16} /> New integration
          </Link>
        }
      />
      <div className="stats">
        <IntegrationsStat />
        <DeliveryStats />
      </div>
      <div className="two-col">
        <Card className="panel">
          <h2>Get started</h2>
          <div className="step">
            <span>01</span>
            <div>
              <b>Choose a repository</b>
              <p>Pick one of the GitHub repositories you allowed Noti to see.</p>
            </div>
          </div>
          <div className="step">
            <span>02</span>
            <div>
              <b>Choose a destination</b>
              <p>
                Paste a Lark, Slack or Teams webhook URL in the integration setup. It is stored encrypted.
              </p>
            </div>
          </div>
          <div className="step">
            <span>03</span>
            <div>
              <b>Connect GitHub</b>
              <p>
                Installing the Noti GitHub App from the dashboard and sending a test message are still in
                development.
              </p>
            </div>
          </div>
        </Card>
        <Card className="panel">
          <h2>Built for clarity</h2>
          <p className="muted">Every event should reach the right team without flooding their channels.</p>
          <div className="benefit">
            <IconShieldCheck size={20} />
            <div>
              <b>Private by design</b>
              <p>Workspace isolation and secure credentials are required for launch.</p>
            </div>
          </div>
          <div className="benefit">
            <IconBell size={20} />
            <div>
              <b>Useful, not noisy</b>
              <p>Filter by event type and destination.</p>
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
      <Header eyebrow="PREFERENCES" title="Settings" description="Your account and workspace preferences." />
      <Card className="panel">
        <h2>Account</h2>
        <div className="setting-row">
          <span>Email address</span>
          <b>{me.data?.user.email}</b>
        </div>
        <div className="setting-row">
          <span>Role</span>
          <Badge>{me.data?.user.role || 'member'}</Badge>
        </div>
        <div className="setting-row">
          <span>Authentication</span>
          <span>Password and passkeys</span>
        </div>
        <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
          <IconLogout size={16} /> Sign out
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
      <div className="auth-brand">
        <Logo />
        <div className="auth-hero">
          <span className="hero-pill">NOTIFICATIONS, SIMPLIFIED</span>
          <h1>
            Less noise.
            <br />
            More signal.
          </h1>
          <p>
            Route GitHub updates to your team. Lark and Slack delivery are in prototype; connection setup is
            still in development.
          </p>
          <div className="hero-flow" aria-label="Illustrative notification route">
            <span>GitHub</span>
            <IconArrowRight size={18} />
            <span className="flow-core">
              <IconBolt size={16} /> Noti
            </span>
            <IconArrowRight size={18} />
            <span>Lark · Slack</span>
          </div>
          <p className="flow-caption">Illustrative route · Backend prototype</p>
        </div>
        <small>Part of the Lumi ecosystem. Built to work on its own.</small>
      </div>
      <div className="auth-side">
        <div className="auth-box">
          <h1>{title}</h1>
          <p className="muted">{description}</p>
          {children}
        </div>
        <p className="auth-footer">© Lumi Noti · Secure workspace notifications</p>
      </div>
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
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame
      title={signup ? 'Create your account' : forgot ? 'Reset your password' : 'Welcome back'}
      description={
        signup
          ? 'Get started with Lumi Noti. Verify your email before signing in.'
          : forgot
            ? 'We will send a reset link if an account exists.'
            : 'Sign in to manage your notifications.'
      }
    >
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        {signup && (
          <label>
            Your name
            <Input
              required
              maxLength={100}
              autoComplete="name"
              placeholder="Your name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
          </label>
        )}
        <label>
          Work email
          <Input
            required
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {!forgot && (
          <label>
            Password
            <Input
              required
              type="password"
              minLength={signup ? 12 : undefined}
              maxLength={128}
              autoComplete={signup ? 'new-password' : 'current-password'}
              placeholder={signup ? 'At least 12 characters' : 'Your password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice>{message}</Notice>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : signup ? 'Create account' : forgot ? 'Send reset link' : 'Sign in'}{' '}
          <IconArrowRight size={16} />
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
                setError(e instanceof Error ? e.message : 'Passkey sign-in failed');
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          Sign in with passkey
        </button>
      )}
      {!signup && !forgot && (
        <div className="auth-links">
          <Link to="/forgot-password">Forgot password?</Link>
          <span>
            New to Noti? <Link to="/signup">Create account</Link>
          </span>
        </div>
      )}
      {signup && (
        <p className="auth-switch">
          Already have an account? <Link to="/signin">Sign in</Link>
        </p>
      )}
      {forgot && (
        <p className="auth-switch">
          <Link to="/signin">Back to sign in</Link>
        </p>
      )}
      {!forgot && (
        <p className="passkey-note">
          <IconShieldCheck size={16} /> Passkeys are available after registering one in Settings on a verified
          account.
        </p>
      )}
    </AuthFrame>
  );
}
export function VerifyPage() {
  const [message, setMessage] = useState('Verifying your email…'),
    [error, setError] = useState(false);
  useEffect(() => {
    const token = new URLSearchParams(location.search).get('token');
    if (!token) {
      setError(true);
      setMessage('Missing verification token');
      return;
    }
    void authApi
      .verify(token)
      .then(() => setMessage('Email verified. You can now sign in.'))
      .catch((e) => {
        setError(true);
        setMessage(e instanceof Error ? e.message : 'Verification failed');
      });
  }, []);
  return (
    <AuthFrame title="Email verification" description="Confirming your email address">
      <Notice kind={error ? 'error' : 'info'}>{message}</Notice>
      <p className="auth-switch">
        <Link to="/signin">Go to sign in</Link>
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
      setMessage('Password updated. Sign in with your new password.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthFrame title="Choose a new password" description="Use at least 12 characters.">
      <form className="auth-form" onSubmit={(e) => void submit(e)}>
        <label>
          New password
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
          Update password
        </Button>
      </form>
      <p className="auth-switch">
        <Link to="/signin">Back to sign in</Link>
      </p>
    </AuthFrame>
  );
}
