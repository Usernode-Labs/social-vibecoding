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
import { SendIcon } from '@/components/ui/icons';
import { Textarea } from '@/components/ui/textarea';

import { useAutoGrow } from '../../../lib/use-auto-grow';
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

/**
 * Turn the chat endpoint's oldest-first rows into the compact human preview.
 *
 * The websocket command that creates a reply is named `chat`, but persisted
 * human rows use `msg_type: "message"`. Keep untyped legacy rows too; every
 * other kind is a system/event entry that the card itself already represents.
 */
export function feedThreadPreview(rows: any[]): {
  messages: FeedThreadMessage[];
  total: number;
} {
  const human = rows.filter((r: any) => !r.msg_type || r.msg_type === 'message');
  return {
    messages: human.slice(-PREVIEW).map((r: any) => ({
      id: r.id,
      author: r.username || 'someone',
      content: String(r.content || ''),
      createdAt: r.created_at,
    })),
    total: human.length,
  };
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

/**
 * The compact composer each Activity row owns.
 *
 * It stays separate from FeedThread's loading/posting state so the two pieces
 * that make #1584 visible are executable in isolation: the controlled value
 * grows a textarea, and an always-present arrow sends it. Plain Enter is not
 * intercepted — it adds a line; submission belongs to the adjacent arrow.
 */
export function FeedReplyComposer({
  draft, posting, onDraftChange, onSubmit,
}: {
  draft: string;
  posting: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
}): ReactNode {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(inputRef, draft);

  return (
    <form
      className="flex items-end gap-2 pt-0.5"
      onSubmit={(e) => { e.preventDefault(); void onSubmit(); }}
      // The row is inside #dev-body's delegated click handler, which opens
      // the topic for a click anywhere on a card. Every part of this composer
      // must stay in place while somebody writes a reply.
      onClick={(e) => e.stopPropagation()}
    >
      <Textarea
        ref={inputRef}
        rows={1}
        box="activityReply"
        width="flex"
        hint="muted"
        ring={false}
        className="focus:outline-none focus:ring-1 focus:ring-violet-500"
        placeholder="Reply…"
        aria-label="Reply to this item"
        value={draft}
        disabled={posting}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <Button
        type="submit"
        variant="unstyled"
        disabledStyle="block"
        size="icon"
        ink="none"
        className={'h-7 w-7 shrink-0 un-touch-target rounded-full bg-violet-600 hover:bg-violet-500 '
          + 'text-white transition-colors inline-flex items-center justify-center'}
        disabled={posting || !draft.trim()}
        title="Send reply"
        aria-label="Send reply"
      >
        {posting ? '…' : <SendIcon className="h-3.5 w-3.5" aria-hidden="true" />}
      </Button>
    </form>
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
      const preview = feedThreadPreview(rows);
      patchThread(key, {
        messages: preview.messages,
        total: preview.total,
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
        <FeedReplyComposer
          draft={draft}
          posting={state.posting}
          onDraftChange={setDraft}
          onSubmit={submit}
        />
      ) : null}
    </div>
  );
}
