import { useId, useState } from 'react';
import { t } from '../i18n';
import { CopyButton } from './CopyButton';
import { bashSnippet, nodeSnippet } from './snippets';
import { useLocale } from '../i18n/LocaleProvider';

type Language = 'bash' | 'node';

/**
 * Plain-language setup help with copy-paste examples. The examples hold the endpoint URL and
 * a reference to an environment variable, never the secret itself, so copying one is safe.
 */
export function Guidance({ endpointUrl }: { readonly endpointUrl: string }) {
  useLocale();
  const [language, setLanguage] = useState<Language>('bash');
  const tabsId = useId();
  const code = language === 'bash' ? bashSnippet(endpointUrl) : nodeSnippet(endpointUrl);
  return (
    <details className="source-details">
      <summary>{t('sources.guide.summary')}</summary>
      <div className="source-details-body">
        <p>{t('sources.guide.intro')}</p>
        <div role="group" aria-labelledby={tabsId} className="segmented">
          <span id={tabsId} className="source-visually-hidden">
            {t('sources.guide.summary')}
          </span>
          {(['bash', 'node'] as const).map((id) => (
            <button
              key={id}
              type="button"
              className="btn btn-outline segmented-option"
              aria-pressed={language === id}
              onClick={() => setLanguage(id)}
            >
              {t(id === 'bash' ? 'sources.guide.bash' : 'sources.guide.node')}
            </button>
          ))}
        </div>
        <pre className="code-block" tabIndex={0} aria-label={t('sources.guide.summary')}>
          <code>{code}</code>
        </pre>
        <CopyButton
          text={code}
          label="sources.guide.copy"
          copied="sources.guide.copied"
          failed="sources.guide.copyFailed"
        />
        <p className="field-hint">{t('sources.guide.result')}</p>
        <h4>{t('sources.guide.formatTitle')}</h4>
        <p>{t('sources.guide.format')}</p>
        <h4>{t('sources.guide.signTitle')}</h4>
        <p>{t('sources.guide.sign')}</p>
      </div>
    </details>
  );
}
