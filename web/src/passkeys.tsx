import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconFingerprint, IconPlus } from '@tabler/icons-react';
import { authClient, assertAuthSuccess } from './lib/auth-client';
import { Button, Card } from './components/ui';
import { t } from './i18n';
import { formatDate } from './i18n/format';
import { useLocale } from './i18n/LocaleProvider';
export function PasskeysPanel() {
  useLocale();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [info, setInfo] = useState('');
  const keys = useQuery({
    queryKey: ['passkeys'],
    queryFn: async () => assertAuthSuccess(await authClient.passkey.listUserPasskeys()),
  });
  async function add() {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      assertAuthSuccess(await authClient.passkey.addPasskey({ name: 'My passkey' }));
      await qc.invalidateQueries({ queryKey: ['passkeys'] });
      setInfo(t('passkeys.added'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t('passkeys.addError'));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!window.confirm(t('passkeys.deleteConfirm'))) return;
    setError('');
    try {
      assertAuthSuccess(await authClient.passkey.deletePasskey({ id }));
      await qc.invalidateQueries({ queryKey: ['passkeys'] });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('passkeys.deleteError'));
    }
  }
  return (
    <Card className="panel" style={{ marginTop: 20 }}>
      <h2>
        <IconFingerprint size={19} aria-hidden="true" /> {t('passkeys.title')}
      </h2>
      <p className="muted">{t('passkeys.body')}</p>
      {error && (
        <p role="alert" className="notice notice-error">
          {error}
        </p>
      )}
      {info && (
        <p role="status" className="notice">
          {info}
        </p>
      )}
      {keys.isLoading ? (
        <p>{t('passkeys.loading')}</p>
      ) : keys.isError ? (
        <p role="alert">{t('passkeys.error')}</p>
      ) : (
        keys.data?.map((key) => (
          <div className="team-entry" key={key.id}>
            <IconFingerprint size={20} aria-hidden="true" />
            <div className="grow">
              <strong>{key.name || t('passkeys.fallbackName')}</strong>
              <p className="muted">
                {t('passkeys.created', {
                  date: key.createdAt ? formatDate(key.createdAt) : t('time.recently'),
                })}
              </p>
            </div>
            <Button
              variant="ghost"
              aria-label={t('passkeys.deleteFor', { name: key.name || t('passkeys.fallbackName') })}
              onClick={() => void remove(key.id)}
            >
              {t('passkeys.delete')}
            </Button>
          </div>
        ))
      )}
      <Button variant="outline" disabled={busy} onClick={() => void add()}>
        <IconPlus size={16} aria-hidden="true" />
        {busy ? t('passkeys.adding') : t('passkeys.add')}
      </Button>
    </Card>
  );
}
