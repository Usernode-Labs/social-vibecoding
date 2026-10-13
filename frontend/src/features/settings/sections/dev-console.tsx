import { SectionHeading } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';
import { useMessages } from '../../../lib/i18n/react';

/**
 * Developer console visibility. The bug-icon in the header opens a slide-up
 * log of forwarded console output and errors from the running app's iframe. By
 * default the icon stays hidden until the app actually logs an error so the
 * header doesn't get cluttered for users who never need it. This toggle pins
 * it to always-visible whenever an iframe is on screen.
 */
export function DevConsoleSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="dev-console" className="hidden">
      <div id="settings-devconsole-section">
        <SectionHeading title={t('settings:devConsole.title')}>
          {t('settings:devConsole.intro')}
        </SectionHeading>
        <SwitchRow id="dev-console-always-show">
          {t('settings:devConsole.alwaysShow.label')}
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          {t('settings:devConsole.alwaysShow.description')}
        </p>
      </div>
    </div>
  );
}
