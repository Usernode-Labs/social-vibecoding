/**
 * Profile's lists of rows (UI overhaul, regrouped by the navigation review):
 * "Your work", then "Rewards" and "Account" side by side with it on a wide
 * window, and a Settings card of its own at the foot, at every width.
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
 * ── Rewards ────────────────────────────────────────────────────────────
 *
 * Challenges & standings and Kudos, the two rows about how you are doing,
 * each with a line that says what is behind it. They were the head of the
 * old "More" list, mixed in with app slots, friends and settings; the
 * navigation review split them out under their own heading.
 *
 * ── Account ────────────────────────────────────────────────────────────
 *
 * Friends and App slots, the rows about the account itself. App slots (#3250)
 * is the one place the allowance shows outside the create dialog, so a "your
 * app quota changed" notice has somewhere to point: "1 of 2 app slots used",
 * from the session's allowance store. A plain click opens the create dialog in
 * place, whose allowance card offers "Request more" once one slot or none is
 * left (#23); a modified click keeps `#create`. Friends was a section of its
 * own under these rows (#2386); it is a row now, with the one number it is
 * allowed ("1 request waiting": friends themselves are never counted), and it
 * opens the same section as a card over this screen (./friends-sheet.tsx), at
 * its own address, `#profile?friends`. "Your contributions", the newest
 * merged changes under everything, is gone: Your changes lists them all.
 *
 * ── Settings ───────────────────────────────────────────────────────────
 *
 * The ways into the settings that are about you, at every width (#5557): a
 * Settings card at the foot of Me, under Account, with Profile (opens the Edit
 * profile sheet in place), Notifications (`#settings/alerts`, the account-wide
 * defaults and each app's choices) and Settings (the whole screen). Before
 * this, a wide window had no entrance here at all — only the sidebar's gear
 * (features/nav/tab-bar.tsx with app.css's media query) — and a phone had the
 * one Settings row. It stays its own card rather than a row inside Account,
 * because GroupedList's separators are `:not(:last-child)` and a row hidden
 * inside the Account card would leave a stray hairline behind. Admin &
 * moderation, the native node / wallet / staking rows and Log out are in
 * Settings (features/settings/account-rows.tsx).
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
 */

import { type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { AppWindowIcon, BallotIcon, BellIcon, ChatIcon, CogIcon, HandRaisedIcon, ThumbsUpIcon, TrophyIcon, UserGroupIcon, UserPenIcon } from '@/components/ui/icons';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility } from '../../lib/visibility-store';
import { walletSheetStore } from '../header/wallet-sheet-store';
import { appSlotsLine, useAppAllowance } from '../dialogs/app-allowance';
import { Profile } from './profile.js';
import { KUDOS_PARKED } from '../leaderboard/kudos-parked';

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

export function WorkPanel({ rows }: { rows: ProfileRows }): ReactNode {
  const t = useMessages('profile');
  return (
    <section id="profile-work" className="mt-2">
      {/* The right column's first label: `lg:pt-0` lines it up with the top
          of the profile card beside it. */}
      <SectionHeader className="lg:pt-0">{t('profile:work.heading')}</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <ListRow
          as="a"
          id="profile-row-proposals"
          href="#profile/your-changes"
          leading={<IconTile size="sm"><BallotIcon /></IconTile>}
          title={t('profile:work.changes.title')}
          titleClassName={TITLE}
          subtitle={rows.changes || t('profile:work.changes.hint')}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-feedback"
          href="#profile/your-requests"
          leading={<IconTile size="sm"><ChatIcon /></IconTile>}
          title={t('profile:work.requests.title')}
          titleClassName={TITLE}
          subtitle={rows.requests || t('profile:work.requests.hint')}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-votes"
          href="#profile/your-votes"
          leading={<IconTile size="sm"><HandRaisedIcon /></IconTile>}
          title={t('profile:work.votes.title')}
          titleClassName={TITLE}
          subtitle={rows.votes || t('profile:work.votes.hint')}
          subtitleClassName={SUBTITLE}
        />
      </GroupedList>
    </section>
  );
}

export function RewardsPanel({ rows }: {
  rows: ProfileRows;
}): ReactNode {
  const t = useMessages('profile');
  return (
    <section id="profile-rewards" className="mt-2">
      <SectionHeader>{t('profile:rewards.heading')}</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <ListRow
          as="a"
          id="profile-row-challenges"
          href="#leaderboard/challenges"
          leading={<IconTile size="sm"><TrophyIcon /></IconTile>}
          title={t('profile:more.challenges.title')}
          titleClassName={TITLE}
          subtitle={rows.challenges || t('profile:more.challenges.hint')}
          subtitleClassName={SUBTITLE}
        />
        {/* #5249: no Kudos row while kudos is parked (../leaderboard/kudos-parked.ts). */}
        {KUDOS_PARKED ? null : (
          <ListRow
            as="a"
            id="profile-row-kudos"
            href="#leaderboard/kudos"
            leading={<IconTile size="sm"><ThumbsUpIcon /></IconTile>}
            title={t('profile:more.kudos.title')}
            titleClassName={TITLE}
            // The number is the stat card's at the top of the screen; the row
            // says what is behind it.
            subtitle={t('profile:more.kudos.hint')}
            subtitleClassName={SUBTITLE}
          />
        )}
      </GroupedList>
    </section>
  );
}

export function AccountPanel({ rows }: {
  rows: ProfileRows;
}): ReactNode {
  const allowance = useAppAllowance();
  const slotsLine = appSlotsLine(allowance.quota, allowance.requestedAt as string | null);
  const t = useMessages('profile');
  return (
    <section id="profile-account" className="mt-2">
      <SectionHeader>{t('profile:account.heading')}</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
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
          title={t('profile:more.friends.title')}
          titleClassName={TITLE}
          subtitle={rows.friends || t('profile:more.friends.hint')}
          subtitleClassName={SUBTITLE}
        />
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
          title={t('profile:more.appSlots.title')}
          titleClassName={TITLE}
          subtitle={slotsLine || t('profile:more.appSlots.hint')}
          subtitleClassName={SUBTITLE}
        />
      </GroupedList>
    </section>
  );
}

export function SettingsPanel(): ReactNode {
  // A CAPABILITY, published rather than fetched: App.renderAdminButton in
  // public/js/app.js writes it after the session resolves. The Admin console
  // is a Settings row now; the flag only decides whether the Settings row's
  // own line mentions it.
  const isAdmin = useVisibility('switcher-row-admin', false);
  // The wallet is a Settings row only in the native app (its store reveals
  // it with the bridge's capability), so the line names it only there.
  const wallet = (useStoreState(walletSheetStore) as { visible: boolean }).visible;
  const t = useMessages('profile');
  // One whole message per combination of what this viewer's Settings holds.
  const settingsLine = wallet
    ? (isAdmin ? t('profile:more.settings.hintWalletAdmin') : t('profile:more.settings.hintWallet'))
    : (isAdmin ? t('profile:more.settings.hintAdmin') : t('profile:more.settings.hint'));
  return (
    // #5557: every width shows this card. A desktop used to have no way into
    // settings here but the sidebar's gear, and a phone only the one row.
    <section id="profile-settings" className="mt-2">
      <SectionHeader>{t('profile:settings.heading')}</SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <ListRow
          as="a"
          id="profile-row-profile"
          href="#profile?edit"
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            Profile.showEditSheet();
          }}
          leading={<IconTile size="sm"><UserPenIcon /></IconTile>}
          title={t('profile:settings.profile.title')}
          titleClassName={TITLE}
          subtitle={t('profile:settings.profile.hint')}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-notifications"
          href="#settings/alerts"
          leading={<IconTile size="sm"><BellIcon /></IconTile>}
          title={t('profile:settings.notifications.title')}
          titleClassName={TITLE}
          subtitle={t('profile:settings.notifications.hint')}
          subtitleClassName={SUBTITLE}
        />
        <ListRow
          as="a"
          id="profile-row-settings"
          href="#settings"
          leading={<IconTile size="sm"><CogIcon /></IconTile>}
          title={t('profile:more.settings.title')}
          titleClassName={TITLE}
          subtitle={settingsLine}
          subtitleClassName={SUBTITLE}
        />
      </GroupedList>
    </section>
  );
}