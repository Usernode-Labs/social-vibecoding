/**
 * The conversation under a change's card: ONE sheet, the Discussion.
 *
 * ── The build surface is not on this page ─────────────────────────────
 *
 * The sheet used to be three tabs, Discussion / Build / Activity, then a
 * Discussion sheet with a Build sheet folded under it. Both are gone (#2605).
 * Build is a place the AUTHOR works and a reader rarely looks, and squeezing
 * a whole dev session under a card's discussion gave it neither the room nor
 * the address it needs. The card's pill — "Continue building" / "Open build"
 * / "Read the build" (`_topicCard`) — now NAVIGATES, to the change's own dev
 * session page, which is where the workspace and the published chat both
 * live. `AppView.openChangeWorkspace` routes there unconditionally, so there
 * is no `change-workspace-open` event and nothing on this page listens for
 * one.
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

import { useEffect, useRef } from 'react';
import { unmountLegacyPortal } from '../../../lib/legacy-portals';
import type { TopicBody } from './model';

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

/** The Discussion sheet, and nothing under it. */
export function ChangeConversation({ body }: { item: any; body: TopicBody }) {
  const id = Number(body.changeId);
  const av = typeof window !== 'undefined' ? (window as any).AppView : null;
  return (
    <section className="dev-topic-sheet dev-conversation" data-change-conversation={id} aria-label="Discussion">
      <h4 className="dev-topic-h">Discussion</h4>
      {body.discussion
        ? <p className="dev-topic-note">{body.discussion}</p>
        : <><p className="dev-topic-note dev-conversation-audience">Visible to the group</p><Discussion id={id} readOnly={!!av?.readOnly} /></>}
    </section>
  );
}
