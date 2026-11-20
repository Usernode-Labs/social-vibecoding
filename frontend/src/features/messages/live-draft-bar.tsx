/**
 * A live app draft, as its private thread with Homeroom bot shows it
 * (services/live-drafts.js). There is no standing button: a draft is opened
 * by asking Homeroom bot (homeroom-bot-mayor.js open_app_preview), or with
 * New chat's "I want to change an app live…" start (./new-thread.tsx).
 *
 * 20 Nov 2026 (live-draft review, G): there is no bar any more. The "Live
 * preview · Tell Homeroom bot what to change. [Show preview] [Propose] [Close
 * draft]" strip under the thread's head, and its twin at the foot of the
 * thread's opening card, are gone. What they held is where the draft is
 * looked at:
 *
 *   - Propose (Update proposal once it is up for a vote) and Close draft are
 *     in the preview's own header, beside its ×, with one short line saying
 *     where the draft stands (LiveDraftControls, drawn by
 *     ../staging/staging-overlay.tsx while the preview shown is this draft's);
 *   - showing the preview again is the thread head's Artifacts button
 *     (./index.tsx), whose column lists the draft as "Live preview of <app>"
 *     (../detail/detail-card.tsx).
 *
 * What the bar did besides drawing stays, in a part that draws nothing
 * (LiveDraftWatch, mounted on an open thread of theirs): the draft is read in
 * an effect, its preview comes up beside the chat the moment the draft is
 * opened (the change preview's own placement: ../staging/placement.ts), and
 * the frame reloads when a saved edit restarted it (`live_draft_changed`,
 * which public/js/app.js hands on as the window event LIVE_DRAFT_EVENT).
 *
 * C: a draft survives Propose. It stays the thread's, its preview running;
 * edits after it are "not in the proposal yet" until Update proposal.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { confirmAction } from '../../lib/confirm';
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
  /** J: the chat its thread is in (the server's, from 20 Nov 2026). */
  conversationId?: number | null;
  app: { slug: string; name: string };
  edits: number;
  headSha: string | null;
  prNumber: number | null;
  error: string | null;
  /** C: still worked on: open, or up for a vote with its own proposal. */
  editable?: boolean;
  /** C: its proposal while it is one, and how many edits are not in it yet. */
  proposal?: { sessionId: number; prNumber: number | null; open: boolean; pending: number; headSha: string | null } | null;
}

/** Pure (C): whether a draft is still shown: open, or up for a vote and still edited. */
export function liveDraftShown(draft: LiveDraft | null | undefined): draft is LiveDraft {
  if (!draft || !draft.sessionId) return false;
  return draft.state === 'open' || (draft.state === 'proposed' && draft.editable === true);
}

/** Pure: the status line's message id and values for a draft. */
export function draftLine(draft: LiveDraft): { id: string; values?: Record<string, unknown> } {
  if (draft.live === 'starting') return { id: 'messages:liveDraft.starting' };
  if (draft.live === 'rebuilding') return { id: 'messages:liveDraft.rebuilding' };
  if (draft.live === 'failed') return { id: 'messages:liveDraft.failed' };
  if (!draft.edits) return { id: 'messages:liveDraft.liveNone' };
  return { id: 'messages:liveDraft.live', values: { count: draft.edits } };
}

/**
 * Pure (G): the one short line the preview's header says about the draft,
 * and whether it is bad news. A preview that could not start is said here,
 * where the bar used to say it.
 */
export function draftHeadLine(draft: LiveDraft): { id: string; values?: Record<string, unknown>; bad: boolean } {
  if (draft.live === 'failed') return { id: 'messages:liveDraft.head.failed', bad: true };
  if (draft.live === 'starting') return { id: 'messages:liveDraft.head.starting', bad: false };
  if (draft.live === 'rebuilding') return { id: 'messages:liveDraft.head.rebuilding', bad: false };
  const proposal = draft.state === 'proposed' ? draft.proposal : null;
  if (proposal) {
    if (proposal.pending > 0) return { id: 'messages:liveDraft.head.pending', values: { count: proposal.pending }, bad: false };
    return { id: 'messages:liveDraft.head.inProposal', bad: false };
  }
  if (!draft.edits) return { id: 'messages:liveDraft.head.none', bad: false };
  return { id: 'messages:liveDraft.head.edits', values: { count: draft.edits }, bad: false };
}

/**
 * Pure (G, C): the header's one action to press: Propose for an open draft
 * with an edit, Update proposal for one up for a vote with changes not in it
 * yet, else none.
 */
export function draftAction(draft: LiveDraft): 'propose' | 'update' | null {
  if (draft.state === 'open') return draft.edits > 0 ? 'propose' : null;
  if (draft.state === 'proposed' && draft.proposal?.open && draft.proposal.pending > 0) return 'update';
  return null;
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

// ── The drafts this page knows, by the change their preview is ─────────
//
// The watcher of each open thread writes its draft here, and the preview's
// header reads the one whose change it shows (staging-store's sessionId).
// Kept on the global object, as the detail column's store is (../ai/detail.ts):
// the shell can be drawn by more than one copy of this module.

interface Known { drafts: Map<number, LiveDraft>; listeners: Set<() => void>; version: number }
const known: Known = ((globalThis as any).__usernodeLiveDrafts ||= { drafts: new Map(), listeners: new Set(), version: 0 });

function noteDraft(draft: LiveDraft | null, sessionId: number | null = draft?.sessionId ?? null): void {
  if (!sessionId) return;
  if (draft && liveDraftShown(draft)) known.drafts.set(sessionId, draft);
  else known.drafts.delete(sessionId);
  known.version += 1;
  known.listeners.forEach((fn) => fn());
}

/** The live draft whose preview is the change `sessionId`, or null. */
export function useDraftForSession(sessionId: number | null | undefined): LiveDraft | null {
  useSyncExternalStore(
    (fn) => { known.listeners.add(fn); return () => { known.listeners.delete(fn); }; },
    () => known.version,
    () => 0,
  );
  return sessionId ? known.drafts.get(Number(sessionId)) || null : null;
}

/** The live draft whose preview is the change `sessionId`, or null (not a hook: ./showing.ts). */
export function draftForSession(sessionId: number | null | undefined): LiveDraft | null {
  return sessionId ? known.drafts.get(Number(sessionId)) || null : null;
}

// The session whose preview this page last opened, so a saved edit reloads
// that frame and no other.
let shownSession: number | null = null;

/** A thread's live draft (open, or up for a vote and still edited), or null. */
export async function readLiveDraft(rootId: number): Promise<LiveDraft | null> {
  const out = await call<{ draft: LiveDraft | null }>(`/api/live-drafts?rootId=${encodeURIComponent(String(rootId))}`);
  return out.draft || null;
}

/** Show a live draft's preview beside its thread (the Artifacts column's row). */
export function openLivePreview(draft: LiveDraft) {
  noteDraft(draft);
  // Brought up to the draft's newest edit first: a preview that slept wakes on its image.
  void call<{ draft: LiveDraft }>(`/api/live-drafts/${draft.id}/preview`, { method: 'POST' })
    .then((out) => { if (out?.draft) noteDraft(out.draft); }, () => {});
  openPreview(draft);
}

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

/**
 * A thread's live draft, read in an effect and kept current from the
 * server's `live_draft_changed` frames: a newly opened draft brings its
 * preview up, and a saved edit reloads it. Null while there is none.
 */
export function useLiveDraft(rootId: number | null | undefined): LiveDraft | null {
  const [draft, setDraft] = useState<LiveDraft | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const lastLive = useRef<LiveDraft['live']>(null);
  useEffect(() => { lastLive.current = draft?.live ?? null; }, [draft]);

  const load = useCallback(async () => {
    if (!rootId) return;
    try {
      const next = await readLiveDraft(rootId);
      if (!alive.current) return;
      setDraft(liveDraftShown(next) ? next : null);
      noteDraft(next);
    } catch { /* nothing is open that it could show */ }
  }, [rootId]);

  useEffect(() => {
    setDraft(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!rootId) return undefined;
    const heard = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const next: LiveDraft | null = detail.draft || null;
      if (!next || Number(next.rootId) !== Number(rootId)) return;
      const shown = liveDraftShown(next);
      // Built again (a new package): the frame shows it once it serves.
      const rebuilt = shown && lastLive.current === 'rebuilding' && next.live === 'live';
      lastLive.current = next.live;
      setDraft(shown ? next : null);
      noteDraft(next);
      // Opened just now (by asking Homeroom bot): its preview comes up beside the chat.
      if (detail.opened && shown) openPreview(next);
      else if (detail.reload || rebuilt) void reloadPreview(next.sessionId, next.app.slug);
    };
    window.addEventListener(LIVE_DRAFT_EVENT, heard);
    return () => window.removeEventListener(LIVE_DRAFT_EVENT, heard);
  }, [rootId]);

  return draft;
}

/** What the bar did besides drawing, for an open thread of theirs: it draws nothing. */
export function LiveDraftWatch({ rootId, onDraft }: { rootId: number; onDraft?: (draft: LiveDraft | null) => void }): ReactNode {
  const draft = useLiveDraft(rootId);
  useEffect(() => { onDraft?.(draft); }, [draft, onDraft]);
  return null;
}

/**
 * G: a live draft's own controls in its preview's header, beside its ×: one
 * short line saying where the draft stands, Propose (Update proposal once it
 * is up for a vote with changes not in it yet), and Close draft, which asks
 * first. Drawn by ../staging/staging-overlay.tsx only while the preview shown
 * is this draft's.
 */
export function LiveDraftControls({ draft }: { draft: LiveDraft | null }): ReactNode {
  const t = useMessages('messages');
  const [busy, setBusy] = useState<'propose' | 'update' | 'close' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { setError(null); }, [draft?.id]);
  // Not a live draft's preview: nothing.
  if (!draft) return null;

  const line = draftHeadLine(draft);
  const action = draftAction(draft);
  const settle = (next: LiveDraft | null | undefined) => {
    if (next) noteDraft(next, draft.sessionId);
  };
  const failed = (err: any) => {
    if (alive.current) setError(err?.said || t('messages:liveDraft.error'));
  };
  const act = async (what: 'propose' | 'update') => {
    setBusy(what);
    setError(null);
    try {
      const out = await call<{ draft: LiveDraft }>(`/api/live-drafts/${draft.id}/${what}`, { method: 'POST', body: '{}' });
      settle(out?.draft);
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };
  const close = async () => {
    const ok = await confirmAction({
      title: t('messages:liveDraft.closeConfirm.title'),
      message: draft.state === 'proposed'
        ? t('messages:liveDraft.closeConfirm.proposed')
        : t('messages:liveDraft.closeConfirm.open'),
      confirmLabel: t('messages:liveDraft.close'),
      danger: true,
    });
    if (!ok) return;
    setBusy('close');
    setError(null);
    try {
      await call(`/api/live-drafts/${draft.id}/close`, { method: 'POST' });
      noteDraft(null, draft.sessionId);
      // The draft's preview goes with it.
      if (stagingStore.get().open) (window as any).AppView?.closeStagingOverlay?.();
    } catch (err) { failed(err); } finally { if (alive.current) setBusy(null); }
  };

  return (
    <span className="staging-draft" data-live-draft={draft.id} data-live-draft-state={draft.live || ''} role="group"
      aria-label={t('messages:liveDraft.controls')}>
      <span className="staging-draft-line" data-bad={line.bad ? '' : undefined} data-live-draft-line="" aria-live="polite"
        title={line.bad ? t('messages:liveDraft.foot.failedSub') : undefined}>
        {error || t(line.id, line.values)}
      </span>
      {action === 'propose' ? (
        <button type="button" className="staging-draft-act" data-live-draft-propose=""
          disabled={busy === 'propose' || draft.live !== 'live'} onClick={() => void act('propose')}>
          {busy === 'propose' ? t('messages:liveDraft.proposing') : t('messages:liveDraft.propose')}
        </button>
      ) : null}
      {action === 'update' ? (
        <button type="button" className="staging-draft-act" data-live-draft-update=""
          title={t('messages:liveDraft.updateNote')}
          disabled={busy === 'update'} onClick={() => void act('update')}>
          {busy === 'update' ? t('messages:liveDraft.updating') : t('messages:liveDraft.update')}
        </button>
      ) : null}
      <button type="button" className="staging-draft-quiet" data-live-draft-close=""
        disabled={busy === 'close'} onClick={() => void close()}>
        {t('messages:liveDraft.close')}
      </button>
    </span>
  );
}
