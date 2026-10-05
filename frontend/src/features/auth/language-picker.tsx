import { useEffect, useState } from 'react';
import { Select } from '@/components/ui/select';
import { languageNames } from '../../lib/i18n/locale';
import { changeLanguage, getPreference } from '../../lib/i18n/runtime';
import { useMessages } from '../../lib/i18n/react';

/** A signed-out preference is device-local and survives account sign-out. */
export function LanguagePicker() {
  const t = useMessages();
  const [value, setValue] = useState(() => getPreference() || '');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setValue(getPreference() || ''); }, [t]);
  return (
    <div className="mx-auto max-w-xs px-4 py-3">
      <Select variant="plain" aria-label={t('language.title')} value={value} disabled={loading}
        onChange={async event => {
          const next = event.target.value;
          setLoading(true);
          setFailed(false);
          try {
            if (await changeLanguage(next || null)) setValue(next);
          } catch { setFailed(true); }
          finally { setLoading(false); }
        }}>
        <option value="">{t('language.auto')}</option>
        {Object.entries(languageNames).map(([locale, name]) => <option key={locale} value={locale}>{name}</option>)}
      </Select>
      {loading ? <p role="status" className="mt-2 text-sm text-zinc-500">{t('language.loading')}</p> : null}
      {failed ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{t('language.loadFailed')}</p> : null}
    </div>
  );
}
