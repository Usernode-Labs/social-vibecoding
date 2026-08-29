/**
 * The Activity feed's inline discussion: recent replies under a row, and a box
 * to add one without opening the row.
 *
 * ── What this replaces, and what it does not ───────────────────────────
 *
 * The feed already previewed comments, but only on ISSUE rows and only from
 * GitHub — `AppView._fillFeedComments` fetched the issue's GitHub thread and
 * wrote the last two into `.dev-feed-comments` by innerHTML. That preview is
 * untouched and still renders above this: it is the conversation happening on
 * the repository, and it is read-only here because it is read-only to us.
 *
 * This is the other conversation — the app's own thread for that item, the one
 * the topic page mounts under the card (`GroupChat.mountThread`). It is the
 * one a reply from the feed can actually land in, which is why the composer
 * belongs to it and not to the GitHub preview above. Both being visible is the
 * point: you see what has been said, and the box you type into is directly
 * under the messages it will join.
 *
 * ── Keyed by thread, loaded on sight ───────────────────────────────────
 *
 * State lives in ./feed-thread-store.ts, keyed `${type}:${ref}` rather than by
 * row — see that file for why. Loading waits for the row to come into view,
 * the same rule (and roughly the same 200px margin) the GitHub preview's
 * IntersectionObserver uses: a 20-row feed would otherwise open 20 requests on
 * paint to fill three lines each.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

import { useStoreState } from '../../../lib/use-store-state';
import {
  feedThreadStore,
  patchThread,
  readThread,
  threadKey,
  type FeedThreadMessage,
} from './feed-thread-store';

/** Two, matching the GitHub preview's FEED_COMMENT_PREVIEW above it. */
const PREVIEW = 2;

/** Fetch a few more than are shown, so "N earlier" is right without a count query. */
const FETCH_LIMIT = 20;

function demoQS(): string {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1' ? '&demo=1' : '';
  } catch {
    return '';
  }
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function MessageLine({ m }: { m: FeedThreadMessage }): ReactNode {
  return (
    <div className="flex gap-1.5 text-xs leading-snug">
      <span className="shrink-0 font-medium text-zinc-700 dark:text-zinc-300">{m.author}</span>
      {/* Plain text, never markdown and never innerHTML. This is the one
          surface in the feed that renders something a person typed, and it
          renders it as a text child so React escapes it — the topic page is
          where the full, formatted thread lives. */}
      <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400 break-words">{m.content}</span>
      <span className="shrink-0 text-zinc-400 dark:text-zinc-500">{relTime(m.createdAt)}</span>
    </div>
  );
}

export function FeedThread({
  slug, type, refId, canPost,
}: {
  slug: string;
  type: string;
  refId: number;
  canPost: boolean;
}): ReactNode {
  const key = threadKey(type, refId);
  const all = useStoreState(feedThreadStore);
  const state = all[key] || readThread(key);
  const hostRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    if (readThread(key).loading) return;
    patchThread(key, { loading: true, error: null });
    try {
      const qs = `thread_type=${encodeURIComponent(type)}&thread_ref=${encodeURIComponent(String(refId))}`
        + `&limit=${FETCH_LIMIT}${demoQS()}`;
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows = Array.isArray(data.messages) ? data.messages : [];
      // `msg_type` carries system and agent entries into this stream too. The
      // preview is for what PEOPLE said — a build notice under a feed row is
      // noise, and the row's own card already says where the work has got to.
      const human = rows.filter((r: any) => !r.msg_type || r.msg_type === 'chat');
      patchThread(key, {
        messages: human.slice(-PREVIEW).map((r: any) => ({
          id: r.id,
          author: r.username || 'someone',
          content: String(r.content || ''),
          createdAt: r.created_at,
        })),
        total: human.length,
        loading: false,
        loaded: true,
      });
    } catch {
      // A thread that will not load is a quiet row, not an error banner: the
      // card above it is the thing the viewer came for.
      patchThread(key, { loading: false, loaded: true, error: 'load' });
    }
  }, [key, slug, type, refId]);

  // Load when the row is near the viewport, once. `rootMargin` matches the
  // GitHub preview's, so both halves of a row's comment area arrive together
  // rather than one scrolling in behind the other.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return undefined;
    if (readThread(key).loaded || readThread(key).loading) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      void load();
      return undefined;
    }
    const obs = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        obs.unobserve(entry.target);
        void load();
      }
    }, { rootMargin: '200px 0px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [key, load]);

  const submit = useCallback(async () => {
    const content = draft.trim();
    if (!content || readThread(key).posting) return;
    patchThread(key, { posting: true, error: null });
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, thread_type: type, thread_ref: refId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDraft('');
      patchThread(key, { posting: false });
      // Re-read rather than append what we sent: the server assigns the id and
      // the timestamp, and this is also what picks up anything else posted to
      // the thread while the box was open.
      await load();
    } catch {
      patchThread(key, { posting: false, error: 'post' });
    }
  }, [draft, key, slug, type, refId, load]);

  const hidden = state.total - state.messages.length;

  return (
    <div ref={hostRef} className="dev-feed-thread">
      {state.messages.map((m) => <MessageLine key={m.id} m={m} />)}
      {hidden > 0 ? (
        <div className="text-xs text-zinc-400 dark:text-zinc-500">
          {`${hidden} earlier ${hidden === 1 ? 'reply' : 'replies'}`}
        </div>
      ) : null}
      {state.error === 'post' ? (
        <div className="text-xs text-rose-600 dark:text-rose-400">
          That didn’t send. Try again, or open the item to reply there.
        </div>
      ) : null}
      {canPost ? (
        <form
          className="flex items-center gap-2 pt-0.5"
          onSubmit={(e) => { e.preventDefault(); void submit(); }}
        >
          {/* A single-line input, not the thread composer. GroupChat's shell is
              a singleton — one `GroupChat.activeThread`, fixed ids, one draft
              scope — so a feed of twenty rows cannot each host one. This is
              deliberately the smaller thing: type a line, press enter. Anything
              that wants attachments, mentions or history opens the item. */}
          {/* WHITE, NOT `bg-zinc-100`. The thread renders BESIDE the row card,
              directly on the page ground — and `zinc-100` is #eaeaea in this
              shell's ramp (tailwind.config.js), which is that ground byte for
              byte. The box was therefore invisible: a placeholder and a caret
              floating on nothing, with no edge to say where the field was.
              Same bug, same fix as the header's control discs, one step
              further: those lift to zinc-50, and an input that a viewer is
              meant to type into takes the card surface plus a real border —
              the treatment #home-search-input already uses on the same
              ground. */}
          <input
            type="text"
            className={'min-w-0 flex-1 rounded-full border border-zinc-300 dark:border-zinc-700 '
              + 'bg-white dark:bg-zinc-800 px-3 py-1 '
              + 'text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 '
              + 'dark:placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-violet-500'}
            placeholder="Reply…"
            aria-label="Reply to this item"
            value={draft}
            disabled={state.posting}
            onChange={(e) => setDraft(e.target.value)}
            // The row is inside #dev-body's delegated click handler, which
            // opens the topic for a click anywhere on a card. Typing in here
            // must not also navigate away.
            onClick={(e) => e.stopPropagation()}
          />
          {/* `pill` + `xsText` is the bell drawer's invite-Accept box, which is
              the same object as this one: a text-xs primary action inside a
              row of a list. Through <Button> rather than written literally,
              per tests/shell-primitive-adoption.test.js. */}
          {draft.trim() ? (
            <Button
              type="submit"
              variant="pill"
              size="xsText"
              className="shrink-0 un-touch-target"
              disabled={state.posting}
              onClick={(e) => e.stopPropagation()}
            >
              {state.posting ? 'Sending…' : 'Reply'}
            </Button>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
