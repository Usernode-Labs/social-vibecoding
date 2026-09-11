import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { unmountLegacyPortal } from '../../../lib/legacy-portals';
import type { TopicBody, TranscriptSection } from './model';

const TABS = [
  { key: 'discussion', label: 'Discussion' },
  { key: 'workspace', label: 'Agent workspace' },
  { key: 'activity', label: 'Activity' },
] as const;
type Tab = typeof TABS[number]['key'];

/** Only an explicitly published transcript can stand in for another person's workspace. */
export function workspaceKind(item: any, body: TopicBody) {
  if (item?.source === 'imported') return 'imported';
  if (body.workspace) return 'owner';
  return body.transcript ? 'published' : 'private';
}

export function mountChangeDiscussion(host: HTMLElement, id: number, readOnly: boolean) {
  (window as any).GroupChat?.mountThread({ type: 'session', ref: id, container: host,
    fullHeight: true, withHeader: false, readOnly,
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

/** One conversation area for the whole lifecycle. Hidden, visited panels stay
 * mounted so switching tabs preserves drafts, uploads, quotes and chat state. */
export function ChangeConversation({ item, body }: { item: any; body: TopicBody }) {
  const id = Number(body.changeId);
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  // Existing /dev/shared bookmarks mean "read this chat"; ordinary Open card
  // links arrive at Discussion. Both destinations now have all three tabs.
  const requested = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('conversation') : null;
  const initial: Tab = requested === 'workspace' || requested === 'activity' ? requested
    : av?._devTopic?.kind === 'session' && body.transcript ? 'workspace' : 'discussion';
  const [tab, setTab] = useState<Tab>(initial);
  const [visited, setVisited] = useState(() => new Set<Tab>([initial]));
  const root = useRef<HTMLElement>(null);
  const select = (next: Tab) => {
    setTab(next);
    setVisited((old) => old.has(next) ? old : new Set([...old, next]));
  };
  useEffect(() => {
    const open = (event: Event) => {
      if (Number((event as CustomEvent).detail) !== id) return;
      select('workspace');
      root.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      root.current?.querySelector<HTMLButtonElement>('[data-conversation-tab="workspace"]')?.focus({ preventScroll: true });
    };
    window.addEventListener('change-workspace-open', open);
    return () => window.removeEventListener('change-workspace-open', open);
  }, [id]);
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % TABS.length
        : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : null;
    if (next === null) return;
    event.preventDefault();
    select(TABS[next].key);
    root.current?.querySelector<HTMLButtonElement>(`[data-conversation-tab="${TABS[next].key}"]`)?.focus();
  };
  const kind = workspaceKind(item, body);
  return <section ref={root} className="dev-topic-sheet dev-conversation" data-change-conversation={id} aria-label="Change conversation">
    <div role="tablist" aria-label="Conversation" className="dev-conversation-tabs">
      {TABS.map(({ key, label }, index) => <button key={key} type="button" role="tab"
        id={`change-${id}-tab-${key}`} aria-controls={`change-${id}-panel-${key}`}
        aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
        data-conversation-tab={key} onKeyDown={(event) => keys(event, index)} onClick={() => select(key)}>{label}</button>)}
    </div>
    {TABS.map(({ key }) => <div key={key} role="tabpanel" id={`change-${id}-panel-${key}`}
      aria-labelledby={`change-${id}-tab-${key}`} tabIndex={0} hidden={tab !== key} className="dev-conversation-panel">
      {visited.has(key) && key === 'discussion' ? body.discussion
        ? <p className="dev-topic-note">{body.discussion}</p>
        : <><p className="dev-topic-note dev-conversation-audience">Visible to the group</p><Discussion id={id} readOnly={!!av?.readOnly} /></> : null}
      {visited.has(key) && key === 'workspace' ? kind === 'owner'
        ? <Workspace id={id} active={tab === key} />
        : kind === 'published' ? <PublishedWorkspace transcript={body.transcript!} />
          : <p className="dev-topic-note">{kind === 'imported'
            ? 'This change was imported from a pull request. Work continues on its source branch; there is no agent session attached to it.'
            : 'The author has not shared the agent workspace. The group discussion is available in the Discussion tab.'}</p> : null}
      {key === 'activity' ? body.activity?.length ? <ol className="dev-conversation-activity">
        {body.activity.map((event) => <li key={event.label}><span>{event.label}</span><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></li>)}
      </ol> : <p className="dev-topic-note">No activity has been recorded yet.</p> : null}
    </div>)}
  </section>;
}
