import { useState } from 'react';
import { IconExternalLink } from '@tabler/icons-react';
import { Field } from '../../components/form';
import { Input } from '../../components/ui';
import type { GithubInstallation } from '../../lib/api';
import { t, tp } from '../../i18n';
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
/** Above this many listed repositories a filter box is offered; below it the list is short enough to scan. */
export const SEARCH_THRESHOLD = 8;

/** Where a person changes which repositories Noti can see: GitHub's own installation settings. */
export function githubAccessUrl(installation: GithubInstallation): string {
  return installation.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(installation.account)}/settings/installations`
    : 'https://github.com/settings/installations';
}

/** Case-insensitive substring match; an empty query matches everything. */
export function matchesQuery(repo: string, query: string): boolean {
  return repo.toLowerCase().includes(query.trim().toLowerCase());
}

/**
 * Choose a repository the GitHub connection covers (F67, ADR 0008 §8). `selected`
 * installations list their repositories; `all` installations offer "Another repository in
 * <account>…", which reveals a name field with the owner fixed to that account.
 */
export function RepoPicker({ installations, repo, repoAccount, onChange, error }: RepoPickerProps) {
  useLocale();
  const active = activeInstallations(installations);
  const [query, setQuery] = useState('');
  const listed = active.flatMap((i) => (i.repositorySelection === 'selected' ? i.repositories : []));
  const searchable = listed.length > SEARCH_THRESHOLD;
  const visible = (full: string) => !searchable || full === repo || matchesQuery(full, query);
  const matching = listed.filter((full) => matchesQuery(full, query)).length;
  const value = repoAccount !== null ? TYPED + repoAccount : repo ? LISTED + repo : '';
  // An existing integration may name a repository Noti can no longer see; keep it visible.
  const stale = repo !== '' && repoAccount === null && !isCovered(repo, installations);
  return (
    <>
      {searchable && (
        <Field label={t('repo.search')} hint={t('repo.search.hint')}>
          {(ids) => (
            <>
              <Input
                id={ids.inputId}
                type="search"
                aria-describedby={ids.describedBy}
                value={query}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
              <p className="field-hint" role="status" aria-live="polite">
                {query.trim() === '' ? '' : tp('repo.search.count', matching)}
              </p>
            </>
          )}
        </Field>
      )}
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
                  installation.repositories.filter(visible).map((full) => (
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
      {active.length > 0 && (
        <div className="repo-access">
          <ul className="repo-scope-list">
            {active.map((installation) => (
              <li key={installation.id}>
                {installation.repositorySelection === 'all'
                  ? t('repo.scope.all', { account: installation.account })
                  : tp('repo.scope.selected', installation.repositories.length, {
                      account: installation.account,
                    })}
              </li>
            ))}
          </ul>
          <p className="field-hint">{t('repo.notListed')}</p>
          <ul className="repo-help-links">
            {active.map((installation) => (
              <li key={installation.id}>
                <a
                  href={githubAccessUrl(installation)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-link"
                >
                  {t('repo.notListed.link', { account: installation.account })}
                  <IconExternalLink size={16} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
