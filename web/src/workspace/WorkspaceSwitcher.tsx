import { useState } from 'react';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { Menu } from '@base-ui/react/menu';
import { IconCheck, IconPlus, IconSelector } from '@tabler/icons-react';
import type { Me } from '../lib/api';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { getLocale } from '../i18n/locale';
import { roleLabel } from '../lib/role-label';
import { useSwitchWorkspace } from './switching';
import './switcher.css';

type User = Me['user'];

/** A sub-page of a workspace's data that means nothing in another workspace. */
function pathAfterSwitch(pathname: string): string | null {
  // `/integrations/<id>` and `/integrations/new` belong to the workspace just left.
  if (pathname.startsWith('/integrations/')) return '/integrations';
  // A source's or a delivery's page names a row of the workspace just left (ADR 0056).
  if (pathname.startsWith('/sources/')) return '/sources';
  if (pathname.startsWith('/activity/')) return '/activity';
  return null;
}

function Monogram({ name }: { readonly name: string }) {
  useLocale();
  return (
    <div className="workspace-icon" aria-hidden="true">
      {(name.trim()[0] ?? 'N').toUpperCase()}
    </div>
  );
}

function Label({ name, role }: { readonly name: string; readonly role: string | null }) {
  useLocale();
  return (
    <span className="workspace-text">
      <b>{name}</b>
      <small>{roleLabel(role)}</small>
    </span>
  );
}

/**
 * The sidebar's workspace control.
 *
 *  - Several workspaces: a menu button naming the current one and the person's role in it, with
 *    a radio list of every workspace they belong to and a "Create workspace" entry. Base UI's
 *    menu supplies the keyboard model (arrows, Home/End, type-ahead, Escape, focus return).
 *  - One workspace: a plain label, plus a link to create another.
 *  - None: nothing (the shell sends the person to onboarding).
 *
 * The switch is announced in a polite live region that belongs to this control, because the
 * page does not change path and so nothing else would speak.
 */
export function WorkspaceSwitcher({ user }: { readonly user: User }) {
  useLocale();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [announcement, setAnnouncement] = useState('');
  const [open, setOpen] = useState(false);
  const switcher = useSwitchWorkspace((active) => {
    setAnnouncement(
      t('switcher.changed', { name: active.orgName, role: roleLabel(active.role) }) +
        (announcement.endsWith('\u00a0') ? '' : '\u00a0'),
    );
    const next = pathAfterSwitch(pathname);
    if (next) void navigate({ to: next as '/integrations' });
    // The activity filters can name an integration of the workspace just left.
    else if (pathname === '/activity') void navigate({ to: '/activity', search: {}, replace: true });
  });

  // By name, in the reader's language, so the list never reshuffles between visits.
  const orgs = [...user.organizations].sort((a, b) => a.name.localeCompare(b.name, getLocale()));
  if (orgs.length === 0 || !user.org_id) return null;

  const current = orgs.find((o) => o.orgId === user.org_id);
  const name = current?.name ?? user.org_name ?? t('shell.workspaceFallback');
  const role = current?.role ?? user.role;

  const status = (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </div>
  );

  if (orgs.length === 1)
    return (
      <div className="workspace-switcher">
        <div className="workspace">
          <Monogram name={name} />
          <Label name={name} role={role} />
        </div>
        <Link to="/onboarding" className="workspace-create">
          <IconPlus size={16} aria-hidden="true" /> {t('switcher.createAnother')}
        </Link>
        {status}
      </div>
    );

  return (
    <div className="workspace-switcher">
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          className="workspace workspace-trigger"
          aria-label={t('switcher.trigger', { name, role: roleLabel(role) })}
          disabled={switcher.isPending}
        >
          <Monogram name={name} />
          <Label name={name} role={role} />
          <IconSelector size={18} aria-hidden="true" className="workspace-chevron" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={6} align="start" className="menu-positioner">
            <Menu.Popup className="menu-popup">
              <Menu.Group>
                <Menu.GroupLabel className="menu-label">{t('switcher.heading')}</Menu.GroupLabel>
                <Menu.RadioGroup
                  value={user.org_id}
                  onValueChange={(value: string) => {
                    if (value !== user.org_id) switcher.mutate(value);
                  }}
                >
                  {orgs.map((org) => (
                    <Menu.RadioItem key={org.orgId} value={org.orgId} className="menu-item" closeOnClick>
                      <span className="menu-check" aria-hidden="true">
                        <Menu.RadioItemIndicator keepMounted={false}>
                          <IconCheck size={16} />
                        </Menu.RadioItemIndicator>
                      </span>
                      <Label name={org.name} role={org.role} />
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </Menu.Group>
              <Menu.Separator className="menu-separator" />
              <Menu.Item className="menu-item" onClick={() => void navigate({ to: '/onboarding' })}>
                <span className="menu-check" aria-hidden="true">
                  <IconPlus size={16} />
                </span>
                <span className="workspace-text">
                  <b>{t('switcher.create')}</b>
                </span>
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {switcher.isError && (
        <p role="alert" className="workspace-error">
          {t('switcher.error', { name })}
        </p>
      )}
      {status}
    </div>
  );
}
