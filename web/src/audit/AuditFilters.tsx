import { useId } from 'react';
import { IconFilterOff } from '@tabler/icons-react';
import { Button, Input } from '../components/ui';
import { t } from '../i18n';
import { useLocale } from '../i18n/LocaleProvider';
import { AUDIT_ACTIONS, isAuditAction } from './api';
import { actionLabel, outcomeLabel } from './copy';
import { hasAuditFilters, type AuditSearch } from './search';

interface AuditFiltersProps {
  readonly search: AuditSearch;
  readonly onChange: (next: AuditSearch) => void;
}

/** Only keys with a value are kept, so the URL stays short and a cleared filter disappears. */
function without(search: AuditSearch, key: keyof AuditSearch): AuditSearch {
  const rest: Record<string, unknown> = { ...search };
  delete rest[key];
  return rest;
}

export function AuditFilters({ search, onChange }: AuditFiltersProps) {
  useLocale();
  const base = useId();
  const set = (key: keyof AuditSearch, value: string) =>
    onChange(value ? { ...search, [key]: value } : without(search, key));
  return (
    <form
      className="filters card"
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
      <p className="field-hint filters-hint">{t('audit.filter.dateHint')}</p>
    </form>
  );
}
