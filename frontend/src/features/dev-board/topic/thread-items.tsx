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
import { ThreadMoves } from './thread-moves';
import { ThreadBallot } from './thread-ballot';

function openTopic(open: { kind: string; id: number }): void {
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (av && typeof av.openTopic === 'function' && open.id > 0) av.openTopic(open.kind, open.id);
}

/** The project the page is on, as AppView has it. */
export function pageSlug(): string | null {
  const w = typeof window !== 'undefined' ? (window as any) : null;
  return (w && w.AppView && w.AppView.appData && w.AppView.appData.slug) || (w && w.App && w.App.currentApp) || null;
}

export function ThreadItems({ slug, number = null, threadId = null, here }: {
  slug: string | null;
  /** Any number in the thread: the request's, or the change's own. */
  number?: number | null;
  /** Or the thread itself, for a decision that has no number. */
  threadId?: number | null;
  here: ThreadHere;
}): ReactNode {
  const t = useMessages('project');
  const [data, setData] = useState<ThreadPayload | null>(null);
  const [busy, setBusy] = useState(false);
  // Read again after a move changed the thread (./thread-moves.tsx).
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!revision) setData(null);
    const path = number && slug ? `/api/apps/${encodeURIComponent(slug)}/threads/${number}`
      : threadId ? `/api/threads/${threadId}` : null;
    if (!path) return undefined;
    let live = true;
    fetch(path, { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => { if (live) setData(json && Array.isArray(json.items) ? json : null); })
      .catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [slug, number, threadId, revision]);
  const rows = useMemo(() => threadRows(data, here), [data, here.type, here.id]);
  const button = followButton(data ? data.follow : null);
  if (!data || (!rows.length && !button)) return null;
  const say = (p: Phrase | string) => (typeof p === 'string' ? p : t(p.id, p.values));

  const press = async () => {
    if (busy || !button) return;
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
      setData((was) => (was ? { ...was, follow: { state: now.state, chosen: !!now.chosen } } : was));
    } catch {
      // The button says what is stored; a write that failed changed nothing.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-3" data-thread={data.thread.id} aria-label={t('project:topic.thread.label')}>
      <div className="flex items-center justify-between gap-2">
        {rows.length
          ? <SectionHeader className="px-0 pb-2 pt-2">{t('project:topic.thread.label')}</SectionHeader>
          : <span />}
        {button ? (
          <Button
            type="button"
            variant="pillNeutral"
            size="sm"
            ink="neutral"
            layout="iconRow"
            className="shrink-0"
            data-thread-follow={data.follow ? data.follow.state : ''}
            aria-pressed={button.pressed}
            disabled={busy}
            title={t(button.hint)}
            onClick={() => { void press(); }}
          >
            <BellIcon className="h-4 w-4" aria-hidden="true" />
            {t(button.label)}
          </Button>
        ) : null}
      </div>
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
      {/* Stage 6: competing changes, as one ballot. */}
      {data.follow ? <ThreadBallot data={data} onChanged={() => setRevision((n) => n + 1)} /> : null}
      {/* Stage 6: merging and splitting, for a signed-in viewer. */}
      {slug && data.follow ? <ThreadMoves slug={slug} data={data} onChanged={() => setRevision((n) => n + 1)} /> : null}
    </section>
  );
}
