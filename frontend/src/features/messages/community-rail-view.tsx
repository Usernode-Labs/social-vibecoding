/**
 * The community rail and its channel drawer (#6992).
 *
 * ── What the screen does ──────────────────────────────────────────────
 *
 * The rail is Messages' first column: Direct messages, then Homeroom, then
 * every community the viewer is in, each a rounded square with its icon and
 * what is new. Picking one replaces the people list with that community's
 * channels — #general and its topics — and picking a channel opens it, in the
 * room it already uses. Direct messages keeps exactly today's tree.
 *
 * The channel list is drawn with the rows Messages already draws
 * (`.messages-conversation-row`, the `#` tile, the name and a preview), so a
 * channel row here and a channel row there are the same row.
 *
 * ── The rail's way back ───────────────────────────────────────────────
 *
 * A #general opened from the drawer returns to the list, not to the
 * community's Hub: one press got you here, and Messages is where you were.
 * `markRailReturn` is set by the row's press, and the header that matches it
 * words its back arrow "Messages"; the header's own unmount (leaving the
 * channel) clears it, so a channel opened another way keeps its own way back.
 */

import { Fragment, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';

import { ChatIcon } from '@/components/ui/icons';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { useMessages } from '../../lib/i18n/react';
import { AppIconContent } from '../apps/app-card-view';
import { audienceLine, useCachedCommunity } from '../dev-board/workshop/community-card';
import { openChannelHub } from './channel-hub';
import { channelRows, railUnreadShown, type RailEntry } from './community-rail';

// ── Where an opened channel goes back to ──────────────────────────────

let railReturnKey: string | null = null;
const railListeners = new Set<() => void>();

function emitRail(): void {
  for (const listener of railListeners) listener();
}

function subscribeRail(listener: () => void): () => void {
  railListeners.add(listener);
  return () => { railListeners.delete(listener); };
}

function railReturnValue(): string | null {
  return railReturnKey;
}

/** A drawer row was pressed: its channel's back arrow should say Messages. */
export function markRailReturn(key: string): void {
  railReturnKey = key;
  emitRail();
}

export function clearRailReturn(): void {
  if (railReturnKey == null) return;
  railReturnKey = null;
  emitRail();
}

/**
 * Whether THIS header's channel is the one the drawer opened. Leaving the
 * channel (this header going away) ends the return; a different channel's
 * header never claims it.
 */
export function useRailReturn(want: string | null): boolean {
  const current = useSyncExternalStore(subscribeRail, railReturnValue, () => null);
  useEffect(() => () => {
    if (railReturnKey === want) clearRailReturn();
  }, [want]);
  return !!want && current === want;
}

// ── The rail ──────────────────────────────────────────────────────────

function RailTile({ entry, on, onPick }: { entry: RailEntry; on: boolean; onPick: (key: string) => void }) {
  const t = useMessages('messages');
  const name = entry.kind === 'dm'
    ? t('messages:rail.dm')
    : entry.kind === 'homeroom'
      ? t('messages:rail.homeroom')
      : entry.name;
  const shown = railUnreadShown(entry.unread);
  const label = shown
    ? t(entry.unread === 1 ? 'messages:rail.tile_one' : 'messages:rail.tile_other', { name, count: entry.unread })
    : name;
  // The icon is the same record an app's own tile draws (app-card-view.tsx):
  // its picture, else its palette emoji, else the first letter of its name.
  const record = { name: entry.name || name, icon_url: entry.iconUrl, icon_emoji: entry.iconEmoji };
  return (
    <button
      type="button"
      className={`messages-rail-tile${on ? ' messages-rail-tile-on' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      data-rail={entry.key}
      onClick={() => onPick(entry.key)}
    >
      <span className="messages-rail-glyph" aria-hidden="true">
        {entry.kind === 'dm'
          ? <ChatIcon />
          : <AppIconContent app={record as never} />}
      </span>
      <span className="messages-rail-badge" data-rail-unread={shown || '0'} hidden={!shown}>{shown}</span>
    </button>
  );
}

export function CommunityRail({ entries, pick, onPick }: {
  entries: RailEntry[];
  pick: string;
  onPick: (key: string) => void;
}): ReactNode {
  const t = useMessages('messages');
  return (
    <nav className="messages-rail" aria-label={t('messages:rail.label')} data-community-rail="">
      {entries.map((entry, index) => (
        <Fragment key={entry.key}>
          {index === 1 ? <span className="messages-rail-divider" aria-hidden="true" /> : null}
          <RailTile entry={entry} on={entry.key === pick} onPick={onPick} />
        </Fragment>
      ))}
    </nav>
  );
}

// ── The drawer ────────────────────────────────────────────────────────

/**
 * The drawer's loading state, at the CHANNEL row's own geometry. It is the
 * same `.messages-conversation-row` wrapper the real row uses (the 66px
 * height, the padding, the inset separator), with the 44px leading tile the
 * channel's `#` sits in, so the rows land on their own outlines.
 */
function ChannelRowsSkeleton() {
  const t = useMessages('messages');
  return (
    <SkeletonGroup label={t('messages:drawer.channels')}>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="messages-conversation-row messages-channel-row">
          <Skeleton shape="block" className="w-11 h-11 rounded-xl" />
          <div className="min-w-0 flex-1">
            <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
            <Skeleton shape="muted" className={`mt-1.5 ${i % 3 ? 'w-3/5' : 'w-2/5'}`} />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

export function ChannelDrawer({ entry, query }: { entry: RailEntry; query: string }): ReactNode {
  const t = useMessages('messages');
  const record = useCachedCommunity(entry.slug || '');
  const places = record?.places || null;
  const rows = useMemo(() => channelRows(entry, places, query), [entry, places, query]);
  const loading = !!entry.slug && !record;
  const name = entry.kind === 'homeroom' ? t('messages:rail.homeroom') : entry.name;
  const line = record ? audienceLine(record) : null;
  return (
    <div className="messages-channel-drawer" aria-label={name} data-drawer-community={entry.slug || ''}>
      <header className="messages-drawer-head">
        <div className="messages-drawer-title">
          <div className="messages-drawer-name" title={name}>{name}</div>
          {line ? <div className="messages-drawer-sub">{line}</div> : null}
        </div>
        <button
          type="button"
          className="messages-drawer-hub"
          onClick={() => openChannelHub(entry.slug || null)}
        >
          {t('messages:drawer.hub')}
        </button>
      </header>
      <h3 className="messages-section-head">
        <span className="messages-section-name">{t('messages:drawer.channels')}</span>
      </h3>
      <div className="messages-section-card" data-drawer-card="">
        {rows.map((row) => (
          <a
            key={row.key}
            href={row.target}
            data-drawer-channel={row.handle}
            className="messages-conversation-row messages-channel-row"
            onClick={(event) => {
              // A modified press opens its own tab: nothing here was navigated.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              // Only a channel that opens ON this screen has a Messages way
              // back; a topic opens its project's page, whose own header is
              // the way back from there.
              if (row.target.startsWith('#messages')) markRailReturn(entry.key);
            }}
          >
            <span className="messages-inbox-tile messages-channel-tile" aria-hidden="true">{row.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="messages-row-line">
                <span className="messages-row-name">{row.name}</span>
                {row.unread
                  ? <span className="messages-unread">{t(row.unread === 1 ? 'messages:drawer.unread_one' : 'messages:drawer.unread_other', { shown: railUnreadShown(row.unread), count: row.unread })}</span>
                  : null}
              </div>
              <div className="messages-row-line">
                <span className="messages-row-preview">{row.preview || t('messages:inbox.noMessages')}</span>
              </div>
            </div>
          </a>
        ))}
        {loading ? <ChannelRowsSkeleton /> : null}
      </div>
      {!rows.length && !loading
        ? <div className="messages-state"><p>{t('messages:drawer.noMatch', { query: query.trim() })}</p></div>
        : null}
    </div>
  );
}
