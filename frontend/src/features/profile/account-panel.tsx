/**
 * The account group on the Profile screen — the two native rows.
 *
 * ── What it used to hold, and where that went ─────────────────────────
 *
 * #1431 put Settings and Admin & moderation here, because the drawer it
 * retired was their only entrance and Profile was the nearest screen that is
 * about the VIEWER rather than about an app. That reasoning was right for a
 * shell with nowhere else to put them.
 *
 * #1443 gave the shell somewhere else: the chip's menu lists every
 * destination with its own page, and Settings and Admin both have one. So
 * they are rows of ../app-context/app-context-sheet.tsx now
 * (#switcher-row-settings, #switcher-row-admin), with the BYOK dot
 * (#switcher-byok-dot) following Settings and the same isAdmin publisher
 * behind Admin — the writers are unchanged, only the parent is.
 *
 * ── Why the native rows did NOT follow them ───────────────────────────
 *
 * The node and the wallet are not destinations. They are status readouts —
 * "your node is producing", "this is your balance" — with no page behind
 * them, and the menu's rule is that everything in it goes somewhere. A row
 * that reports rather than navigates is exactly what turns a menu back into
 * the catch-all hamburger, so they stay on the screen that is already about
 * the viewer.
 *
 * Both ship hidden and their stores reveal them when the bridge reports the
 * capability, so on the web this section is its heading and nothing else.
 */

import { NodePillRow } from '../header/node-pill-row';
import { WalletRow } from '../header/wallet-row';

export function AccountPanel() {
  return (
    <section id="profile-account" className="mt-6">
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-300 mb-2">
        Account
      </div>
      {/*
          Native only — both ship hidden and their stores reveal them when the
          bridge reports the capability. On the web this renders nothing, so on
          the web this whole section is its heading and nothing else.
      */}
      <NodePillRow />
      <WalletRow />
    </section>
  );
}
