/**
 * Profile's two lists of rows (UI overhaul): "Your work", then "More".
 *
 * ── Your work ──────────────────────────────────────────────────────────
 *
 * Your record of what you did here, one row each, every one a drill-in to
 * the Your work screen (./my-proposals.tsx) on its view:
 *
 *   Your changes    "12 merged · 2 in progress". It was "Your proposals"
 *                   (#5310), and it took the Communities tab's "What you are
 *                   working on".
 *   Your requests   "2 open · 1 done": what you asked for, from the Ask for a
 *                   change dialog or a board. It was "Your feedback" (#3186),
 *                   a card over this screen that listed only the dialog's.
 *   Your votes      "Latest: …": what you voted on. It was a filter of Kudos ›
 *                   My history.
 *
 * ── More ───────────────────────────────────────────────────────────────
 *
 * App slots, Challenges & standings, Kudos, Friends and Settings, each with a
 * line that says what is behind it. App slots (#3250) is the one place the
 * allowance shows outside the create dialog, so a "your app quota changed"
 * notice has somewhere to point: "1 of 2 app slots used", from the session's
 * allowance store. A plain click opens the create dialog in place, whose
 * allowance card offers "Request more" once one slot or none is left (#23);
 * a modified click keeps `#create`. Friends was a section of its own under these rows
 * (#2386); it is a row now, with the one number it is allowed ("1 request
 * waiting": friends themselves are never counted), and it opens the same
 * section as a card over this screen (./friends-sheet.tsx), at its own
 * address, `#profile?friends`. "Your contributions", the newest merged
 * changes under everything, is gone: Your changes lists them all.
 *
 * ── How the rows got here ──────────────────────────────────────────────
 *
 * #1431 put Settings and Admin & moderation on Profile, because the drawer it
 * retired was their only entrance and Profile was the nearest screen that is
 * about the VIEWER rather than about an app. #1443 moved them into the app
 * chip's menu, on the rule that the menu lists every destination with its own
 * page. #2718 took that rule apart — the tab bar carries the platform's
 * places now — and put Challenges, Settings and the Admin console back here as
 * rows, with the native node, wallet and staking readouts and Log out under
 * them. The navigation prototype's Me then moved everything else the account
 * group held inside Settings (features/settings/account-rows.tsx).
 *
 * The row ids are the ones they have always had, because dapp.json's checks
 * and the home tour select on them: #profile-row-challenges still leads to
 * #leaderboard/challenges, #profile-row-settings to #settings, and the Your
 * work rows keep the ids of the rows they grew from (#profile-row-proposals,
 * #profile-row-feedback).
 *
 * Real anchors, not buttons: cmd/ctrl-click, middle-click, "open in new tab",
 * the context menu and drag-to-bookmark are the browser's to give, and only an
 * anchor with an href gets them. Friends is the one row with a handler: a
 * plain click opens its card in place, and every modified click keeps the
 * browser's behaviour on its address.
 *
 * Nothing here is in the prerendered shell: ProfileRoot returns null until its
 * store has data, so the admin flag read below cannot disagree with a first
 * render.
 *
 * Both panels are memo()'d: their only prop is `rows`, and ProfileRoot
 * remembers its view between store pushes (./profile-view.tsx), so a push that
 * moves only a sheet or a status field hands both panels the same `rows` and
 * React skips them. The pushes from this file's own subscriptions (the admin
 * flag, the wallet sheet's store, the app allowance) re-render MorePanel alone,
 * which is what paints its subtitle lines.
 */

import { memo, type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { AppWindowIcon, BallotIcon, ChatIcon, CogIcon, HandRaisedIcon, ThumbsUpIcon, TrophyIcon, UserGroupIcon } from '@/components/ui/icons';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { walletSheetStore } from '../header/wallet-sheet-store';
import { appSlotsLine, useAppAllowance } from '../dialogs/app-allowance';
import { Profile } from './profile.js';

/** The rows' two lines are the primitive's, a size down, as the prototype sets them. */
const TITLE = 'text-base font-semibold';
const SUBTITLE = 'text-[0.8125rem]';

type ProfileRows = {
  challenges: string | null;
  kudos: string | null;
  changes?: string | null;
  requests?: string | null;
  votes?: string | null;
  friends?: string | null;
};

/** A plain click that the row takes for itself; anything modified is the browser's. */
function plainClick(event: { defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return !(event.defaultPrevented || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

export const WorkPanel = memo(function WorkPanel({ rows }: { rows: ProfileRows }): ReactNode {
  return (
    <section id="profile-work" className="mt-2">
      <SectionHeader>Your work</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <ListRow
          as="a"
          id="profile-row-proposals"
          href="#profile/your-changes"
          leading={<IconTile size="sm"><BallotIcon /></IconTile>}
          title="Your changes"
          titleClassName={TITLE}
          subtitle={rows.changes || 'Everything you have started'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-feedback"
          href="#profile/your-requests"
          leading={<IconTile size="sm"><ChatIcon /></IconTile>}
          title="Your requests"
          titleClassName={TITLE}
          subtitle={rows.requests || 'What you asked for, and where it stands'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-votes"
          href="#profile/your-votes"
          leading={<IconTile size="sm"><HandRaisedIcon /></IconTile>}
          title="Your votes"
          titleClassName={TITLE}
          subtitle={rows.votes || 'The changes and decisions you voted on'}
          subtitleClassName={SUBTITLE}
        />
      </GroupedList>
    </section>
  );
});

export const MorePanel = memo(function MorePanel({ rows }: {
  rows: ProfileRows;
}): ReactNode {
  // A CAPABILITY, published rather than fetched: App.renderAdminButton in
  // public/js/app.js writes it after the session resolves. The Admin console
  // is a Settings row now; the flag only decides whether the Settings row's
  // own line mentions it.
  const isAdmin = useVisibility('switcher-row-admin', false);
  // The wallet is a Settings row only in the native app (its store reveals
  // it with the bridge's capability), so the line names it only there.
  const wallet = (useStoreState(walletSheetStore) as { visible: boolean }).visible;
  const allowance = useAppAllowance();
  const slotsLine = appSlotsLine(allowance.quota, allowance.requestedAt as string | null);
  const settingsLine = ['Account', 'alerts', 'keys']
    .concat(wallet ? ['wallet'] : [], isAdmin ? ['admin'] : [])
    .join(', ');
  return (
    <section id="profile-more" className="mt-2">
      {/* SectionHeader's own `px-4`, on the rows' content edge (#2832). */}
      <SectionHeader>More</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <ListRow
          as="a"
          id="profile-row-app-slots"
          href="#create"
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            (window as unknown as { App?: { showCreateModal?: () => void } }).App?.showCreateModal?.();
          }}
          leading={<IconTile size="sm"><AppWindowIcon /></IconTile>}
          title="App slots"
          titleClassName={TITLE}
          subtitle={slotsLine || 'How many apps you can create'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-challenges"
          href="#leaderboard/challenges"
          leading={<IconTile size="sm"><TrophyIcon /></IconTile>}
          title="Challenges & standings"
          titleClassName={TITLE}
          subtitle={rows.challenges || 'This season’s challenges and standings'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-kudos"
          href="#leaderboard/kudos"
          leading={<IconTile size="sm"><ThumbsUpIcon /></IconTile>}
          title="Kudos"
          titleClassName={TITLE}
          // The number is the stat card's at the top of the screen; the row
          // says what is behind it.
          subtitle="Kudos on your changes"
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-friends"
          href="#profile?friends"
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            Profile.showFriends();
          }}
          leading={<IconTile size="sm"><UserGroupIcon /></IconTile>}
          title="Friends"
          titleClassName={TITLE}
          subtitle={rows.friends || 'Only you can see your friends'}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-settings"
          href="#settings"
          leading={<IconTile size="sm"><CogIcon /></IconTile>}
          title="Settings"
          titleClassName={TITLE}
          subtitle={settingsLine}
          subtitleClassName={SUBTITLE}
        />
      </GroupedList>
    </section>
  );
});
