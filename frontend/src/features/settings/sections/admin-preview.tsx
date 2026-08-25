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
        <SectionHeading title="Admin preview">
          Hide admin-only UI so the app looks the way it does for a regular user. Useful for spotting UX issues that only affect non-admins.
        </SectionHeading>
        <SwitchRow id="view-as-non-admin">
          View as non-admin
        </SwitchRow>
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2 leading-relaxed">
          Purely a client-side display toggle: your server-side admin privileges are unaffected. The page will reload so the rest of the UI picks up the change.
        </p>
      </div>
    </div>
  );
}
