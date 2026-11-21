/**
 * THE HEADER PILL'S WAY OUT IN A PANEL (18 Nov 2026).
 *
 * A request's or a change's page is drawn in three places: its own page, the
 * Workshop's side panel beside the list, and the column beside Homeroom
 * bot's list (an embedded copy of the platform, ../../side-panel/). Each
 * used to draw its own chrome around the page: a bar with × and "Open as a
 * page" over the Workshop's panel, a second header over the bot's column.
 * Now the page's own header, the sheet's bar, is one pill on every surface,
 * and in a panel these two discs end it:
 *
 *   ↗  the same item as a full page
 *   ×  closes the panel
 *
 * Both are rendered everywhere and app.css shows them only inside a panel,
 * so the bar's markup is the same on every surface. What a press does is
 * decided at the moment of the press, from where the bar is: inside the
 * Workshop's panel it asks that panel (../workshop/side-actions.ts); inside
 * the embedded column it asks the top document's panel controller, which is
 * the same origin.
 */

import type { MouseEvent, ReactNode } from 'react';

import { ExpandIcon, ListBulletIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../../lib/i18n/react';
import { isEmbeddedPanel } from '../../../lib/side-panel-mode';
import { workshopSideActions } from '../workshop/side-actions';

type TopPanel = { close?: () => void; expand?: () => void; showList?: () => void };

function topPanel(): TopPanel | null {
  if (typeof window === 'undefined' || !isEmbeddedPanel()) return null;
  try {
    return ((window.parent as any)?.UsernodeReact?.sidePanel as TopPanel) || null;
  } catch {
    return null;
  }
}

/** What a press on one of the two discs does, from where the bar is. Exported for tests. */
export function act(event: Pick<MouseEvent<HTMLButtonElement>, 'currentTarget'>, which: 'expand' | 'close'): void {
  const inWorkshop = !!event.currentTarget.closest('.dev-ws-side');
  if (inWorkshop) {
    const ws = workshopSideActions();
    if (which === 'expand') ws?.openFull();
    else ws?.close();
    return;
  }
  const top = topPanel();
  if (which === 'expand') top?.expand?.();
  else top?.close?.();
}

/**
 * The way back to the bot's thread list while the list is hidden (#6973).
 * Drawn first in the head, as a private thread draws it, on every surface
 * and shown by app.css only beside the bot page's hidden list.
 */
export function ThreadShowList(): ReactNode {
  const t = useMessages('project');
  return (
    <button
      type="button"
      className="messages-thread-action messages-thread-back dev-thread-show-list"
      data-thread-show-list=""
      aria-label={t('project:sidePanel.showList')}
      title={t('project:sidePanel.showList')}
      onClick={() => topPanel()?.showList?.()}
    >
      <ListBulletIcon aria-hidden="true" />
    </button>
  );
}

export function ThreadExits(): ReactNode {
  const t = useMessages('project');
  return (
    <span className="dev-thread-exits" data-thread-exits="">
      <button
        type="button"
        className="messages-thread-action dev-thread-exit"
        data-thread-exit="expand"
        aria-label={t('project:sidePanel.openAsPage')}
        title={t('project:sidePanel.openAsPage')}
        onClick={(e) => act(e, 'expand')}
      >
        <ExpandIcon aria-hidden="true" />
      </button>
      <button
        type="button"
        className="messages-thread-action dev-thread-exit"
        data-thread-exit="close"
        aria-label={t('core:common.close')}
        title={t('core:common.close')}
        onClick={(e) => act(e, 'close')}
      >
        <XIcon aria-hidden="true" />
      </button>
    </span>
  );
}
