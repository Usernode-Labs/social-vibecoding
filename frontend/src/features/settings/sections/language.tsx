import { SectionHeading, StatusLine } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { useMessages } from '../../../lib/i18n/react';
import { shippedLanguages } from '../../../lib/i18n/runtime';

/**
 * The language preference: one per-user BCP-47 locale, "" (Auto) = unset
 * (NULL in the DB). It is the language Homeroom's own screens use, among the
 * languages that ship (lib/i18n), and the default apps read through the iframe
 * JWT `locale` claim and the bridge's usernode.getUserLocale() (issue #757).
 * settings.js saves on change, through the language runtime, which also pushes
 * `usernode:locale-changed` into any open app iframe.
 *
 * The choices are Auto and the languages this build's catalogs ship (English
 * alone when none is committed), then the ones the server's translation cache
 * covers well enough (GET /api/languages, `minimumCoverage` in
 * frontend/locales/config.json), which Settings._appendLiveLanguages adds once
 * they arrive. A locale saved when this picker listed more, or through the
 * API, is added as an option by Settings._renderLanguageSection, so it stays
 * visible and changeable rather than reading as "Auto". The intro says so
 * (#6511): it once said Homeroom's screens were English only.
 *
 * #settings-locale is a dapp.json anchor and settings.js reads/writes its
 * `.value`, so it stays a native `<select>` — see @/components/ui/select.
 *
 * Offered to everyone. #1556 had hidden it from anyone without a saved locale,
 * because a "Language" row that could not change the screen read as a broken
 * switch; the text below now says what it does. #settings-language-section is
 * kept as the id the baseline and settings.js know.
 *
 * This pane holds no state, so React never reconciles the option settings.js
 * adds away from under it.
 */
export function LanguageSection() {
  // Subscribed, although settings.js adds an option here for a saved language
  // that no longer ships: a new language changes only this pane's own text
  // nodes, and React leaves a node it did not create where it is.
  const t = useMessages('settings');
  return (
    <div data-settings-section="language" className="hidden">
      <div id="settings-language-section">
        <SectionHeading title={t('settings:language.title')}>
          {t('settings:language.intro')}
        </SectionHeading>
        <Select id="settings-locale" variant="plain">
          <option value="">
            {t('settings:language.auto')}
          </option>
          {shippedLanguages.map(({ tag, name }) => (
            <option key={tag} value={tag}>
              {name}
            </option>
          ))}
        </Select>
        <StatusLine id="settings-locale-status" size="xs" />
      </div>
      {/* #6479: the zone times are shown in, saved to the account the same
          way. Only the Auto option is rendered; settings.js names the
          device's zone in it and adds the world's zones after mount, so the
          first render is the same everywhere and React never reconciles them
          away. */}
      <div id="settings-timezone-section" className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-800">
        <SectionHeading title={t('settings:timezone.title')}>
          {t('settings:timezone.intro')}
        </SectionHeading>
        <Select id="settings-timezone" variant="plain">
          <option value="" />
        </Select>
        <StatusLine id="settings-timezone-status" size="xs" />
      </div>
    </div>
  );
}
