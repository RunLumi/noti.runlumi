import { useId } from 'react';
import { IconFilterOff } from '@tabler/icons-react';
import { Button, Input } from '../components/ui';
import { TextFilter } from '../components/TextFilter';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { AUDIT_ACTIONS, isAuditAction } from './api';
import { actionLabel, outcomeLabel } from './copy';
import type { AuditMember } from './hooks';
import { hasAuditFilters, isNamedActor, isValidRequestId, isValidTarget, type AuditSearch } from './search';

interface AuditFiltersProps {
  readonly search: AuditSearch;
  readonly members: readonly AuditMember[];
  readonly onChange: (next: AuditSearch) => void;
}

/** Only keys with a value are kept, so the URL stays short and a cleared filter disappears. */
function without(search: AuditSearch, key: keyof AuditSearch): AuditSearch {
  const rest: Record<string, unknown> = { ...search };
  delete rest[key];
  // The kind of thing only means something next to its id.
  if (key === 'target') delete rest.targetType;
  return rest;
}

export function AuditFilters({ search, members, onChange }: AuditFiltersProps) {
  useLocale();
  const base = useId();
  const set = (key: keyof AuditSearch, value: string) =>
    onChange(value ? { ...search, [key]: value } : without(search, key));
  // A member who left is still the actor of old rows, but cannot be chosen: only current members.
  const knownActor =
    search.actor === undefined ||
    isNamedActor(search.actor) ||
    members.some((m) => m.userId === search.actor);
  return (
    <form
      className="filters card audit-filters"
      role="search"
      aria-label={t('audit.filters.label')}
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-action`}>
          {t('audit.filter.action')}
        </label>
        <select
          id={`${base}-action`}
          className="input"
          value={search.action ?? ''}
          onChange={(e) => set('action', isAuditAction(e.target.value) ? e.target.value : '')}
        >
          <option value="">{t('audit.filter.action.all')}</option>
          {AUDIT_ACTIONS.map((a) => (
            <option key={a} value={a}>
              {actionLabel(a)}
            </option>
          ))}
        </select>
      </div>
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-actor`}>
          {t('audit.filter.actor')}
        </label>
        <select
          id={`${base}-actor`}
          className="input"
          value={search.actor ?? ''}
          aria-describedby={`${base}-actor-hint`}
          onChange={(e) => set('actor', e.target.value)}
        >
          <option value="">{t('audit.filter.actor.all')}</option>
          <option value="~system">{t('audit.actor.system')}</option>
          <option value="~github-installation">{t('audit.actor.installation')}</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.name}
            </option>
          ))}
          {!knownActor && <option value={search.actor}>{search.actor}</option>}
        </select>
        <p id={`${base}-actor-hint`} className="field-hint">
          {t('audit.filter.actor.hint')}
        </p>
      </div>
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-outcome`}>
          {t('audit.filter.outcome')}
        </label>
        <select
          id={`${base}-outcome`}
          className="input"
          value={search.outcome ?? ''}
          onChange={(e) =>
            set('outcome', e.target.value === 'success' || e.target.value === 'denied' ? e.target.value : '')
          }
        >
          <option value="">{t('audit.filter.outcome.all')}</option>
          <option value="success">{outcomeLabel('success')}</option>
          <option value="denied">{outcomeLabel('denied')}</option>
        </select>
      </div>
      <TextFilter
        key={`target:${search.target ?? ''}`}
        id={`${base}-target`}
        label={t('audit.filter.target')}
        hint={t('audit.filter.target.hint')}
        invalidMessage={t('audit.filter.target.invalid')}
        value={search.target ?? ''}
        isValid={isValidTarget}
        onCommit={(v) => set('target', v)}
      />
      <TextFilter
        key={`request:${search.correlationId ?? ''}`}
        id={`${base}-request`}
        label={t('audit.filter.requestId')}
        hint={t('audit.filter.requestId.hint')}
        invalidMessage={t('audit.filter.requestId.invalid')}
        value={search.correlationId ?? ''}
        isValid={isValidRequestId}
        onCommit={(v) => set('correlationId', v)}
      />
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-from`}>
          {t('audit.filter.from')}
        </label>
        <Input
          id={`${base}-from`}
          type="date"
          value={search.from ?? ''}
          max={search.to}
          onChange={(e) => set('from', e.target.value)}
        />
      </div>
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-to`}>
          {t('audit.filter.to')}
        </label>
        <Input
          id={`${base}-to`}
          type="date"
          value={search.to ?? ''}
          min={search.from}
          onChange={(e) => set('to', e.target.value)}
        />
      </div>
      <div className="filter filter-actions">
        <Button
          variant="outline"
          type="button"
          onClick={() => onChange({})}
          disabled={!hasAuditFilters(search)}
        >
          <IconFilterOff size={18} aria-hidden="true" />
          {t('audit.filter.clear')}
        </Button>
      </div>
      <p className="field-hint filters-hint">
        {t('audit.filter.dateHint')} {t('audit.filter.apply')}
      </p>
    </form>
  );
}
