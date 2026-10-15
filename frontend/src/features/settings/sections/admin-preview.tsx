import { SectionHeading } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';
import { useMessages } from '../../../lib/i18n/react';

/**
 * Admin-only: "view as non-admin" preview. Visible only when the server
 * reports the user as a real admin (settings.js gates the visibility based on
 * App._realIsAdmin). Toggling reloads the page so all admin-gated UI (home
 * retry/delete/lock buttons, app-secrets editor, etc.) re-renders against the
 * masked App.user.isAdmin.
 *
 * #settings-admin-section's `hidden` is the third CAPABILITY GATE on this
 * screen, separate from the wrapper's routing `hidden` — see wallet.tsx.
 */
export function AdminPreviewSection() {
  const t = useMessages('settings');
  return (
    <div data-settings-section="admin-preview" className="hidden">
      <div id="settings-admin-section" className="hidden">
        <SectionHeading title={t('settings:adminPreview.title')}>
          {t('settings:adminPreview.intro')}
        </SectionHeading>
        <SwitchRow id="view-as-non-admin">
          {t('settings:adminPreview.toggle.label')}
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          {t('settings:adminPreview.toggle.description')}
        </p>
      </div>
    </div>
  );
}
