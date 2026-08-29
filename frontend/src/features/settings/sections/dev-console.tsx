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
        <SectionHeading title="Developer console">
          The bug icon in the header opens a slide-up log of console output and errors forwarded from the running app.
        </SectionHeading>
        <SwitchRow id="dev-console-always-show">
          Always show the icon
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-300 mt-2 leading-relaxed">
          When unchecked (the default), the icon only appears once the current app has logged at least one error.
        </p>
      </div>
    </div>
  );
}
