/**
 * The Homeroom bot page's lists, kept current while the page is up (30 Oct
 * 2026: a thread that moved kept its old row, or no row, until a reload).
 * ./index.tsx reads them each time the page is shown; this says when to read
 * them again while it stays shown.
 *
 * WHAT MOVES A ROW. The lists are the threads you are in (GET /api/ai/work,
 * and the Needs you feed for them), so they are read again when:
 *   - a change or a request in a project they show moved: a change built,
 *     put up for a vote, voted on, merged or closed (`session_update`,
 *     `vote_update`), a request filed, claimed, answered or closed
 *     (`issue_update`), a merge gone live (`app_version_changed`). These go
 *     to everyone who may view the project, so one about a project the lists
 *     do not show is left alone, and a change's own banners (`behind_main`,
 *     `freshness`, `sync_status`, `staging_ready`) move no row;
 *   - something was asked of you, or what was asked was answered, in any
 *     project (`notification_new`, `notifications_changed`: yours alone);
 *   - Homeroom bot started or finished work for you (WORK_CHANGED_EVENT,
 *     which app.js also sends when its socket reconnects);
 *   - Main Chat had a message: a private thread is listed once it has a
 *     reply, and leaves once it is filed or posted;
 *   - the reads may have missed something (lib/live-reads.ts): the socket
 *     reconnected, the browser tab came back after a while, or the service
 *     worker corrected a read it first answered from its saved copy.
 *
 * ONE READ A BURST. A vote is a `vote_update`, a `session_update` and a
 * notification within a second. They are gathered for GATHER_MS and read
 * once, and reads are at least GAP_MS apart, so a busy project costs the
 * page a read every few seconds rather than one per event. Nothing is read
 * while the browser tab is hidden: what was asked for then is read when it
 * is seen again.
 *
 * public/js/app.js hands every events-socket message to `handleEvent`
 * (window.UsernodeReact.aiScreen), as it hands conversation events to
 * Messages; which of them matter is decided here.
 */

import { useEffect, useRef } from 'react';

import { watch } from '../../lib/live-reads';
import { WORK_CHANGED_EVENT } from '../messages/bot-shared';

/** How long the events of one burst are gathered before the read. */
export const GATHER_MS = 400;

/** The least time between two reads of the lists. */
export const GAP_MS = 3_000;

/** An events-socket message, as much of it as `movesLists` reads. */
export interface SocketEvent {
  type?: string;
  appSlug?: string | null;
  action?: string | null;
  conversationId?: number | string | null;
  conversation_id?: number | string | null;
  [key: string]: unknown;
}

/** What the page shows: the projects in its lists, and Main Chat's conversation. */
export interface Showing {
  projects: ReadonlySet<string>;
  botId: number | null;
}

const PROJECT_EVENTS: ReadonlySet<string> = new Set(['session_update', 'vote_update', 'issue_update', 'app_version_changed']);
const BANNER_ACTIONS: ReadonlySet<string> = new Set(['behind_main', 'freshness', 'sync_status', 'staging_ready']);
const YOUR_EVENTS: ReadonlySet<string> = new Set(['notification_new', 'notifications_changed']);
const MAIN_EVENTS: ReadonlySet<string> = new Set(['conversation_message_created', 'conversation_message_updated']);

/** Pure: whether an events-socket message can move a row of the lists. */
export function movesLists(event: SocketEvent | null | undefined, showing: Showing): boolean {
  if (!event) return false;
  const type = String(event.type || '');
  if (PROJECT_EVENTS.has(type)) {
    if (type === 'session_update' && BANNER_ACTIONS.has(String(event.action || ''))) return false;
    // One that names no project could be about any of them.
    return !event.appSlug || showing.projects.has(String(event.appSlug));
  }
  if (YOUR_EVENTS.has(type)) return true;
  if (MAIN_EVENTS.has(type)) {
    const id = Number(event.conversationId ?? event.conversation_id);
    return !!showing.botId && id === showing.botId;
  }
  return false;
}

/** Pure: whether a read lib/live-reads.ts corrects is one of the lists'. */
export function isListRead(url: URL): boolean {
  return url.pathname === '/api/ai/work'
    || (url.pathname === '/api/workshop/needs-feed' && url.searchParams.get('in') === 'threads');
}

type Listener = (event: SocketEvent) => void;
const listeners = new Set<Listener>();

/** app.js's every events-socket message, to the page while it listens. */
export function handleEvent(event: SocketEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // The socket's other handlers run whatever the page does.
    }
  }
}

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.aiScreen = { handleEvent };
}

function tabHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * The reads' pace (ONE READ A BURST above): `ask` for a read, `seen` when
 * the browser tab is back, `stop` when the page goes. Starts as though it
 * had just read, since showing the page did.
 */
export function pacedReads(reread: () => void, hidden: () => boolean = tabHidden): {
  ask(): void;
  seen(): void;
  stop(): void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let owed = false;
  let lastAt = Date.now();
  const run = () => {
    timer = null;
    if (hidden()) { owed = true; return; }
    owed = false;
    lastAt = Date.now();
    reread();
  };
  const ask = () => {
    if (timer) return;
    timer = setTimeout(run, Math.max(GATHER_MS, lastAt + GAP_MS - Date.now()));
  };
  return {
    ask,
    seen() { if (owed && !hidden()) ask(); },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      owed = false;
    },
  };
}

/**
 * While `visible`, run `reread` again whenever something the lists show
 * may have moved (see the header), at the pace above.
 */
export function useLiveLists(reread: () => void, visible: boolean, showing: Showing): void {
  const latest = useRef({ reread, showing });
  latest.current = { reread, showing };
  useEffect(() => {
    if (!visible || typeof window === 'undefined') return undefined;
    const reads = pacedReads(() => latest.current.reread());
    const onEvent: Listener = (event) => { if (movesLists(event, latest.current.showing)) reads.ask(); };
    listeners.add(onEvent);
    window.addEventListener(WORK_CHANGED_EVENT, reads.ask);
    document.addEventListener('visibilitychange', reads.seen);
    const unwatch = watch(reads.ask, { reads: isListRead });
    return () => {
      reads.stop();
      listeners.delete(onEvent);
      window.removeEventListener(WORK_CHANGED_EVENT, reads.ask);
      document.removeEventListener('visibilitychange', reads.seen);
      unwatch();
    };
  }, [visible]);
}
