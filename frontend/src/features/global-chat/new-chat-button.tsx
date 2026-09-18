import { useEffect } from 'react';

import { ChatIcon } from '@/components/ui/icons';

import {
  initializeGlobalChat,
  openGlobalChat,
  useGlobalChatState,
} from './store';

/**
 * The way IN to the experimental chat interface — from Improve, at the head of
 * "Changes in progress".
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
 * ── Why it sits with the changes in flight ─────────────────────────────
 *
 * Improve is the surface for everything you can do *to* the app, and a chat
 * that proposes changes is another way to start one. Reading directly against
 * the panel's own "New change", "New chat (experimental)" says what it is: the
 * experimental sibling of that same act, offered in the same breath.
 *
 * ── A NEW thread on every press ────────────────────────────────────────
 *
 * `openGlobalChat({ fresh: true })`, which is why that option exists. Opening
 * and THEN starting a new chat would fetch the previous thread's messages,
 * paint them, and clear them a moment later — a "New chat" button has no
 * business flashing last week's conversation on the way in. Resuming is what
 * the screen's own history control is for.
 *
 * ── First render is still the prerender ────────────────────────────────
 *
 * `parityReady` arrives from an effect, so this renders `null` on the SSG pass
 * and on hydration alike — the invariant #improve-panel's own header states,
 * and the reason this control can live inside that island without a mismatch.
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

  // This is the release gate, not a cohort flag. The control is absent until
  // the checked-in parity artifact says the complete experimental interface
  // is ready; once true it is shown to every signed-in viewer.
  if (!snapshot.bootstrap?.parityReady) return null;

  return (
    <button
      id="global-chat-new-chat-btn"
      type="button"
      className="global-chat-new-chat-btn"
      aria-label="New chat (experimental)"
      title="New chat (experimental)"
      onClick={() => {
        // Dismiss FIRST: setDocumentMode closes the notifications and
        // app-context sheets but knows nothing about #improve-panel, which
        // would otherwise sit over the screen it just opened.
        onNavigate?.();
        void openGlobalChat({ fresh: true });
      }}
    >
      <ChatIcon className="w-4 h-4" aria-hidden="true" />
      <span>New chat <span>(experimental)</span></span>
    </button>
  );
}
