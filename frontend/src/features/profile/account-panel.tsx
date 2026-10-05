import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
 */

import { type ReactNode } from 'react';

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

export function WorkPanel({ rows }: { rows: ProfileRows }): ReactNode {
  return (
    <section id="profile-work" className="mt-2">
      <SectionHeader><Message id="account:your_work_ef14cf0d" /></SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <Localized element={<LocalizedDynamic element={<ListRow
          as="a"
          id="profile-row-proposals"
          href="#profile/your-changes"
          leading={<IconTile size="sm"><BallotIcon /></IconTile>} title={catalogText("account:your_changes_96b37574")}
          titleClassName={TITLE}
          subtitle={rows.changes || tr("account:everything_you_have_started_c238d9c3")}
          subtitleClassName={SUBTITLE}
        />} resolve={() => ({ "subtitle": rows.changes || tr("account:everything_you_have_started_c238d9c3") })} />} messages={{"title":"account:your_changes_96b37574"}} />
        <Localized element={<LocalizedDynamic element={<ListRow
          as="a"
          id="profile-row-feedback"
          href="#profile/your-requests"
          leading={<IconTile size="sm"><ChatIcon /></IconTile>} title={catalogText("account:your_requests_4c64a2a1")}
          titleClassName={TITLE}
          subtitle={rows.requests || tr("account:what_you_asked_for_and_where_it_stands_55cc2394")}
          subtitleClassName={SUBTITLE}
        />} resolve={() => ({ "subtitle": rows.requests || tr("account:what_you_asked_for_and_where_it_stands_55cc2394") })} />} messages={{"title":"account:your_requests_4c64a2a1"}} />
        <Localized element={<LocalizedDynamic element={<ListRow
          as="a"
          id="profile-row-votes"
          href="#profile/your-votes"
          leading={<IconTile size="sm"><HandRaisedIcon /></IconTile>} title={catalogText("account:your_votes_ca7f0008")}
          titleClassName={TITLE}
          subtitle={rows.votes || tr("account:the_changes_and_decisions_you_voted_on_47fe9205")}
          subtitleClassName={SUBTITLE}
        />} resolve={() => ({ "subtitle": rows.votes || tr("account:the_changes_and_decisions_you_voted_on_47fe9205") })} />} messages={{"title":"account:your_votes_ca7f0008"}} />
      </GroupedList>
    </section>
  );
}

export function MorePanel({ rows }: {
  rows: ProfileRows;
}): ReactNode {
  useUiLanguage();
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
  const settingsLine = [tr("account:account_7e1b0d56"), 'alerts', 'keys']
    .concat(wallet ? ['wallet'] : [], isAdmin ? ['admin'] : [])
    .join(', ');
  return (
    <section id="profile-more" className="mt-2">
      {/* SectionHeader's own `px-4`, on the rows' content edge (#2832). */}
      <SectionHeader><Message id="account:more_d47d7cb0" /></SectionHeader>
      <GroupedList className="mx-0" tone="plane">
        <Localized element={<LocalizedDynamic element={<ListRow
          as="a"
          id="profile-row-app-slots"
          href="#create"
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            (window as unknown as { App?: { showCreateModal?: () => void } }).App?.showCreateModal?.();
          }}
          leading={<IconTile size="sm"><AppWindowIcon /></IconTile>} title={catalogText("account:app_slots_1be05f8f")}
          titleClassName={TITLE}
          subtitle={slotsLine || tr("account:how_many_apps_you_can_create_cc6f6baf")}
          subtitleClassName={SUBTITLE}
        />} resolve={() => ({ "subtitle": slotsLine || tr("account:how_many_apps_you_can_create_cc6f6baf") })} />} messages={{"title":"account:app_slots_1be05f8f"}} />
        <Localized element={<LocalizedDynamic element={<ListRow
          as="a"
          id="profile-row-challenges"
          href="#leaderboard/challenges"
          leading={<IconTile size="sm"><TrophyIcon /></IconTile>} title={catalogText("account:challenges_standings_13cb5a88")}
          titleClassName={TITLE}
          subtitle={rows.challenges || tr("account:this_season_s_challenges_and_standings_b42ac32a")}
          subtitleClassName={SUBTITLE}
        />} resolve={() => ({ "subtitle": rows.challenges || tr("account:this_season_s_challenges_and_standings_b42ac32a") })} />} messages={{"title":"account:challenges_standings_13cb5a88"}} />
        <Localized element={<ListRow
          as="a"
          id="profile-row-kudos"
          href="#leaderboard/kudos"
          leading={<IconTile size="sm"><ThumbsUpIcon /></IconTile>} title={catalogText("account:kudos_51483eb0")}
          titleClassName={TITLE}
          // The number is the stat card's at the top of the screen; the row
          // says what is behind it.
          subtitle={tr("core:kudos_on_your_changes_6ab9a514")}
          subtitleClassName={SUBTITLE}
        />} messages={{"title":"account:kudos_51483eb0"}} />
        <Localized element={<LocalizedDynamic element={<ListRow
          as="a"
          id="profile-row-friends"
          href="#profile?friends"
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            Profile.showFriends();
          }}
          leading={<IconTile size="sm"><UserGroupIcon /></IconTile>} title={catalogText("account:friends_bd104d1b")}
          titleClassName={TITLE}
          subtitle={rows.friends || tr("account:only_you_can_see_your_friends_37b5f2bd")}
          subtitleClassName={SUBTITLE}
        />} resolve={() => ({ "subtitle": rows.friends || tr("account:only_you_can_see_your_friends_37b5f2bd") })} />} messages={{"title":"account:friends_bd104d1b"}} />
        <Localized element={<ListRow
          as="a"
          id="profile-row-settings"
          href="#settings"
          leading={<IconTile size="sm"><CogIcon /></IconTile>} title={catalogText("account:settings_74a883a0")}
          titleClassName={TITLE}
          subtitle={settingsLine}
          subtitleClassName={SUBTITLE}
        />} messages={{"title":"account:settings_74a883a0"}} />
      </GroupedList>
    </section>
  );
}
