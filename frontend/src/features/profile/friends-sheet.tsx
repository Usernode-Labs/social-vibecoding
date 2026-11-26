/**
 * `#profile-friends-sheet` — Friends, as a card over Me (UI overhaul).
 *
 * It was a section of its own under Me's rows (#2386). Me is a list of rows
 * now, "Your work" and "More", and Friends is one of them, with the one
 * number it is allowed ("1 request waiting"); the section it opens is the
 * same one (./friends-section.tsx: the search, requests to answer, your
 * friends, the requests you sent), in this card.
 *
 * The same presentation as ./feedback-sheet.tsx, for the same reasons:
 * rendered inside #profile-root while `friendsOpen` is set, and handed to the
 * native kit's MODAL by lib/sheet.ts, because `.un-modal` is a real
 * scroller and a list of friends can be longer than the screen. With no kit
 * the card simply stays where React put it, at the top of the screen. The
 * root and card class strings are constants (the kit writes onto them), and
 * the Sheet brings the card home before React removes it.
 */

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useMessages } from '../../lib/i18n/react';
import { useSheet } from '../../lib/sheet';
import { FriendsSection, type FriendsSectionView } from './friends-section';
import { Profile } from './profile.js';

/** The no-kit card chrome, on the node the kit flags. Constant. */
const ROOT_CLASS = 'rounded-2xl bg-white dark:bg-zinc-900 mb-5';

/** The lifted card. Constant. */
const CARD_CLASS = 'flex flex-col px-4 pb-5';

// × as a character: this is text, not HTML source.
const TIMES = '×';

export function FriendsSheet({ view, pendingId, status }: {
  view: FriendsSectionView;
  pendingId: number | null;
  status: string;
}): ReactNode {
  const t = useMessages('profile');

  // Lifted into the kit's modal while it is mounted; Escape, Back, the
  // backdrop and focus are the Sheet's (lib/sheet.ts).
  const { rootRef, panelRef } = useSheet({ kind: 'modal', onClose: () => Profile._dismissFriends() });

  return (
    <div id="profile-friends-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-friends-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-3 pt-3">
          <h2 className="text-lg font-bold">{t('profile:friends.title')}</h2>
          <Button
            id="profile-friends-close"
            variant="neutral"
            size="sm"
            ink="neutral"
            aria-label={t('profile:friends.close')}
            onClick={() => Profile._dismissFriends()}
          >
            {TIMES}
          </Button>
        </div>
        <FriendsSection view={view} pendingId={pendingId} status={status} heading={false} />
      </div>
    </div>
  );
}
