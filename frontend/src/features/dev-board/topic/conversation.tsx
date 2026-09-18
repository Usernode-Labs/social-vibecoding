/**
 * The conversation under a change's card: ONE sheet, the Discussion, and the
 * Build sheet behind the card's pill.
 *
 * ── The tabs are gone ────────────────────────────────────────────────
 *
 * The sheet used to be three tabs, Discussion / Build / Activity. Activity
 * was three timestamps, and the card's meta line carries the one a reader
 * wants. Build is a place the AUTHOR works and a reader rarely looks; it is
 * the "Continue building" / "Open build" / "Read the build" pill on the
 * card now (`_topicCard`), which opens the sheet below the Discussion and
 * scrolls to it — the same `change-workspace-open` event `openChangeWorkspace`
 * always dispatched. It opens WITH the page in three cases: the author's own
 * change still under way (the workspace is what they came to do, as the
 * Build tab's default said), `?conversation=workspace` (and the old `build`
 * spelling), and a shared session's page whose owner published the chat.
 *
 * ── The Discussion speaks the general chat's language ─────────────────
 *
 * `mountChangeDiscussion` mounts the thread with `language: 'chat'`
 * (public/js/group-chat.js): a person's message sits in a bubble, the
 * viewer's own on the right, and every notice the platform posted about the
 * change — proposed, voted, merged, a check verdict — is a message from
 * whoever did it, with one box under the header. The quiet card ends the
 * list while nobody has commented. Only a change's Discussion: an issue's
 * thread keeps its flat rows and centred lines.
 */

import { useEffect, useRef, useState } from 'react';
import { unmountLegacyPortal } from '../../../lib/legacy-portals';
import type { TopicBody, TranscriptSection } from './model';

/** Only an explicitly published transcript can stand in for another person's workspace. */
export function workspaceKind(item: any, body: TopicBody) {
  if (item?.source === 'imported') return 'imported';
  if (body.workspace) return 'owner';
  return body.transcript ? 'published' : 'private';
}

/**
 * Whether the Build sheet opens WITH the page. An explicit link decides
 * first: `?conversation=workspace` (and the old `build` spelling) opens it,
 * any other named panel keeps it shut. Without one, the author's own change
 * still under way opens on its workspace, and a shared session's page whose
 * owner published the chat opens on that chat — the reason a reader followed
 * the link. Everything else opens on the card and the Discussion, with the
 * Build door on the card.
 */
export function initialBuildOpen(item: any, body: TopicBody, requested: string | null, sharedBookmark = false): boolean {
  const kind = workspaceKind(item, body);
  if (kind === 'private' || kind === 'imported') return false;
  if (requested === 'workspace' || requested === 'build') return true;
  if (requested) return false;
  if (kind === 'owner' && ['active', 'paused'].includes(item?.status)) return true;
  return sharedBookmark && !!body.transcript;
}

/**
 * Kept for the callers that read the old tab model: the panel a link would
 * have opened on. 'workspace' is the Build sheet, 'discussion' the page.
 */
export function initialConversationTab(item: any, body: TopicBody, requested: string | null, sharedBookmark = false): 'discussion' | 'workspace' {
  return initialBuildOpen(item, body, requested, sharedBookmark) ? 'workspace' : 'discussion';
}

export function mountChangeDiscussion(host: HTMLElement, id: number, readOnly: boolean) {
  (window as any).GroupChat?.mountThread({ type: 'session', ref: id, container: host,
    fullHeight: true, withHeader: false, readOnly, language: 'chat',
    notice: readOnly ? "You're viewing this app's dev space read-only. Only collaborators can post." : undefined });
}

function Discussion({ id, readOnly }: { id: number; readOnly: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const slot = host.current!;
    const gc = (window as any).GroupChat;
    // The bridge flushes synchronously. Invoke it after React's commit,
    // never from inside an effect's commit stack. The host is an empty leaf.
    const timer = setTimeout(() => {
      if (!slot.isConnected) return;
      mountChangeDiscussion(slot, id, readOnly);
    }, 0);
    return () => {
      clearTimeout(timer);
      const list = slot.querySelector('#gc-thread-messages');
      setTimeout(() => {
        // A route may already have opened another thread by now. Its
        // controller state must survive this detached host's cleanup.
        if (!document.getElementById('gc-thread-messages') && gc?.activeThread?.type === 'session'
          && Number(gc.activeThread.ref) === id) gc.unmountThread();
        if (list) gc?._react()?.unmountTranscript(list);
        unmountLegacyPortal(slot);
      }, 0);
    };
  }, [id, readOnly]);
  return <div ref={host} className="dev-conversation-chat" data-change-discussion={id} />;
}

function Workspace({ id, active }: { id: number; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const slot = host.current!;
    const dc = (window as any).DevChat;
    const abort = new AbortController();
    const timer = setTimeout(async () => {
      try {
        if (!slot.isConnected) return;
        setError('');
        const opened = await dc?.openSession(id, { userOpened: true, signal: abort.signal });
        if (abort.signal.aborted || !slot.isConnected) return;
        if (!opened || Number(dc.currentSession?.id) !== id) throw new Error('Could not open the agent workspace.');
        dc.renderChatView();
        setReady(true);
      } catch (err) {
        if (!abort.signal.aborted) setError((err as Error).message);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
      setTimeout(() => unmountLegacyPortal(slot), 0);
    };
  }, [id, attempt]);
  useEffect(() => {
    if (!active || !ready) return;
    const timer = setTimeout(() => {
      (window as any).DevChat?.restoreSessionScroll?.();
      // Resizable side panes / keyboard avoidance remeasure the now-visible host.
      window.dispatchEvent(new Event('resize'));
    }, 0);
    return () => clearTimeout(timer);
  }, [active, ready]);
  return <>
    {!ready ? <p className="dev-topic-note" role={error ? 'alert' : 'status'}>
      {error || 'Opening the agent workspace…'}
      {error ? <> <button type="button" className="gc-vote-btn" onClick={() => setAttempt((n) => n + 1)}>Retry</button></> : null}
    </p> : null}
    <div ref={host} id="dc-view" className="dev-conversation-workspace" data-change-workspace={id} />
  </>;
}

function PublishedWorkspace({ transcript }: { transcript: TranscriptSection }) {
  const id = transcript.id;
  useEffect(() => {
    const timer = setTimeout(() => (window as any).AppView?._loadSessionTranscript(id), 0);
    return () => clearTimeout(timer);
  }, [id]);
  return <div className="st-section" data-transcript-section={id} onClick={(event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-fork-chat]');
    if (button && !button.disabled) {
      event.preventDefault();
      (window as any).AppView?.forkSharedChat(Number(button.dataset.forkChat), button);
    }
  }}>
    <p className="dev-topic-note">{transcript.label} <span className="st-readonly-tag">read-only</span></p>
    {/* SessionTranscript owns the sanitized public transcript and Fork action. */}
    <div className="st-body" data-transcript-body={id} />
  </div>;
}

/**
 * The Discussion sheet, and the Build sheet under it. The Build sheet stays
 * mounted once opened, so closing and reopening it keeps the workspace's
 * drafts, uploads and scroll; until first opened it renders nothing, so a
 * reader who never asks never pays for the dev session behind it.
 */
export function ChangeConversation({ item, body }: { item: any; body: TopicBody }) {
  const id = Number(body.changeId);
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  const requested = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('conversation') : null;
  const kind = workspaceKind(item, body);
  const hasBuild = kind === 'owner' || kind === 'published';
  // Initialized once so refreshes preserve what the reader opened.
  const [buildOpen, setBuildOpen] = useState(() => initialBuildOpen(item, body, requested, av?._devTopic?.kind === 'session'));
  const [buildVisited, setBuildVisited] = useState(buildOpen);
  const build = useRef<HTMLElement>(null);
  useEffect(() => {
    const open = (event: Event) => {
      if (Number((event as CustomEvent).detail) !== id) return;
      setBuildOpen(true);
      setBuildVisited(true);
      setTimeout(() => {
        build.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 0);
    };
    window.addEventListener('change-workspace-open', open);
    return () => window.removeEventListener('change-workspace-open', open);
  }, [id]);
  return <>
    <section className="dev-topic-sheet dev-conversation" data-change-conversation={id} aria-label="Discussion">
      <h4 className="dev-topic-h">Discussion</h4>
      {body.discussion
        ? <p className="dev-topic-note">{body.discussion}</p>
        : <><p className="dev-topic-note dev-conversation-audience">Visible to the group</p><Discussion id={id} readOnly={!!av?.readOnly} /></>}
    </section>
    {hasBuild ? (
      <section
        ref={build}
        className="dev-topic-sheet dev-conversation-build"
        data-change-build={id}
        data-build-kind={kind}
        hidden={!buildOpen}
        aria-label="Build"
      >
        <div className="dev-conversation-build-head">
          <h4 className="dev-topic-h">Build</h4>
          <button type="button" className="dev-topic-fold-more" onClick={() => setBuildOpen(false)}>Hide</button>
        </div>
        {buildVisited ? (kind === 'owner'
          ? <Workspace id={id} active={buildOpen} />
          : <PublishedWorkspace transcript={body.transcript!} />) : null}
      </section>
    ) : null}
  </>;
}
