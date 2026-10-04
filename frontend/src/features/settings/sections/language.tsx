import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { languageNames } from '../../../lib/i18n/locale';
import { useMessages } from '../../../lib/i18n/react';

/** The controls retain their ids and DOM; settings.js owns value and saving. */
export function LanguageSection() {
  const t = useMessages();
  return (
    <div data-settings-section="language" className="hidden">
      <div id="settings-language-section" className="">
        <SectionHeading title={t('language.title')}>
          {t('language.description')}
        </SectionHeading>
        <Select id="settings-locale" variant="plain" aria-label={t('language.title')}>
          <option value="">{t('language.auto')}</option>
          {Object.entries(languageNames).map(([value, name]) => (
            <option key={value} value={value}>{name}</option>
          ))}
        </Select>
        <StatusLine id="settings-locale-status" size="xs" />
      </div>
    </div>
  );
}
