/**
 * #platform-rail-conversations — the conversations nested under Messages in
 * the desktop's sidebar of rows (v3, 18 Oct 2026; ./sidebar-rows.ts).
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * While the inbox is the screen, Messages opens under its row: the five most
 * recent conversations under the inbox's own headings (Agents, People), then
 * All messages, which is the whole list as the page, with its search and its
 * previews. Which five, and why, is ../messages/rail-inbox.ts; the list's own
 * module works them out and publishes them, so this draws plain rows. The
 * one you have open is lit when it is among the five, and adds no row when
 * it is not (#21: Messages stays lit then); with nothing open, All messages
 * is. The Messages row keeps `aria-current` and gives its fill to the row
 * lit under it (app.css).
 *
 * It is the column the conversations had beside the strip, moved into the
 * sidebar: on a desktop the inbox draws one pane at a time
 * (../messages/index.tsx `messages-list-in-rail`, `messages-list-page`).
 *
 * ── Where it is, and when ─────────────────────────────────────────────
 *
 * Right after the Messages tab. The element is there at every width and on
 * every screen, empty while shut, so the bar's sibling order is one order;
 * app.css draws nothing of it under 768px. It opens and shuts on the clock
 * ./rail-nest.tsx keeps, so moving to a community folds it up as that
 * community's places fold down.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * Shut, and so empty: the sidebar's width is known only in an effect, and
 * the rows only once the inbox has loaded.
 */

import { useId, type MouseEvent } from 'react';

import { ChatsIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { INBOX_SECTIONS, type InboxSection } from '../messages/inbox';
import { railInboxStore, type RailConversation } from '../messages/rail-inbox';
import { navStore } from './nav-store.js';
import { NestSlot } from './rail-nest';
import { useSidebarRows } from './sidebar-rows';

/** The inbox's own headings. */
const HEADS: Record<InboxSection, string> = {
  agents: 'messages:inbox.section.agents',
  people: 'messages:inbox.section.people',
};

function isNativeClick(event: MouseEvent): boolean {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return true;
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function ConversationLink({ row, lit }: { row: RailConversation; lit: boolean }) {
  const t = useMessages('messages');
  return (
    <a
      className="platform-rail-sub"
      href={row.href}
      data-rail-conversation={row.key}
      aria-current={lit ? 'page' : undefined}
      title={row.name}
      onClick={(event) => {
        if (isNativeClick(event)) return;
        // Its address is the page's already: choose it again rather than navigate nowhere.
        if (window.location.hash === row.href) {
          event.preventDefault();
          row.reselect?.();
        }
      }}
    >
      <span className="platform-rail-face" aria-hidden="true">{row.lead}</span>
      <span className="platform-rail-sub-name">{row.name}</span>
      {row.unread > 0 ? (
        <span className="platform-rail-sub-count" aria-label={t('messages:inbox.unread', { count: row.unread })}>
          {row.unread > 99 ? '99+' : String(row.unread)}
        </span>
      ) : null}
    </a>
  );
}

export function RailConversations() {
  const t = useMessages('core');
  const tm = useMessages('messages');
  const id = useId();
  const { screen, tab } = useStoreState(navStore);
  const sidebarRows = useSidebarRows();
  const { rows, openKey, page } = useStoreState(railInboxStore);
  const open = sidebarRows && screen === 'messages-screen' && tab === 'messages';
  return (
    <div id="platform-rail-conversations" className="platform-rail-conversations">
      <NestSlot
        open={open}
        className="platform-rail-nest"
        role="group"
        aria-label={t('core:rail.conversations')}
        rows=".platform-rail-sub, .platform-rail-subhead"
      >
        {INBOX_SECTIONS.map((section) => {
          const list = rows.filter((row) => row.section === section);
          if (!list.length) return null;
          const head = `${id}-${section}`;
          return (
            <div key={section} className="platform-rail-group" data-rail-headed="" role="group" aria-labelledby={head}>
              <div id={head} className="platform-rail-subhead">{tm(HEADS[section])}</div>
              {list.map((row) => <ConversationLink key={row.key} row={row} lit={!page && row.key === openKey} />)}
            </div>
          );
        })}
        <div className="platform-rail-group">
          <a
            className="platform-rail-sub"
            href="#messages"
            data-rail-all-messages=""
            aria-current={page ? 'page' : undefined}
            onClick={(event) => {
              if (isNativeClick(event)) return;
              if (window.location.hash === '#messages') event.preventDefault();
            }}
          >
            <ChatsIcon className="platform-rail-sub-glyph" aria-hidden="true" />
            <span className="platform-rail-sub-name">{t('core:rail.allMessages')}</span>
          </a>
        </div>
      </NestSlot>
    </div>
  );
}
