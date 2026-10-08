/**
 * The "‹ Workshop" chip: a Workshop topic's one back control (#2916).
 *
 * ── Where back lives on a topic page, and how it got here ─────────────
 *
 * An issue, a proposal, a governance vote or a shared session opened from the
 * Workshop is still the Workshop's content, and its level up is the board it
 * was opened from. That control has moved twice:
 *
 *   1. A full-width "← Back" bar at the top of the page (topic-frame.tsx).
 *      Retired because it sat one row under the header's chevron to the same
 *      place: two back controls, one row apart.
 *   2. The header's chevron, alone. #2916 asked for it to sit "inside" the
 *      Workshop pane instead: at the top-left of the page, beside the thing
 *      it leaves, rather than in the platform bar above everything.
 *   3. This chip. The header draws NO back control on these routes now
 *      (../../header/platform-header.tsx), so there is still exactly one.
 *
 * Both halves read `topicBackHref` (../../improve/improve-store.js): the chip
 * renders when it has an answer, and the header forces its own slot to 'none'
 * on the same answer. One fact, two readers, so neither zero nor two back
 * controls is a state the page can reach by ordering. A route that is not a
 * topic (a dev session, the Workshop itself) gets null here and nothing is
 * drawn: sessions are Messages threads and keep the header's arrow (#2770).
 *
 * ── What it is, precisely ─────────────────────────────────────────────
 *
 * The FIRST child of `.dev-topic`, above the proposal's hero or the issue's
 * card, left-aligned with that card's edge. It scrolls away with the page
 * rather than being pinned: it belongs to the page, not to chrome.
 *
 * A real `<a href>`, so cmd/ctrl-click, middle-click and "Open in new tab"
 * are the browser's (#1036). The href is `boardHref(slug, boardView)`, the
 * exact destination the header's chevron carried, so the Workshop layout you
 * came from is the one you go back to. A PLAIN click does what the header's
 * listener in public/js/app.js did on this route once its claim chain
 * declined: `NavLink.isNativeClick` first, then preventDefault, then follow
 * the href by assigning `location.hash`. It does not consult that chain
 * (`DevChat.handleBack` and the rest): nothing in it claims a topic, and the
 * href is the answer.
 *
 * The label is the destination's name, "Workshop", with the chevron as its
 * glyph; the accessible name says the whole thing. The native back-swipe
 * follows this chip too; see ../../header/native-back-navigation.ts.
 *
 * ── Opened from Messages: two chips (#3691) ───────────────────────────
 *
 * A card opened from a Messages conversation goes back to it (#3103), so its
 * chip reads "‹ Messages". That left the project the card belongs to with no
 * way in from the card's own page, so a second chip, "‹ Workshop", follows
 * it: the same pill, to the board the chip would have named had the card
 * been opened there (`topicWorkshopHref`). The pair sits in a row
 * (`.dev-topic-backs`) in the first chip's place. Back itself is unchanged:
 * the header, the native back-swipe and the first chip all still read
 * `topicBackHref`, the conversation. A card opened from the Workshop keeps
 * its one chip, exactly as before.
 *
 * Mounted client-side only (a legacy portal, never prerendered), so reading
 * the store during render cannot mismatch hydration.
 */

import type { MouseEvent, ReactNode } from 'react';

import { ChevronLeftIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { useStoreState } from '../../../lib/use-store-state';
import { improveStore, topicBackHref, topicBackLabel, topicWorkshopHref } from '../../improve/improve-store.js';

function onBackClick(event: MouseEvent<HTMLAnchorElement>): void {
  const nav = (window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
  }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  // #3620: a step Back when the entry below is where the chip points (the
  // board it was opened from), so the device's Back afterwards does not
  // reopen this item. Anywhere else (a cold link) it pushes, as it did.
  const app = (window as unknown as { App?: { _stepBackTo?: (h: string) => boolean } }).App;
  if (app?._stepBackTo?.(href)) return;
  window.location.hash = href;
}

/**
 * The chip's words by destination, as message ids. The key is what
 * `topicBackLabel` answers (../../improve/improve-store.js): it names the
 * destination, and is read here as that, never shown.
 */
const CHIP_TEXT: Record<'Messages' | 'Workshop', { label: string; name: string }> = {
  Messages: { label: 'project:topic.back.messages', name: 'project:topic.back.toMessages' },
  Workshop: { label: 'project:topic.back.workshop', name: 'project:topic.back.toWorkshop' },
};

/** One chip: the destination's name behind the chevron. */
function TopicChip({ href, label }: { href: string; label: 'Messages' | 'Workshop' }): ReactNode {
  const t = useMessages('project');
  return (
    <a
      className="dev-topic-back un-touch-target"
      href={href}
      aria-label={t(CHIP_TEXT[label].name)}
      onClick={onBackClick}
    >
      <ChevronLeftIcon className="dev-topic-back-icon" aria-hidden="true" />
      <span>{t(CHIP_TEXT[label].label)}</span>
    </a>
  );
}

export function TopicBack(): ReactNode {
  const { slug, tab, subTab, boardView, topicOrigin } = useStoreState(improveStore);
  const href = topicBackHref({ slug, tab, subTab, boardView, topicOrigin });
  if (!href) return null;
  // #3103: a card opened from a Messages conversation goes back to it, and
  // says so; everywhere else the chip is the Workshop's.
  const back = <TopicChip href={href} label={topicBackLabel(href)} />;
  // #3691: and offers its project's Workshop beside that, styled the same.
  const workshop = topicWorkshopHref({ slug, tab, subTab, boardView, topicOrigin });
  if (!workshop) return back;
  return (
    <div className="dev-topic-backs">
      {back}
      <TopicChip href={workshop} label="Workshop" />
    </div>
  );
}
