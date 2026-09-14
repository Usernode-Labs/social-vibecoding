/**
 * The account group on the Profile screen — native status and logout.
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
 * Both native rows ship hidden until the bridge reports the capability.
 * Logout is available on every surface through the shared Settings flow.
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ensureSettings } from '../settings/facade.js';
import { NodePillRow } from '../header/node-pill-row';
import { WalletRow } from '../header/wallet-row';

export function AccountPanel() {
  const pending = useRef(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState('');

  async function logout() {
    if (pending.current) return;
    pending.current = true;
    setLoggingOut(true);
    setError('');
    try {
      const settings = await ensureSettings();
      if (!settings) throw new Error('Settings unavailable');
      const result = await settings.logout();
      // Success leaves this document, including native WebView teardown.
      // Only a failed logout should make this control usable again.
      if (result !== false) return;
    } catch {
      setError('Could not sign out. Check your connection and try again.');
    }
    pending.current = false;
    setLoggingOut(false);
  }

  return (
    <section id="profile-account" className="mt-6">
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
        Account
      </div>
      {/*
          Native only — both ship hidden and their stores reveal them when the
          bridge reports the capability.
      */}
      <NodePillRow />
      <WalletRow />
      <Button
        type="button"
        layout="full"
        variant="pillDanger"
        size="none"
        ink="dangerTint"
        className="mt-2 min-h-[44px] px-4 py-2.5 text-[17px] font-semibold disabled:opacity-50"
        disabled={loggingOut}
        aria-busy={loggingOut}
        onClick={() => { void logout(); }}
      >
        {loggingOut ? 'Logging out…' : 'Log out'}
      </Button>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </section>
  );
}
