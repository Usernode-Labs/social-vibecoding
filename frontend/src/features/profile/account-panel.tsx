/**
 * The account group on the Profile screen — where the Me tab ends.
 *
 * ── The rows came back, and this time they are the destination ────────
 *
 * #1431 put Settings and Admin & moderation here, because the drawer it
 * retired was their only entrance and Profile was the nearest screen that is
 * about the VIEWER rather than about an app. #1443 moved them into the app
 * chip's menu, on the rule that the menu lists every destination with its own
 * page and both of those have one.
 *
 * #2718 takes that rule apart. The chip's menu was carrying two unlike lists
 * — the app's options and the platform's places — and the tab bar
 * (features/nav/) now carries the second. Which means Settings, Challenges
 * and the Admin console need a home on a SCREEN rather than in a sheet, and
 * the tab that owns them is Me. So they are rows here again, at the end of
 * the screen the tab lands on.
 *
 * It is the same argument #1431 made, with the piece it was missing: a
 * destination belongs on the screen it belongs to, and Me is that screen for
 * everything about your account. What #1443 was right about is that the
 * drawer was the wrong container — and so was the menu.
 *
 * ── Why the native rows never moved ──────────────────────────────────
 *
 * The node and the wallet are not destinations. They are status readouts —
 * "your node is producing", "this is your balance" — with no page behind
 * them, and every arrangement above has agreed they belong on the screen that
 * is already about the viewer. They are still here, readouts and all.
 *
 * The native rows ship hidden until the bridge reports the capability.
 * Logout is available on every surface through the shared Settings flow.
 */

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GroupedList, ListRow } from '@/components/ui/grouped-list';
import { CogIcon, ShieldCheckIcon, TrophyIcon } from '@/components/ui/icons';
import { ensureSettings } from '../settings/facade.js';
import { useVisibility } from '../../lib/visibility-store';
import { NodePillRow } from '../header/node-pill-row';
import { WalletRow } from '../header/wallet-row';
import { StakingRow } from './staking-sheet';

// The row's own class vocabulary, matching the settings menus one screen
// over: one word per row, no subtitles, so the primitive's default `font-bold`
// would make a page of headings with nothing under them.
const ROW_TITLE = 'font-medium';

export function AccountPanel() {
  // A CAPABILITY, not a preference, and the flag is published rather than
  // fetched here: App.renderAdminButton in public/js/app.js writes it after
  // the session resolves. The id is a row's, from when the app menu was where
  // that row lived — the flag outlives any one row, and renaming it would
  // churn its publisher, its other reader and five assertions to no end.
  const isAdmin = useVisibility('switcher-row-admin', false);
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
      {/*
          THE PLATFORM'S OWN PLACES, first. Challenges, Settings and the Admin
          console are destinations with pages of their own; everything below is
          a readout or an action on this screen. The order is how often you go:
          the group's shared goals, then your own configuration, then the
          console almost nobody sees.
      */}
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
        Platform
      </div>
      <GroupedList>
        {/*
            Real anchors, not buttons: cmd/ctrl-click, middle-click, "open in
            new tab", the context menu and drag-to-bookmark are the browser's
            to give and only an anchor with an href gets them. Every one of
            these is a plain hash route the shell's router already resolves,
            so there is no click handler to write — which is the other half of
            why they are anchors.
        */}
        <ListRow
          as="a"
          id="profile-row-challenges"
          href="#leaderboard/challenges"
          leading={<TrophyIcon className="w-5 h-5" />}
          title="Challenges"
          titleClassName={ROW_TITLE}
        />
        <ListRow
          as="a"
          id="profile-row-settings"
          href="#settings"
          leading={<CogIcon className="w-5 h-5" />}
          title="Settings"
          titleClassName={ROW_TITLE}
        />
        {/*
            The Admin row is not rendered at all for an account without the
            capability, as opposed to rendered and hidden. That is safe HERE
            and would not be in the shell's prerendered markup: ProfileRoot
            returns null until its store has data, so none of this is in
            public/index.html and there is no document for a first render to
            disagree with. The two menus that DO prerender their Admin row use
            useVisibilityHiddenClass for exactly that reason.
        */}
        {isAdmin ? (
          <ListRow
            as="a"
            id="profile-row-admin"
            href="#admin"
            leading={<ShieldCheckIcon className="w-5 h-5" />}
            title="Admin & moderation"
            titleClassName={ROW_TITLE}
          />
        ) : null}
      </GroupedList>
      <div className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 mt-6 mb-2">
        Account
      </div>
      {/*
          Native only — these ship hidden and their stores reveal them when the
          bridge reports the capability.
      */}
      <NodePillRow />
      <WalletRow />
      <StakingRow />
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
