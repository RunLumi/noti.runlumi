import { Field } from '../../components/form';
import { Input } from '../../components/ui';
import type { GithubInstallation } from '../../lib/api';
import { t } from '../../i18n';
import { activeInstallations, isCovered, repoName } from './coverage';
import { useLocale } from '../../i18n/LocaleProvider';

interface RepoPickerProps {
  readonly installations: readonly GithubInstallation[];
  readonly repo: string;
  /** Non-null while typing a repository name under an `all` installation's account. */
  readonly repoAccount: string | null;
  readonly onChange: (repo: string, repoAccount: string | null) => void;
  readonly error?: string;
}

const LISTED = 'repo:';
const TYPED = 'all:';

/**
 * Choose a repository the GitHub connection covers (F67, ADR 0008 §8). `selected`
 * installations list their repositories; `all` installations offer "Another repository in
 * <account>…", which reveals a name field with the owner fixed to that account.
 */
export function RepoPicker({ installations, repo, repoAccount, onChange, error }: RepoPickerProps) {
  useLocale();
  const active = activeInstallations(installations);
  const value = repoAccount !== null ? TYPED + repoAccount : repo ? LISTED + repo : '';
  // An existing integration may name a repository Noti can no longer see; keep it visible.
  const stale = repo !== '' && repoAccount === null && !isCovered(repo, installations);
  return (
    <>
      <Field
        label={t('repo.picker')}
        hint={t('repo.picker.hint')}
        error={repoAccount === null ? error : undefined}
      >
        {(ids) => (
          <select
            id={ids.inputId}
            className="input"
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid || undefined}
            value={value}
            onChange={(e) => {
              const next = e.target.value;
              if (next.startsWith(TYPED)) onChange(next.slice(TYPED.length) + '/', next.slice(TYPED.length));
              else onChange(next.slice(LISTED.length), null);
            }}
          >
            <option value="">{t('repo.picker.placeholder')}</option>
            {stale && <option value={LISTED + repo}>{t('repo.picker.notCovered', { repo })}</option>}
            {active.map((installation) => (
              <optgroup key={installation.id} label={installation.account}>
                {installation.repositorySelection === 'all' ? (
                  <option value={TYPED + installation.account}>
                    {t('repo.picker.allOption', { account: installation.account })}
                  </option>
                ) : (
                  installation.repositories.map((full) => (
                    <option key={full} value={LISTED + full}>
                      {full}
                    </option>
                  ))
                )}
              </optgroup>
            ))}
          </select>
        )}
      </Field>
      {repoAccount !== null && (
        <Field
          label={t('repo.name', { account: repoAccount })}
          hint={t('repo.name.hint', { account: repoAccount })}
          error={error}
        >
          {(ids) => (
            <div className="prefixed-input">
              <span className="prefixed-input-prefix mono-wrap" aria-hidden="true">
                {repoAccount}/
              </span>
              <Input
                id={ids.inputId}
                aria-describedby={ids.describedBy}
                aria-invalid={ids.invalid || undefined}
                value={repoName(repo)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => onChange(`${repoAccount}/${e.target.value.trim()}`, repoAccount)}
              />
            </div>
          )}
        </Field>
      )}
    </>
  );
}
