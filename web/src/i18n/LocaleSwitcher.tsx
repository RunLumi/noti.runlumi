import { useId, type ChangeEvent } from 'react';
import { IconLanguage } from '@tabler/icons-react';
import { t } from './index';
import { useLocale } from './LocaleProvider';
import { LOCALES, isLocale } from './locale';
import './locale.css';

/**
 * Language choice as a native `<select>`: it is keyboard- and screen-reader-complete without
 * any extra ARIA. Each option is marked with its own `lang` and its endonym ("Tiếng Việt"),
 * so a reader who cannot read the current interface language can still find theirs (3.1.2).
 */
export function LocaleSwitcher({ compact = false }: { readonly compact?: boolean }) {
  const [locale, setLocale] = useLocale();
  const id = useId();
  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (isLocale(event.target.value)) setLocale(event.target.value);
  };
  return (
    <div className={compact ? 'locale-switcher locale-switcher-compact' : 'locale-switcher'}>
      <label htmlFor={id} className="locale-label">
        <IconLanguage size={18} aria-hidden="true" />
        <span className="locale-label-text">{t('locale.label')}</span>
      </label>
      <select id={id} className="input locale-select" value={locale} onChange={onChange}>
        {LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {t(code === 'vi' ? 'locale.vi' : 'locale.en')}
          </option>
        ))}
      </select>
    </div>
  );
}
