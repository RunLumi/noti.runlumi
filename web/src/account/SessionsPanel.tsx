import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDeviceDesktop, IconDeviceMobile, IconDeviceTablet } from '@tabler/icons-react';
import { SESSION_ABSOLUTE_SECONDS, SESSION_EXPIRES_IN_SECONDS } from '../../../src/auth/session-policy';
import { ApiError } from '../lib/api';
import { Badge, Button, Card, Notice } from '../components/ui';
import { t, tp } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { useLocale } from '../i18n/LocaleProvider';
import { parseDevice, type Device } from './device';
import { SESSIONS_KEY, sessionsApi, type DeviceSession } from './sessions-api';
import './sessions.css';

const DAY_SECONDS = 86_400;

/** "Chrome on macOS", "Safari", "macOS", or "Unknown device". */
export function deviceName(device: Device): string {
  if (device.browser && device.os)
    return t('sessions.device.both', { browser: device.browser, os: device.os });
  if (device.browser) return t('sessions.device.browser', { browser: device.browser });
  if (device.os) return t('sessions.device.os', { os: device.os });
  return t('sessions.device.unknown');
}

function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return t('sessions.error.gone');
    if (error.status === 429) return t('sessions.error.tooMany');
  }
  return t('sessions.error.revoke');
}

/** The icon for a kind of device; decorative (the name beside it says what it is). */
function deviceIcon(kind: Device['kind']) {
  const props = { size: 22, 'aria-hidden': true, className: 'session-icon' } as const;
  return kind === 'phone' ? (
    <IconDeviceMobile {...props} />
  ) : kind === 'tablet' ? (
    <IconDeviceTablet {...props} />
  ) : (
    <IconDeviceDesktop {...props} />
  );
}

interface EntryProps {
  readonly session: DeviceSession;
  readonly busy: boolean;
  readonly onRevoke: (id: string) => void;
}

function SessionEntry({ session, busy, onRevoke }: EntryProps) {
  useLocale();
  const device = parseDevice(session.userAgent);
  const name = deviceName(device);
  return (
    <li className="session-entry">
      {deviceIcon(device.kind)}
      <div className="session-main">
        <p className="session-name">
          <strong>{name}</strong>
          {session.current && <Badge variant="success">{t('sessions.current')}</Badge>}
        </p>
        <p className="session-meta">
          {t('sessions.signedIn', { date: formatDateTime(session.createdAt) })}
          <span aria-hidden="true"> · </span>
          {t('sessions.lastActive', { date: formatDateTime(session.lastActiveAt) })}
          <span aria-hidden="true"> · </span>
          {session.ip ? t('sessions.address', { ip: session.ip }) : t('sessions.addressUnknown')}
        </p>
      </div>
      {!session.current && (
        <Button
          variant="outline"
          disabled={busy}
          aria-label={t('sessions.revokeFor', { device: name })}
          onClick={() => onRevoke(session.id)}
        >
          {t('sessions.revoke')}
        </Button>
      )}
    </li>
  );
}

/**
 * "Where you are signed in" (spec 02 F20, ADR 0030): every session of this person, the one in use marked,
 * a button to end any other, and one to end them all. Ending a session takes effect at once on the server.
 * There is no confirmation step: the worst outcome is that someone signs in again.
 */
export function SessionsPanel() {
  useLocale();
  const qc = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const list = useQuery({ queryKey: SESSIONS_KEY, queryFn: sessionsApi.list });
  const refresh = () => qc.invalidateQueries({ queryKey: SESSIONS_KEY });

  const revoke = useMutation({
    mutationFn: sessionsApi.revoke,
    gcTime: 0,
    onSuccess: async () => {
      setMessage({ kind: 'success', text: t('sessions.revokedOne') });
      await refresh();
    },
    onError: async (error) => {
      setMessage({ kind: 'error', text: failure(error) });
      // A 404 means it is already gone: show the truth.
      if (error instanceof ApiError && error.status === 404) await refresh();
    },
  });
  const revokeOthers = useMutation({
    mutationFn: sessionsApi.revokeOthers,
    gcTime: 0,
    onSuccess: async (count) => {
      setMessage({
        kind: 'success',
        text: count > 0 ? tp('sessions.revokedOthers', count) : t('sessions.revokedNone'),
      });
      await refresh();
    },
    onError: (error) => setMessage({ kind: 'error', text: failure(error) }),
  });

  const sessions = list.data ?? [];
  const others = sessions.filter((s) => !s.current).length;
  const busy = revoke.isPending || revokeOthers.isPending;

  return (
    <Card className="panel session-panel" role="region" aria-labelledby="sessions-title">
      <h2 id="sessions-title">{t('sessions.title')}</h2>
      <p className="muted">{t('sessions.body')}</p>
      <p className="muted">
        {t('sessions.lifetime', {
          idleDays: Math.round(SESSION_EXPIRES_IN_SECONDS / DAY_SECONDS),
          maxDays: Math.round(SESSION_ABSOLUTE_SECONDS / DAY_SECONDS),
        })}
      </p>
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {list.isLoading ? (
        <p role="status">{t('sessions.loading')}</p>
      ) : list.isError ? (
        <Notice kind="error">
          <p>{t('sessions.error')}</p>
          <Button variant="outline" onClick={() => void list.refetch()}>
            {t('sessions.retry')}
          </Button>
        </Notice>
      ) : (
        <>
          <ul className="session-list" aria-label={t('sessions.listLabel')}>
            {sessions.map((s) => (
              <SessionEntry
                key={s.id}
                session={s}
                busy={busy}
                onRevoke={(id) => {
                  setMessage(null);
                  revoke.mutate(id);
                }}
              />
            ))}
          </ul>
          <p className="muted session-note">{t('sessions.activityNote')}</p>
          <div className="form-actions">
            <Button
              variant="outline"
              disabled={busy || others === 0}
              onClick={() => {
                setMessage(null);
                revokeOthers.mutate();
              }}
            >
              {revokeOthers.isPending ? t('sessions.revoking') : t('sessions.revokeOthers')}
            </Button>
            {others === 0 && <span className="muted">{t('sessions.revokeOthersNone')}</span>}
          </div>
        </>
      )}
    </Card>
  );
}
