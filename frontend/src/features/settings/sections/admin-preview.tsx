import { Message, Localized, message as catalogText } from "../../../lib/i18n/react";
import { SectionHeading } from '@/components/ui/field';
import { SwitchRow } from '@/components/ui/switch';

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
  return (
    <div data-settings-section="admin-preview" className="hidden">
      <div id="settings-admin-section" className="hidden">
        <Localized element={<SectionHeading title={catalogText("settings:admin_preview_a702a4e3")}><Message id="settings:hide_admin_only_ui_so_the_app_looks_the_way_it_d_446e57c8" /></SectionHeading>} messages={{"title":"settings:admin_preview_a702a4e3"}} />
        <SwitchRow id="view-as-non-admin"><Message id="settings:view_as_non_admin_970e2f82" /></SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed"><Message id="settings:purely_a_client_side_display_toggle_so_your_serv_be71b26e" /></p>
      </div>
    </div>
  );
}
