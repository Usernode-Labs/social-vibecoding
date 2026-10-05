import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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
 * native kit's MODAL by lib/kit-surface.ts, because `.un-modal` is a real
 * scroller and a list of friends can be longer than the screen. With no kit
 * the card simply stays where React put it, at the top of the screen. The
 * root and card class strings are constants (the kit writes onto them), and
 * the card is brought home in the layout-effect cleanup, before React
 * removes it.
 */

import { useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Hand the card to the native kit, exactly once, and put it back before
  // React ever tries to remove it. Same shape as ./feedback-sheet.tsx.
  useIsomorphicLayoutEffect(() => {
    const contentEl = panelRef.current;
    const flagEl = rootRef.current;
    if (!contentEl || !flagEl) return;
    let adoption: KitAdoption | null = null;
    adoption = adoptKitSurface({
      kind: 'modal',
      contentEl,
      adoptedOn: flagEl,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => {
        if (!adoption) return;
        adoption = null;
        Profile._dismissFriends();
      },
    });
    return () => {
      if (!adoption) return;
      const handle = adoption;
      adoption = null;
      handle.release();
    };
  }, []);

  return (
    <div id="profile-friends-root" ref={rootRef} className={ROOT_CLASS}>
      <div id="profile-friends-sheet" ref={panelRef} className={CARD_CLASS}>
        <div className="flex items-center justify-between gap-3 pt-3">
          <h2 className="text-lg font-bold"><Message id="account:friends_bd104d1b" /></h2>
          <Localized element={<Button
            id="profile-friends-close"
            variant="neutral"
            size="sm"
            ink="neutral" aria-label={catalogText("account:close_friends_64e9cddb")}
            onClick={() => Profile._dismissFriends()}
          >
            {TIMES}
          </Button>} messages={{"aria-label":"account:close_friends_64e9cddb"}} />
        </div>
        <FriendsSection view={view} pendingId={pendingId} status={status} heading={false} />
      </div>
    </div>
  );
}
