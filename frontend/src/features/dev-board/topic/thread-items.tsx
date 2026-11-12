/**
 * #6019 (threads, stage 3): the thread a request's or a change's page is in,
 * drawn under its root post (./request-head.tsx, ./change-head.tsx).
 *
 *   IN THIS THREAD                                   [🔔 Notify me]
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Dark mode toggle                                       › │
 *   │ Change #8 · Up for a vote · 2 replies                    │
 *   │   [m] @maya Works on my phone.                           │
 *   └──────────────────────────────────────────────────────────┘
 *
 * The other items in the thread, oldest first (./thread-model.ts words
 * them); a change's or a vote's newest replies fold under its row, and a tap
 * opens its page. The button is the viewer's Notify me / Mute for the whole
 * thread (routes/threads.js).
 *
 * 31 Oct 2026: on a page whose head has a ⋯ (`menuKey`), Notify me / Mute
 * and the moves are rows of that ⋯ (./thread-menu.ts), Unmute once muted,
 * and nothing of them sits under the list but a move's form, once its row
 * opened it. A page with no ⋯ keeps the button and the pills.
 *
 * Its first render is nothing: the thread is read in an effect, so the
 * markup the page first paints is the markup it painted before.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
import { FRESH, watch } from '../../../lib/live-reads';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/feed';
import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { BellIcon } from '@/components/ui/icons';
import { swatchFor } from '../../group-chat/swatch';
import {
  followButton,
  threadRows,
  type Phrase,
  type ThreadHere,
  type ThreadPayload,
} from './thread-model';
import { MOVE_LABELS, ThreadMoves, moveChoices, type MoveKind } from './thread-moves';
import { ThreadBallot } from './thread-ballot';
import { useThreadMenu, type ThreadMenuRow } from './thread-menu';
import { prefetchChangeDetail } from './topic-head';

function openTopic(open: { kind: string; id: number }): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av.openTopic === 'function' && open.id > 0) av.openTopic(open.kind, open.id);
}

/** The project the page is on, as AppView has it. */
export function pageSlug(): string | null {
  const w = typeof window !== 'undefined' ? (window as any) : null;
  return (w && w.AppView && w.AppView.appData && w.AppView.appData.slug) || (w && w.App && w.App.currentApp) || null;
}

/**
 * The reads a thread page owns, for lib/live-reads.ts (#6231): its own thread
 * (today's rule), and the address a change's move is announced at
 * (`/api/apps/<slug>/threads/change/<id>`) for any change the last read
 * listed — the ones ./thread-model.ts `threadLayout` turns into `changes`. The
 * set is the caller's, read when the trigger arrives, so ids from a newer read
 * count. Pure.
 */
export function threadReads(pathname: string | null, slug: string | null, changeIds: ReadonlySet<number>): (url: URL) => boolean {
  const prefix = slug ? `/api/apps/${encodeURIComponent(slug)}/threads/change/` : null;
  return (url) => {
    if (!pathname) return false;
    if (url.pathname === pathname) return true;
    if (!prefix || !url.pathname.startsWith(prefix)) return false;
    const id = Number(url.pathname.slice(prefix.length));
    return Number.isInteger(id) && changeIds.has(id);
  };
}

/**
 * #6604: a thread's read, started when its page OPENS rather than when the
 * page's root post has painted. `public/js/app-view.js` calls
 * `UsernodeReact.devBoard.prefetchThread(slug, n)` in the same tick as its
 * item read, so the two go out together. One promise per path, kept 10 s and
 * consumed once (the page's first read takes it). Its answer also starts the
 * read of each change the thread lists, before any of them renders.
 */
export const PREFETCH_TTL_MS = 10_000;

interface PrefetchedThread {
  at: number;
  settled: boolean;
  data: ThreadPayload | null;
  promise: Promise<ThreadPayload | null>;
}

const prefetchedThreads = new Map<string, PrefetchedThread>();

export function threadPath(slug: string, number: number): string {
  return `/api/apps/${encodeURIComponent(slug)}/threads/${number}`;
}

/** Start (or join, within 10 s) a thread's own read. Returns its promise. */
export function prefetchThread(slug: string | null, number: number | null): Promise<ThreadPayload | null> | null {
  if (!slug || !number) return null;
  const path = threadPath(slug, number);
  const hit = prefetchedThreads.get(path);
  if (hit && Date.now() - hit.at < PREFETCH_TTL_MS) return hit.promise;
  const entry: PrefetchedThread = {
    at: Date.now(), settled: false, data: null, promise: Promise.resolve(null),
  };
  entry.promise = fetch(path, { credentials: 'same-origin' })
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => {
      entry.settled = true;
      entry.data = json && Array.isArray(json.items) ? json : null;
      for (const item of entry.data?.items || []) {
        if (item && item.type === 'change' && Number.isInteger(Number(item.id))) prefetchChangeDetail(item);
      }
      return entry.data;
    })
    .catch(() => { entry.settled = true; return null; });
  prefetchedThreads.set(path, entry);
  return entry.promise;
}

/** The prefetched answer, if it is already here; leaves the entry in place. */
export function peekThread(path: string | null): ThreadPayload | null {
  if (!path) return null;
  const hit = prefetchedThreads.get(path);
  if (!hit || !hit.settled || Date.now() - hit.at >= PREFETCH_TTL_MS) return null;
  return hit.data;
}

/** Take the prefetched read for `path`, once. */
function takePrefetched(path: string): PrefetchedThread | null {
  const hit = prefetchedThreads.get(path);
  if (!hit) return null;
  if (Date.now() - hit.at >= PREFETCH_TTL_MS) { prefetchedThreads.delete(path); return null; }
  prefetchedThreads.delete(path);
  return hit;
}

/**
 * A page's read of its thread (routes/threads.js), and a way to read it
 * again after something on the page changed it (a vote, a move). Null until
 * it is read, so the page's first paint is the one it had before.
 */
export function useThreadPayload(slug: string | null, number: number | null, threadId: number | null = null, skip = false, asChange = false): {
  data: ThreadPayload | null;
  setData: (update: (was: ThreadPayload | null) => ThreadPayload | null) => void;
  reread: () => void;
  /** True until the first read of this path settles, whether it answers or fails. */
  loading: boolean;
} {
  const path = skip ? null : number && slug ? `/api/apps/${encodeURIComponent(slug)}/threads/${number}${asChange ? '?as=change' : ''}`
    : threadId ? `/api/threads/${threadId}` : null;
  // #6604: a read another module started before this page mounted (the
  // topic's own open, prefetchThread) is already the page's first read, so
  // its answer is here on the first render rather than a moment later.
  const peeked = peekThread(path);
  const [data, setData] = useState<ThreadPayload | null>(peeked);
  // Read again after a move changed the thread (./thread-moves.tsx).
  const [revision, setRevision] = useState(0);
  // #6387: the path whose read settled, so "still loading" and "nothing to
  // show" stop looking the same: a failed read clears it too.
  const [settledPath, setSettledPath] = useState<string | null>(peeked ? path : null);
  // #6139: a gap (a dropped socket, a sleeping tab) reads it again, past any saved copy.
  const freshNext = useRef(false);
  const readPath = useRef<string | null>(peeked ? path : null);
  // #6231: the changes this page last read, so a move announced by the
  // change's own id (`thread_changed`) still reaches this thread.
  const changeIds = useRef<Set<number>>(new Set());
  // A re-read of the same path keeps `data`, so it never shows as loading.
  const loading = !!path && !data && settledPath !== path;
  useEffect(() => {
    // Reading the same thread again keeps what the page shows, also if that
    // read fails; another thread starts empty.
    const again = !!path && readPath.current === path;
    readPath.current = path;
    const ids = changeIds.current;
    if (!again) { setData(null); ids.clear(); }
    if (!path) return undefined;
    let live = true;
    const fresh = freshNext.current;
    freshNext.current = false;
    const init: RequestInit = { credentials: 'same-origin', ...(fresh ? FRESH : {}) };
    // #6604: the read started when the topic opened answers this one, once.
    const pre = fresh ? null : takePrefetched(path);
    const read: Promise<ThreadPayload | null> = pre
      ? pre.promise
      : fetch(path, init)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
    read
      .then((json) => {
        if (!live) return;
        setSettledPath(path);
        if (json && Array.isArray(json.items)) {
          ids.clear();
          for (const item of json.items) {
            if (item && item.type === 'change' && Number.isInteger(Number(item.id))) ids.add(Number(item.id));
          }
          setData(json);
        } else if (!again) setData(null);
      });
    const pathname = path.split('?')[0];
    const unwatch = watch(() => {
      freshNext.current = true;
      setRevision((n) => n + 1);
    }, { reads: threadReads(pathname, slug, ids) });
    return () => { live = false; unwatch(); };
  }, [path, revision, slug]);
  return { data, setData, reread: () => setRevision((n) => n + 1), loading };
}

export function ThreadItems({ slug, number = null, asChange = false, threadId = null, here, payload, items, onChanged, menuKey }: {
  slug: string | null;
  /** Any number in the thread: the request's, or the change's own. */
  number?: number | null;
  /**
   * `number` is the change's own pull request number: read that change's
   * thread, which a request sharing the number does not lead.
   */
  asChange?: boolean;
  /** Or the thread itself, for a decision that has no number. */
  threadId?: number | null;
  here: ThreadHere;
  /** The page's own read, when it has one (./request-head.tsx): then this reads nothing itself. */
  payload?: ThreadPayload | null;
  /** The items the list names, when the page draws the rest itself. */
  items?: ThreadPayload['items'];
  onChanged?: () => void;
  /** The key of the page's ⋯, which lists Notify me / Mute and the moves. Without one, they are drawn here. */
  menuKey?: string | null;
}): ReactNode {
  const t = useMessages('project');
  const controlled = payload !== undefined;
  const own = useThreadPayload(slug, number, threadId, controlled, asChange);
  const data = controlled ? payload : own.data;
  const setData = controlled ? null : own.setData;
  const changed = onChanged || own.reread;
  const [follow, setFollow] = useState<ThreadPayload['follow'] | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setFollow(undefined); }, [data]);
  const shown = useMemo(() => (data && items ? { ...data, items } : data), [data, items]);
  const rows = useMemo(() => threadRows(shown, here), [shown, here.type, here.id]);
  const followNow = follow === undefined ? (data ? data.follow : null) : follow;
  const button = followButton(followNow);
  const [moveOpen, setMoveOpen] = useState<MoveKind | null>(null);
  useEffect(() => { setMoveOpen(null); }, [data?.thread.id]);
  const inMenu = !!menuKey;
  const moves = slug && data && data.follow ? moveChoices(data) : [];
  const menuRows: ThreadMenuRow[] = inMenu ? [
    ...(button ? [{
      // Muted, the row says what it does: Unmute.
      label: t(button.pressed ? 'project:topic.thread.follow.unmute' : button.label),
      title: t(button.hint),
      icon: followNow?.state === 'following' ? 'mute' : 'notify',
      act: () => { void press(); },
    }] : []),
    ...moves.map((kind) => ({ label: t(MOVE_LABELS[kind]), icon: 'move', act: () => setMoveOpen(kind) })),
  ] : [];
  useThreadMenu(menuKey, 'thread', menuRows);
  const pending = !!data && (data.moves || []).length > 0;
  if (!data || (!rows.length && !(inMenu ? (pending || moveOpen) : button))) return null;
  const say = (p: Phrase | string) => (typeof p === 'string' ? p : t(p.id, p.values));

  async function press() {
    if (busy || !button || !data) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/threads/${data.thread.id}/follow`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notify: button.next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const now = await res.json();
      const next = { state: now.state, chosen: !!now.chosen };
      if (setData) setData((was) => (was ? { ...was, follow: next } : was));
      else setFollow(next);
    } catch {
      // The button says what is stored; a write that failed changed nothing.
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-3" data-thread={data.thread.id} aria-label={t('project:topic.thread.label')}>
      {rows.length || (button && !inMenu) ? <div className="flex items-center justify-between gap-2">
        {rows.length
          ? <SectionHeader className="px-0 pb-2 pt-2">{t('project:topic.thread.label')}</SectionHeader>
          : <span />}
        {button && !inMenu ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            layout="iconRow"
            className="shrink-0"
            data-thread-follow={followNow ? followNow.state : ''}
            aria-pressed={button.pressed}
            disabled={busy}
            title={t(button.hint)}
            onClick={() => { void press(); }}
          >
            <BellIcon className="h-4 w-4" aria-hidden="true" />
            {t(button.label)}
          </Button>
        ) : null}
      </div> : null}
      {rows.length ? (
        <GroupedList data-thread-items={data.thread.id}>
          {rows.map((row) => (
            <Fragment key={row.key}>
              <ListRow
                as="button"
                title={say(row.title)}
                tooltip={say(row.title)}
                subtitle={row.facts.map(say).join(' · ')}
                data-thread-item={row.key}
                onClick={() => openTopic(row.open)}
              />
              {row.folded.length ? (
                <div className="flex flex-col gap-1 px-4 pb-3" data-thread-fold={row.key}>
                  {row.folded.map((reply) => (
                    <span key={reply.id} className="msgx-thread-line">
                      <span className="msgx-thread-face">
                        <Avatar shape="square" size="sm" color={swatchFor(reply.username)} aria-hidden="true">
                          {reply.username.charAt(0).toUpperCase()}
                        </Avatar>
                      </span>
                      <strong className="msgx-thread-line-name">{reply.bot ? reply.username : `@${reply.username}`}</strong>
                      <span className="msgx-thread-line-text">{reply.text}</span>
                    </span>
                  ))}
                </div>
              ) : null}
            </Fragment>
          ))}
        </GroupedList>
      ) : null}
      {/* Stage 6: competing changes, as one ballot. A request's page draws
          it with its changes (./thread-changes.tsx). */}
      {data.follow && here.type !== 'request' ? <ThreadBallot slug={slug} data={data} here={here} onChanged={changed} /> : null}
      {/* Stage 6: merging and splitting, for a signed-in viewer. */}
      {slug && data.follow ? (
        inMenu
          ? <ThreadMoves slug={slug} data={data} onChanged={changed} open={moveOpen} onOpen={setMoveOpen} pills={false} />
          : <ThreadMoves slug={slug} data={data} onChanged={changed} />
      ) : null}
    </section>
  );
}
