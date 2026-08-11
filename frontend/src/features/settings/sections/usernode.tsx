/**
 * "Usernode app" sections (profile-and-settings-to-web migration): the mobile
 * app's native App Settings absorbed into this modal. Hidden unless the
 * Usernode bridge reports the getSettingsState capability; fully rendered by
 * settings.js _renderUsernodeSection() from the bridge's settings snapshot.
 * Covers device permissions, node sleep, privacy & identity, diagnostics,
 * about & legal (FAQ), and the app account.
 *
 * #settings-usernode-section's `hidden` is a CAPABILITY GATE, separate from
 * the wrapper's routing `hidden`, and Settings._visibleSections() reads it
 * back to decide menu membership. Its contents — including the error and retry
 * nodes — are built by settings.js, so this component renders an empty shell
 * and nothing else: anything React put here would be blown away on the first
 * bridge response.
 */
export function UsernodeSection() {
  return (
    <div data-settings-section="usernode" className="hidden">
      <div id="settings-usernode-section" className="hidden">
      </div>
    </div>
  );
}
