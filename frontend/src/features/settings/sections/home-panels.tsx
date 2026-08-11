import { SectionHeading, StatusLine } from '@/components/ui/field';

/**
 * #911: which home-screen cards ("widgets" to the user, panels in the code)
 * are shown. Every registry entry is on by default — users.home_panels_hidden
 * lists only the ones this viewer dismissed from the card's own ⋮ menu ("Hide
 * widget"), so an unticked box here is the way to get one back. Rows are
 * rendered by settings.js _renderHomePanelsSection() from GET /api/home-panels's
 * `registry` + `hidden`.
 */
export function HomePanelsSection() {
  return (
    <div data-settings-section="home-panels" className="hidden">
      <div id="settings-home-panels-section">
        <SectionHeading title="Home screen widgets">
          Cards shown on your home screen below your apps. Untick one to hide it — the same as pressing the &times; on the card itself.
        </SectionHeading>
        <div id="settings-home-panels-list" className="space-y-2">
        </div>
        <StatusLine as="p" id="settings-home-panels-status" size="xs" />
      </div>
    </div>
  );
}
