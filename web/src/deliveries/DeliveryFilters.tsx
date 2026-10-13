import { useId } from 'react';
import { IconFilterOff } from '@tabler/icons-react';
import { Button, Input } from '../components/ui';
import type { Integration } from '../lib/api';
import { t } from '../i18n';
import { DELIVERY_STATES, isDeliveryState } from './api';
import { STATE_LABEL } from './copy';
import { hasFilters, type ActivitySearch } from './search';

interface DeliveryFiltersProps {
  readonly search: ActivitySearch;
  readonly integrations: readonly Integration[];
  readonly onChange: (next: ActivitySearch) => void;
}

/** Only keys with a value are kept, so the URL stays short and a cleared filter disappears. */
function without(search: ActivitySearch, key: keyof ActivitySearch): ActivitySearch {
  const rest: Record<string, unknown> = { ...search };
  delete rest[key];
  return rest;
}

export function DeliveryFilters({ search, integrations, onChange }: DeliveryFiltersProps) {
  const base = useId();
  const set = (key: keyof ActivitySearch, value: string) =>
    onChange(value ? { ...search, [key]: value } : without(search, key));
  return (
    <form
      className="filters card"
      role="search"
      aria-label={t('deliveries.filters.label')}
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-state`}>
          {t('deliveries.filter.state')}
        </label>
        <select
          id={`${base}-state`}
          className="input"
          value={search.state ?? ''}
          onChange={(e) =>
            isDeliveryState(e.target.value) ? set('state', e.target.value) : set('state', '')
          }
        >
          <option value="">{t('deliveries.filter.state.all')}</option>
          {DELIVERY_STATES.map((s) => (
            <option key={s} value={s}>
              {t(STATE_LABEL[s])}
            </option>
          ))}
        </select>
      </div>
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-integration`}>
          {t('deliveries.filter.integration')}
        </label>
        <select
          id={`${base}-integration`}
          className="input"
          value={search.integration ?? ''}
          onChange={(e) => set('integration', e.target.value)}
        >
          <option value="">{t('deliveries.filter.integration.all')}</option>
          {integrations.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      <div className="filter">
        <label className="field-label" htmlFor={`${base}-from`}>
          {t('deliveries.filter.from')}
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
          {t('deliveries.filter.to')}
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
        <Button variant="outline" type="button" onClick={() => onChange({})} disabled={!hasFilters(search)}>
          <IconFilterOff size={18} aria-hidden="true" />
          {t('deliveries.filter.clear')}
        </Button>
      </div>
      <p className="field-hint filters-hint">{t('deliveries.filter.dateHint')}</p>
    </form>
  );
}
