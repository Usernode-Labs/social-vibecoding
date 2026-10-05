import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { SectionHeading } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';

/**
 * Developer console visibility. The bug-icon in the header opens a slide-up
 * log of forwarded console output and errors from the running app's iframe. By
 * default the icon stays hidden until the app actually logs an error so the
 * header doesn't get cluttered for users who never need it. This toggle pins
 * it to always-visible whenever an iframe is on screen.
 */
export function DevConsoleSection() {
  return (
    <div data-settings-section="dev-console" className="hidden">
      <div id="settings-devconsole-section">
        <Localized element={<SectionHeading title={catalogText("settings:developer_console_2ef15ac2")}><Message id="settings:the_bug_icon_in_the_header_opens_a_slide_up_log__3b19f54f" /></SectionHeading>} messages={{"title":"settings:developer_console_2ef15ac2"}} />
        <SwitchRow id="dev-console-always-show"><Message id="settings:always_show_the_icon_40f29927" /></SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"><Message id="settings:when_unchecked_the_default_the_icon_only_appears_55e66c8b" /></p>
      </div>
    </div>
  );
}
