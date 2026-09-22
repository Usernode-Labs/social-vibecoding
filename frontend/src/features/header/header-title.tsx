/**
 * #header-title — the name of where you are, and nothing else.
 *
 * ── It was a button, and is not one any more ──────────────────────────
 *
 * ./app-switcher-chip.tsx made this heading a control: "(name) ⌄", opening
 * a menu that listed every platform destination. That was #1443's answer to
 * a bar with too many glyphs on it, and it held for as long as the menu was
 * the only way to reach anything. The tab bar (features/nav/) carries those
 * destinations now, so the menu behind the name holds the APP's options —
 * and a name that opens a menu about something else is a control whose label
 * lies about what it does. The menu moved to its own button
 * (./platform-mark.tsx); the name went back to being a name.
 *
 * What survives from the chip, unchanged, is everything that was about the
 * NAME rather than about the button:
 *
 *   - the h1 and its className, byte for byte, because
 *     ./use-header-layout.ts toggles `.is-centered` on this node via
 *     classList and a re-rendered class attribute would drop it;
 *   - `pointer-events-none`, so the heading's overlap never eats a tap meant
 *     for a control beside it;
 *   - the SUBTITLE BESIDE the name rather than under it — a destination
 *     inside an app (Board, Activity, a session's lifecycle) says which part
 *     of the app you are in without overwriting which app it is;
 *   - the LOGOTYPE when the name is the platform's own, drawn from the title
 *     string because that is the only fact available at first render. The
 *     chip's header carries the full argument for that test, including which
 *     screens it over-covers and why narrowing it would cost a flicker on
 *     every cold load to fix a screen where the drawing already says the
 *     right name.
 *
 * ── The app strip: a tile, and then the name ──────────────────────────
 *
 * Inside a running app the bar is that app's: close on the left, then its
 * icon and its name, then the bell and the mark. The tile is what makes the
 * difference read at a glance — the same artwork the launcher drew a moment
 * ago, so opening an app and being in it are visibly the same thing — and it
 * is drawn from ../improve/improve-store.js, which already carries the open
 * app's name, icon url and emoji for the panel that used to live in this bar.
 * No new fetch, no new publisher.
 *
 * It renders ONLY inside the app view, from features/nav's `screen`. The
 * store's INITIAL has no screen at all, so the prerendered document and the
 * first client render agree on no tile, and it arrives with the route.
 */

import type { RefObject } from 'react';

import { Wordmark } from '@/components/ui/wordmark';

import { useStoreState } from '../../lib/use-store-state';
import { headerTitleStore } from './header-title-store.js';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import { sessionHeaderStore } from '../dev-chat/session-header-store';
import { MergeStatusPill } from '../dev-chat/session-header';
import { AppIconContent, appIconKind } from '../apps/app-card-view';

// The one string that means "this is naming the platform, not an app". It is
// header-title-store.js's INITIAL, which is why the prerendered document and
// the first client render agree about it without this component learning
// anything from anywhere.
const PLATFORM_NAME = 'Homeroom';

export function HeaderTitle({ titleRef }: { titleRef: RefObject<HTMLHeadingElement | null> }) {
  const { text, subtitle } = useStoreState(headerTitleStore);
  const { tab, subTab, name, iconUrl, iconEmoji } = useStoreState(improveStore);
  const { screen } = useStoreState(navStore);
  const { life } = useStoreState(sessionHeaderStore);

  const onSession = tab === 'dev' && subTab === 'sessions';
  const sessionPill = onSession && life ? <MergeStatusPill life={life} /> : null;
  const showSubtitle = onSession ? !!sessionPill : !!subtitle;
  const showsWordmark = text === PLATFORM_NAME && !showSubtitle;

  // The app's own artwork, in the shape ../apps/app-card-view expects. The
  // improve store spells these camelCase because it is a store; the icon walk
  // is shared with the launcher and the browse list and reads the record's
  // own snake_case columns, so this is the one place the two meet.
  const inApp = screen === 'app-view';
  const record = { icon_url: iconUrl, icon_emoji: iconEmoji, name: name || text };

  return (
    <h1
      ref={titleRef}
      id="header-title"
      className={"flex-1 min-w-0 text-base font-semibold pointer-events-none truncate\n               text-left"}
    >
      <span className="inline-flex items-center gap-2 max-w-full align-middle">
        {inApp ? (
          /* `.app-icon-tile` + `data-icon` draw the box, and this call site
             adds no background or text colour of its own — app.css says tile
             call sites must not repaint the one tile face. 28px, which is the
             header's content row exactly, so the tile cannot be what pushes
             the bar past its pinned height. */
          <span
            id="header-app-tile"
            data-icon={appIconKind(record)}
            className="app-icon-tile shrink-0 w-7 h-7 rounded-lg overflow-hidden
                       flex items-center justify-center text-sm font-bold"
          >
            <AppIconContent app={record} />
          </span>
        ) : null}
        <span className="min-w-0 flex items-baseline gap-1.5">
          <span id="header-title-name" className="min-w-0 truncate">
            {/* `aria-hidden` on the mark: the h1 takes its accessible name
                from its contents, and the drawing IS the word "Homeroom" — a
                title element or an sr-only span here would have it read
                twice. The heading is still named, because `text` is what the
                screens beside it publish. */}
            {showsWordmark
              ? <Wordmark className="h-5 w-[77.5px]" aria-hidden="true" />
              : text}
          </span>
          {showSubtitle ? (
            <span
              id="header-subtitle"
              className="shrink-0 text-[0.6875rem] leading-none font-medium
                         text-zinc-500 dark:text-zinc-400"
            >
              {/* `#header-status-pill` keeps its id and its seat: it is still
                  the lifecycle pill's, still inside #platform-header, and the
                  declared check that looks for it does not care which
                  descendant holds it. */}
              {onSession
                ? <span id="header-status-pill" className="min-w-0 truncate">{sessionPill}</span>
                : subtitle}
            </span>
          ) : null}
        </span>
      </span>
    </h1>
  );
}
