import { useState } from 'react';
import { Badge, Button } from '../../components/ui';
import { Field } from '../../components/form';
import { t } from '../../i18n';
import type { FilterConfig } from '../../../../src/routing/filters';
import { EVENT_LABEL, GITHUB_EVENT_TYPES, isGithubEventType } from '../events';
import { describeDecision, EMPTY_SAMPLE, runSample, type SampleDraft, type Tri } from './model';
import { useLocale } from '../../i18n/LocaleProvider';

interface FilterTesterProps {
  /** The parsed filters on screen, or null while they contain errors. */
  readonly config: FilterConfig | null;
}

const TRI: readonly Tri[] = ['unknown', 'yes', 'no'];
const TRI_LABEL = {
  unknown: 'filters.try.tri.unknown',
  yes: 'filters.try.tri.yes',
  no: 'filters.try.tri.no',
} as const;

function TriSelect({ label, value, onChange }: { label: string; value: Tri; onChange: (next: Tri) => void }) {
  useLocale();
  return (
    <Field label={label}>
      {(ids) => (
        <select
          id={ids.inputId}
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value as Tri)}
        >
          {TRI.map((v) => (
            <option key={v} value={v}>
              {t(TRI_LABEL[v])}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * "Try it": describe an update and see what these filters would do with it. It evaluates the
 * filters on screen with the same code ingress runs, against facts the person types. It sends
 * nothing and stores nothing, and it says so.
 */
export function FilterTester({ config }: FilterTesterProps) {
  useLocale();
  const [sample, setSample] = useState<SampleDraft>(EMPTY_SAMPLE);
  const [result, setResult] = useState<{ pass: boolean; text: string } | null>(null);
  const set = <K extends keyof SampleDraft>(key: K, value: SampleDraft[K]) => {
    setSample((s) => ({ ...s, [key]: value }));
    // An answer belongs to the update it was asked about, so it goes when that changes.
    setResult(null);
  };
  const text = (key: 'branch' | 'baseBranch' | 'login', label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {(ids) => (
        <input
          id={ids.inputId}
          className="input"
          aria-describedby={ids.describedBy}
          spellCheck={false}
          value={sample[key]}
          onChange={(e) => set(key, e.target.value)}
        />
      )}
    </Field>
  );

  const check = () => {
    if (!config) return;
    const decision = runSample(config, sample);
    setResult({ pass: decision.pass, text: describeDecision(decision) });
  };

  return (
    <section className="filter-tester" aria-labelledby="filter-tester-title">
      <h3 id="filter-tester-title">{t('filters.try.title')}</h3>
      <p className="field-hint">{t('filters.try.intro')}</p>
      <div className="filter-tester-grid">
        <Field label={t('filters.try.event')}>
          {(ids) => (
            <select
              id={ids.inputId}
              className="input"
              value={sample.event}
              onChange={(e) => isGithubEventType(e.target.value) && set('event', e.target.value)}
            >
              {GITHUB_EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(EVENT_LABEL[type])}
                </option>
              ))}
            </select>
          )}
        </Field>
        {text('branch', t('filters.try.branch'), t('filters.try.branch.hint'))}
        {text('baseBranch', t('filters.try.base'))}
        {text('login', t('filters.try.person'), t('filters.try.person.hint'))}
        <TriSelect label={t('filters.try.bot')} value={sample.bot} onChange={(v) => set('bot', v)} />
        <TriSelect label={t('filters.try.draft')} value={sample.draft} onChange={(v) => set('draft', v)} />
        <Field label={t('filters.try.labels')} hint={t('filters.try.labels.hint')}>
          {(ids) => (
            <textarea
              id={ids.inputId}
              className="input filter-lines"
              aria-describedby={ids.describedBy}
              rows={2}
              spellCheck={false}
              value={sample.labels}
              onChange={(e) => set('labels', e.target.value)}
            />
          )}
        </Field>
      </div>
      <div className="filter-tester-actions">
        <Button type="button" variant="outline" aria-disabled={!config || undefined} onClick={check}>
          {t('filters.try.button')}
        </Button>
        {!config && <p className="field-hint">{t('filters.try.invalid')}</p>}
      </div>
      <div className="filter-tester-result" role="status" aria-live="polite">
        {result && (
          <>
            <Badge variant={result.pass ? 'success' : 'warning'}>
              {t(result.pass ? 'filters.log.sent' : 'filters.log.skipped')}
            </Badge>
            <p>{result.text}</p>
          </>
        )}
      </div>
    </section>
  );
}
