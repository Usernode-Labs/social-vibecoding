import { useEffect } from 'react';

import { PlusIcon } from '@/components/ui/icons';

import {
  initializeGlobalChat,
  startNewGlobalChat,
  useGlobalChatState,
} from './store';

/**
 * The way IN to the experimental chat interface after a user opts in — from
 * Improve, at the head of its dedicated Chats group.
 *
 * ── It is an entry point now, not a mode switch ────────────────────────
 *
 * This shipped in the header as a two-way toggle whose label flipped `Chat` /
 * `Classic`, and it is one-way here. The return trip already had two owners
 * INSIDE the chat screen — "Use Classic" on the bootstrap-error state and the
 * "Open in Classic" link every authoritative result carries — and of the three
 * controls saying it, the header's was the one that had to reach across the
 * whole shell to say it about a screen it was not part of. Once chat is up
 * this button is behind it, so the `is-chat` active state it wore has no
 * state left to show and is gone with it.
 *
 * ── Why it sits beside the changes in flight ───────────────────────────
 *
 * Improve is the surface for everything you can do *to* the app, and a chat
 * that proposes changes is another way to start one. Its own Chats heading
 * keeps conversations distinct from coding changes while leaving both kinds
 * of work in the same sidebar.
 *
 * ── A NEW durable session on every press ───────────────────────────────
 *
 * The thread is created first and its `#chat/<uuid>` route is then opened.
 * Existing sessions stay in the Chats group immediately below this button,
 * so New never replaces or flashes a previous conversation.
 *
 * ── First render is still the prerender ────────────────────────────────
 *
 * `parityReady` and the persisted opt-in arrive from an effect, so this renders
 * `null` on the SSG pass and on hydration alike — the invariant
 * #improve-panel's own header states, and the reason this control can live
 * inside that island without a mismatch.
 */
export function GlobalChatNewChatButton({ onNavigate }: {
  /** Close the surface this button sits on before the chat screen covers it. */
  onNavigate?: () => void;
}) {
  const snapshot = useGlobalChatState();

  useEffect(() => {
    void initializeGlobalChat();
    const retry = () => { void initializeGlobalChat({ force: true }); };
    window.addEventListener('sv:authed', retry);
    return () => window.removeEventListener('sv:authed', retry);
  }, []);

  // The checked-in parity artifact remains the release gate, while the
  // persisted profile is each user's explicit opt-in. Both must be true: a
  // ready experiment does not become a platform-wide rollout by accident.
  if (!snapshot.bootstrap?.parityReady
      || snapshot.bootstrap.profiles.globalChat.enabled !== true) return null;

  return (
    <button
      id="global-chat-new-chat-btn"
      type="button"
      className="global-chat-new-chat-btn"
      aria-label="New chat (experimental)"
      title="New chat (experimental)"
      onClick={() => {
        // Dismiss first so the route opens as a page, not underneath the
        // Improve sheet that launched it.
        onNavigate?.();
        void startNewGlobalChat();
      }}
    >
      <PlusIcon className="w-4 h-4" aria-hidden="true" />
      <span>New chat <span>(experimental)</span></span>
    </button>
  );
}
