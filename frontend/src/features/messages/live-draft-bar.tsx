/**
 * A live app draft, as its private thread with Homeroom bot shows it
 * (services/live-drafts.js). Under the head of a thread that is about a
 * project:
 *
 *   Change Gym Tracker here and watch it update as you talk.  [Open app preview]
 *
 * Open app preview makes the draft: a change of the person's own with a
 * preview of it, which opens beside the chat (the change preview's own
 * placement: features/staging/placement.ts). While it is open, what they
 * say in the thread is answered by the draft bot (services/live-draft-bot.js),
 * which edits the draft; each saved edit restarts the preview in place, and
 * the frame reloads here when the server says so (`live_draft_changed`, which
 * public/js/app.js hands on as the window event LIVE_DRAFT_EVENT).
 *
 *   Live preview · 3 changes                 [Show preview] [Propose] [Close draft]
 *
 * Propose puts it up for the project's vote, as the person's own change;
 * Close draft puts it away. Nothing is drawn while drafts are switched off,
 * and the first render is nothing: the draft is read in an effect.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { Button } from '@/components/ui/button';
import { stagingBridge } from '../staging/staging-bridge.js';
import { stagingStore } from '../staging/staging-store.js';

/** The window event public/js/app.js turns a `live_draft_changed` frame into. */
export const LIVE_DRAFT_EVENT = 'live-draft-changed';

export interface LiveDraft {
  id: number;
  state: 'open' | 'proposed' | 'closed';
  live: 'starting' | 'live' | 'rebuilding' | 'failed' | 'proposed' | 'closed' | null;
  sessionId: number | null;
  rootId: number;
  app: { slug: string; name: string };
  edits: number;
  headSha: string | null;
  prNumber: number | null;
  error: string | null;
}

/** Pure: the status line's message id and values for a draft. */
export function draftLine(draft: LiveDraft): { id: string; values?: Record<string, unknown> } {
  if (draft.live === 'starting') return { id: 'messages:liveDraft.starting' };
  if (draft.live === 'rebuilding') return { id: 'messages:liveDraft.rebuilding' };
  if (draft.live === 'failed') return { id: 'messages:liveDraft.failed' };
  if (!draft.edits) return { id: 'messages:liveDraft.liveNone' };
  return { id: 'messages:liveDraft.live', values: { count: draft.edits } };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data && typeof data.message === 'string' ? data.message : null;
    throw Object.assign(new Error(message || 'failed'), { status: res.status, said: message });
  }
  return data as T;
}

// The session whose preview this bar last opened, so a saved edit reloads
// that frame and no other.
let shownSession: number | null = null;

function openPreview(draft: LiveDraft) {
  const view = typeof window !== 'undefined' ? (window as any).AppView : null;
  if (!draft.sessionId || !view || typeof view.ensureStaging !== 'function') return;
  shownSession = draft.sessionId;
  // The look-only open: the draft's preview is built by the server, never
  // by this press (services/live-drafts.js open).
  void view.ensureStaging(draft.sessionId, null, null, { readOnly: true, app: { slug: draft.app.slug } });
}

// The frame shows the draft's newest edit: the same address, with a sign-in
// token minted now (the one it opened with lasts an hour).
async function reloadPreview(sessionId: number | null, slug: string) {
  if (!sessionId || sessionId !== shownSession || !stagingStore.get().open) return;
  const frame = stagingBridge.frame();
  if (!frame || !frame.src) return;
  let src = frame.src;
  try {
    const view = (window as any).AppView;
    const token = typeof view?._mintToken === 'function' ? await view._mintToken(slug) : null;
    const url = new URL(src);
    if (token && url.searchParams.has('token')) {
      url.searchParams.set('token', token);
      src = url.toString();
    }
  } catch { /* the address it has */ }
  if (stagingBridge.frame() === frame && sessionId === shownSession) stagingBridge.setSrc(src);
}

export function LiveDraftBar({ rootId, app }: { rootId: number; app: { slug: string; name: string } }): ReactNode {
  const t = useMessages('messages');
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState<LiveDraft | null>(null);
  const [busy, setBusy] = useState<'open' | 'propose' | 'close' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposed, setProposed] = useState<{ number: number | null; slug: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const lastLive = useRef<LiveDraft['live']>(null);
  useEffect(() => { lastLive.current = draft?.live ?? null; }, [draft]);

  const load = useCallback(async () => {
    try {
      const out = await call<{ enabled: boolean; draft: LiveDraft | null }>(`/api/live-drafts?rootId=${encodeURIComponent(String(rootId))}`);
      if (!alive.current) return;
      setEnabled(!!out.enabled);
      setDraft(out.draft);
    } catch {
      if (alive.current) setEnabled(false);
    }
  }, [rootId]);

  useEffect(() => {
    setDraft(null);
    setProposed(null);
    setError(null);
    void load();
  }, [load]);

  useEffect(() => {
    const heard = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const next: LiveDraft | null = detail.draft || null;
      if (!next || Number(next.rootId) !== Number(rootId)) return;
      // Built again (a new package): the frame shows it once it serves.
      const rebuilt = next.state === 'open' && lastLive.current === 'rebuilding' && next.live === 'live';
      lastLive.current = next.live;
      setDraft(next.state === 'open' ? next : null);
      if (detail.reload || rebuilt) void reloadPreview(next.sessionId, next.app.slug);
    };
    window.addEventListener(LIVE_DRAFT_EVENT, heard);
    return () => window.removeEventListener(LIVE_DRAFT_EVENT, heard);
  }, [rootId]);

  const failed = (err: any) => {
    if (alive.current) setError(err?.said || t('messages:liveDraft.error'));
  };

  const start = async () => {
    setBusy('open');
    setError(null);
    try {
      const out = await call<{ draft: LiveDraft }>('/api/live-drafts', { method: 'POST', body: JSON.stringify({ rootId }) });
      if (!alive.current) return;
      setDraft(out.draft);
      openPreview(out.draft);
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };

  const show = async () => {
    if (!draft) return;
    setError(null);
    // Brought up to the draft's newest edit first: a preview that slept wakes on its image.
    const out = await call<{ draft: LiveDraft }>(`/api/live-drafts/${draft.id}/preview`, { method: 'POST' }).catch(() => null);
    if (out?.draft && alive.current) setDraft(out.draft);
    openPreview(out?.draft || draft);
  };

  const propose = async () => {
    if (!draft) return;
    setBusy('propose');
    setError(null);
    try {
      const out = await call<{ draft: LiveDraft }>(`/api/live-drafts/${draft.id}/propose`, { method: 'POST', body: '{}' });
      if (!alive.current) return;
      setProposed({ number: out.draft?.prNumber ?? null, slug: draft.app.slug });
      setDraft(null);
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };

  const close = async () => {
    if (!draft) return;
    setBusy('close');
    setError(null);
    try {
      await call(`/api/live-drafts/${draft.id}/close`, { method: 'POST' });
      if (alive.current) setDraft(null);
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };

  if (!enabled && !draft && !proposed) return null;
  const line = draft ? draftLine(draft) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 px-4 py-2.5 text-[13px] text-zinc-600 dark:border-zinc-800 dark:text-zinc-300"
      data-live-draft={draft ? draft.id : ''} data-live-draft-state={draft ? draft.live || '' : ''} role="region" aria-live="polite">
      {proposed ? (
        <span className="min-w-0 flex-1" data-live-draft-proposed="">
          {t('messages:liveDraft.proposed')}
          {proposed.number ? (
            <>
              {' '}
              <a className="font-semibold text-violet-700 dark:text-violet-300"
                href={`#app/${encodeURIComponent(proposed.slug)}/dev/changes/${proposed.number}`}>
                {t('messages:liveDraft.openChange', { number: proposed.number })}
              </a>
            </>
          ) : null}
        </span>
      ) : null}
      {!proposed && !draft ? (
        <>
          <span className="min-w-0 flex-1">{t('messages:liveDraft.intro', { project: app.name || app.slug })}</span>
          <Button type="button" variant="pillAccent" size="sm" ink="solid" data-live-draft-open=""
            disabled={busy === 'open'} onClick={() => void start()}>
            {busy === 'open' ? t('messages:liveDraft.opening') : t('messages:liveDraft.open')}
          </Button>
        </>
      ) : null}
      {draft && line ? (
        <>
          <span className="min-w-0 flex-1" data-live-draft-line="">{t(line.id, line.values)}</span>
          <span className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="pillNeutral" size="sm" ink="neutral" data-live-draft-show=""
              disabled={!draft.sessionId || draft.live === 'failed'} onClick={() => void show()}>
              {t('messages:liveDraft.show')}
            </Button>
            {draft.edits ? (
              <Button type="button" variant="pillAccent" size="sm" ink="solid" data-live-draft-propose=""
                disabled={busy === 'propose' || draft.live !== 'live'} onClick={() => void propose()}>
                {busy === 'propose' ? t('messages:liveDraft.proposing') : t('messages:liveDraft.propose')}
              </Button>
            ) : null}
            <Button type="button" variant="pillNeutral" size="sm" ink="neutral" data-live-draft-close=""
              disabled={busy === 'close'} onClick={() => void close()}>
              {t('messages:liveDraft.close')}
            </Button>
          </span>
        </>
      ) : null}
      {error ? <p className="w-full text-[13px] text-red-700 dark:text-red-400" role="alert" data-live-draft-error="">{error}</p> : null}
    </div>
  );
}
