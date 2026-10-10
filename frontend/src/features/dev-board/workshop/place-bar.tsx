/**
 * #4417: THE PLACE BAR, where the four tabs were.
 *
 * On a phone, one bar under the header in the community's colour
 * (`--community-tint`), continuing it, as the band of tabs did: the tray's
 * button (./places-tray.tsx), then the name of the place you are on, with a
 * # for a channel —
 *
 *   [▤•]  # homeroom-bot
 *
 * The button says whether the tray is open (`aria-expanded`), and carries a
 * dot, with an `sr-only` phrase, while something in the project waits for
 * you: votes owed, or unread in a channel you are not reading.
 *
 * On a wide window the list is in the section column beside the strip
 * (../../nav/section-column.tsx), so the bar is the page's title row that
 * names the place, in the page's own ink, with no button (app.css).
 *
 * It keeps the band's box (`.dev-ws-tabs.dev-ws-band` > `.dev-ws-tabtrack`,
 * `data-ws-band`): it is what pins under the header, and what the pinned
 * pane head and the pull to refresh are measured against (workshop.tsx).
 */

import type { ReactNode, Ref } from 'react';

import { SidebarIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { listText, t as translate } from '../../../lib/i18n/runtime';
import { placeHandle, placeName, type PlaceKey } from './places';

/** What waits for you, aloud: "29 to vote, 4 unread", or null for nothing. Pure. */
export function waitingPhrase(owed: number, unread: number): string | null {
  const parts: string[] = [];
  if (owed > 0) parts.push(translate('project:places.bar.toVote', { count: owed }));
  if (unread > 0) parts.push(translate('project:places.bar.unread', { count: unread }));
  return parts.length ? listText(parts) : null;
}

export function PlaceBar({ name, place, owed, unread, open, trayId, onToggle, barRef, buttonRef }: {
  /** The project's name: the button is "<name>'s places". */
  name: string;
  place: PlaceKey;
  owed: number;
  /** Unread across the project's channels, less the one on screen. */
  unread: number;
  open: boolean;
  trayId: string;
  onToggle: () => void;
  barRef?: (el: HTMLElement | null) => void;
  buttonRef?: Ref<HTMLButtonElement>;
}): ReactNode {
  const t = useMessages('project');
  const handle = placeHandle(place);
  const waiting = waitingPhrase(owed, unread);
  return (
    <div ref={barRef} className="dev-ws-tabs dev-ws-band dev-ws-placebar" data-ws-band="" data-place-bar={place}>
      <div className="dev-ws-tabtrack">
        <button
          ref={buttonRef}
          type="button"
          className="dev-ws-places-btn"
          data-places-btn=""
          aria-label={name ? t('project:places.bar.button', { project: name }) : t('project:places.bar.buttonUnnamed')}
          aria-expanded={open}
          aria-controls={open ? trayId : undefined}
          onClick={onToggle}
        >
          <SidebarIcon className="dev-ws-places-btn-glyph" aria-hidden="true" />
          {waiting ? (
            <>
              <span className="dev-ws-places-dot" data-places-waiting="" aria-hidden="true" />
              <span className="sr-only">{` ${t('project:places.bar.waitingAloud', { waiting })}`}</span>
            </>
          ) : null}
        </button>
        <h2 className="dev-ws-place-title" data-place-title="">
          {handle ? <span className="dev-ws-place-title-hash">#</span> : null}
          {handle || placeName(place)}
        </h2>
      </div>
    </div>
  );
}
