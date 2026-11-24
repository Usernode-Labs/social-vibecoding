/**
 * Homeroom mobile polish, item 05 (24 Nov 2026): the list's visits, as the
 * page lives them (./visit.ts says what is new; src/services/ai-visits.js
 * keeps the visits, per person).
 *
 *   Shown     each time the tab is shown, the page opens a visit
 *             (POST /api/ai/visit) and draws its marks against the last one
 *             for as long as it is up. Acting on a row or opening one
 *             changes nothing about the others.
 *   Up        once its lists are read, and every two minutes while the page
 *             is in front, it says what they hold (POST /api/ai/visit/seen),
 *             so a phone that closes the page without a word still leaves a
 *             visit behind.
 *   Leaving   the tab: it says so, and forgets its token. Coming back is the
 *             next visit, measured from that moment.
 *   Hidden    the browser tab put away, a phone locked, a reload: it says it
 *             left but keeps its token (sessionStorage, this browser tab's
 *             alone), and asks again when it is shown. Within ten minutes
 *             the server carries the same visit on, so a reload keeps every
 *             mark; after that it is the next visit.
 *
 * Nothing here runs in the first render: the visit is read in an effect, so
 * the first render is the prerender's, with no marks.
 */
import { useEffect, useRef, useState } from 'react';

import { asLastVisit, seenIsEmpty, type LastVisit, type VisitSeen } from './visit';

/** How often a list that is up says what it holds. */
export const VISIT_NOTE_MS = 2 * 60 * 1000;
/** Where this browser tab keeps its visit's token across a reload. */
const TOKEN_KEY = 'homeroom:ai-visit';

function readToken(): string | null {
  try { return window.sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function writeToken(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(TOKEN_KEY, token);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* storage may be off: a reload is then the next visit */ }
}

/**
 * The visit the list's marks are measured from, while the tab is shown:
 * null on a first visit, while it is being read, or when it could not be.
 */
export function useListVisit({ visible, session, ready, seen, demo = '' }: {
  /** The tab is the screen on show. */
  visible: boolean;
  /** Bumped when the signed-in account changes: a new visit, for them. */
  session: number;
  /** Both lists have been read, so `seen` is what they hold. */
  ready: boolean;
  /** What the bands hold now (./visit.ts visitSeen). */
  seen: VisitSeen;
  /** `?demo=1` on staging, passed on as every read of this page passes it. */
  demo?: string;
}): LastVisit | null {
  const [visit, setVisit] = useState<LastVisit | null>(null);
  // The token of the visit opened, once the server has answered: the first
  // word waits for it and for the lists.
  const [opened, setOpened] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const latest = useRef({ seen, ready, session });
  latest.current = { seen, ready, session };
  // A leave still on its way: the next open waits for it, so the server
  // hears the visit end before the next one starts.
  const leaving = useRef<Promise<unknown>>(Promise.resolve());

  const note = (left: boolean): Promise<unknown> => {
    const now = latest.current;
    if (!token.current || !now.ready || seenIsEmpty(now.seen)) return Promise.resolve();
    return fetch(`/api/ai/visit/seen${demo}`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: left,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ visit: token.current, seen: now.seen, left }),
    }).catch(() => { /* the next word says it again */ });
  };

  useEffect(() => {
    if (!visible || typeof window === 'undefined' || !(window as any).App?.user) return undefined;
    let live = true;
    const account = session;
    const open = () => {
      const brought = readToken();
      void leaving.current.then(() => fetch(`/api/ai/visit${demo}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(brought ? { visit: brought } : {}),
      })).then((res) => (res.ok ? res.json() : null)).then((answer) => {
        if (!live || !answer || typeof answer.visit !== 'string') return;
        token.current = answer.visit;
        writeToken(answer.visit);
        setVisit(asLastVisit(answer));
        setOpened(answer.visit);
      }).catch(() => { /* no marks this visit; the lists still draw */ });
    };
    open();
    // The browser tab put away (or the page going, a reload among them): it
    // left, as far as the server can tell, but keeps its token to come back.
    const away = () => { leaving.current = note(true); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') away();
      else open();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', away);
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void note(false);
    }, VISIT_NOTE_MS);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', away);
      window.clearInterval(tick);
      // Leaving the tab: the visit ends here, and coming back is the next
      // one. The shell saying who is signed in (`sv:session`, which a boot
      // from the saved session sends too) is not leaving: the visit is
      // asked for again with the same token, which the server keeps going,
      // and nothing is said with lists that may already be another
      // account's.
      if (latest.current.session === account) {
        leaving.current = note(true);
        writeToken(null);
        setVisit(null);
        setOpened(null);
      }
      token.current = null;
    };
  }, [visible, session, demo]); // eslint-disable-line react-hooks/exhaustive-deps

  // The visit's first word, once it is open and its lists are read.
  const said = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !ready || !opened || said.current === opened) return;
    said.current = opened;
    void note(false);
  }, [visible, ready, opened]); // eslint-disable-line react-hooks/exhaustive-deps

  return visit;
}
