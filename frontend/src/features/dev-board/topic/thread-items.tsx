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

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';
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
 * A page's read of its thread (routes/threads.js), and a way to read it
 * again after something on the page changed it (a vote, a move). Null until
 * it is read, so the page's first paint is the one it had before.
 */
export function useThreadPayload(slug: string | null, number: number | null, threadId: number | null = null, skip = false, asChange = false): {
  data: ThreadPayload | null;
  setData: (update: (was: ThreadPayload | null) => ThreadPayload | null) => void;
  reread: () => void;
} {
  const [data, setData] = useState<ThreadPayload | null>(null);
  // Read again after a move changed the thread (./thread-moves.tsx).
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!revision) setData(null);
    const path = skip ? null : number && slug ? `/api/apps/${encodeURIComponent(slug)}/threads/${number}${asChange ? '?as=change' : ''}`
      : threadId ? `/api/threads/${threadId}` : null;
    if (!path) return undefined;
    let live = true;
    fetch(path, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (live) setData(json && Array.isArray(json.items) ? json : null); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [slug, number, threadId, revision, skip, asChange]);
  return { data, setData, reread: () => setRevision((n) => n + 1) };
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
