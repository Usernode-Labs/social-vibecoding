/**
 * The legacy → React seam for the group chat transcript.
 *
 * `public/js/group-chat.js` is a classic script that runs before this bundle,
 * so it cannot import anything from here. It calls by name instead:
 * `window.UsernodeReact.groupChat.mountTranscript(host)` where it used to
 * assign `container.innerHTML = …`, and pushes its view model through
 * `publishTranscript`.
 *
 * ── Why the host is mounted, not rendered into the tree ───────────────
 *
 * `#gc-messages` does not exist in the shell's markup. `AppView.renderDevChatTab`
 * creates it at runtime inside `#app-content`, and destroys it on every tab
 * switch — so there is no node for the main React tree to own, and the portal
 * has to be (re)established each time the host is rebuilt. That is the same
 * situation the Dev board's regions are in, and this uses the same machinery
 * (../../lib/legacy-portals).
 *
 * `unmount` matters here more than it does for the board: the transcript is
 * re-created on every switch between the chat tab and anything else, and a
 * portal left pointing at a detached node keeps its subtree — and its store
 * subscription — alive for the life of the page.
 *
 * Published at module-evaluation time, like features/dev-board/mount.ts, so the
 * API exists before hydration and therefore long before `App.switchTab()` can
 * reach the chat tab. The `typeof window` guard is not decoration: the SSG
 * prerender pass evaluates this whole module graph in Node.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { MentionMenu, RefMenu } from './autocomplete';
import {
  autocompleteStore,
  type MentionOption,
  type RefOption,
} from './autocomplete-store';
import { Transcript } from './transcript';
import {
  EMPTY_VIEW,
  transcriptStore,
  type TranscriptLead,
  type TranscriptMessage,
  type TranscriptState,
} from './transcript-store';

/** Mount (or re-establish) the transcript inside the host app-view just built. */
export function mountTranscript(host: Element | null, key = 'main'): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(Transcript, { source: key }));
}

export function unmountTranscript(host: Element | null): void {
  if (!host) return;
  unmountLegacyPortal(host);
}

/** The whole transcript, replacing whatever was there. */
export function publishTranscript(
  messages: TranscriptMessage[],
  key = 'main',
  lead: TranscriptLead = { earlier: false, placeholder: null },
): void {
  transcriptStore.set((s: TranscriptState) => ({
    ready: true,
    byKey: { ...s.byKey, [key]: { messages, lead } },
  }));
}

/**
 * Append one row — the live-message path.
 *
 * A separate entry point rather than a re-publish of the whole list because
 * that is what the caller has: `appendMessage` used to `insertAdjacentHTML` a
 * single row precisely so an incoming message did not rebuild the transcript
 * under the reader's scroll position. Appending to the array preserves that
 * property through the reconciler instead of around it.
 */
export function appendTranscriptMessage(message: TranscriptMessage, key = 'main'): void {
  transcriptStore.set((s: TranscriptState) => {
    const view = s.byKey[key] || EMPTY_VIEW;
    return {
      ready: true,
      byKey: { ...s.byKey, [key]: { ...view, messages: [...view.messages, message] } },
    };
  });
}

/**
 * Patch one row in place — reactions, a bookmark toggle, an edit.
 *
 * Each of these used to be its own targeted `innerHTML` write into a row the
 * module had built. They are a field update now, and React repaints only the
 * row whose identity changed. A patch for an unknown id is a no-op rather than
 * an append: the row may legitimately have been pruned by a reload that raced
 * the websocket event.
 */
export function patchTranscriptMessage(id: number, patch: Partial<TranscriptMessage>): void {
  transcriptStore.set((s: TranscriptState) => {
    let hit = false;
    const byKey: Record<string, typeof EMPTY_VIEW> = {};
    // Patched across EVERY transcript: the same message can be on screen in
    // both the general chat and an open thread, and a reaction on one is a
    // reaction on the other.
    for (const [k, view] of Object.entries(s.byKey)) {
      byKey[k] = {
        ...view,
        messages: view.messages.map((m: TranscriptMessage) => {
          if (m.id !== id) return m;
          hit = true;
          return { ...m, ...patch };
        }),
      };
    }
    return hit ? { ...s, byKey } : s;
  });
}

/**
 * `setFlush(flushSync)` on the autocomplete store, and it is load-bearing.
 *
 * `_render()` publishes the rows and then, two lines later, calls
 * `_position()`, which reads `menu.offsetHeight` to decide whether the menu
 * fits above the composer or has to flip below it. Batched — React 18's
 * default for an update that starts outside React — that measurement would run
 * against the previous frame and a freshly-opened menu would be placed as if
 * it were empty. The innerHTML assignment this replaces was synchronous, so
 * the flush is what keeps the contract rather than what changes it.
 */
autocompleteStore.setFlush(flushSync);

// ── The composer's two autocomplete menus ─────────────────────────────
//
// Same seam, one level smaller: `_ensureMenu` still creates the floating host
// and appends it to `document.body` — it is `position: fixed`, measured
// against the composer, and belongs to no React tree — and then mounts a
// portal into it ONCE. Everything after that is a publish.
//
// `mountLegacyPortal` is the right tool even though these hosts are never
// destroyed: it is what gives the subtree a root, and the unmount path exists
// for symmetry rather than because anything calls it today.

/** Establish the `@name` menu's contents. Idempotent — the host is cached. */
export function mountMentionMenu(host: Element | null): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(MentionMenu));
}

/** Establish the `#123` / `PR#123` menu's contents. */
export function mountRefMenu(host: Element | null): void {
  if (!host) return;
  mountLegacyPortal(host, createElement(RefMenu));
}

/**
 * The rows and the highlighted index, together.
 *
 * One call rather than a publish plus a separate "move the highlight",
 * because an arrow key changes only `active` and a new token changes both —
 * and the module already holds them as one pair (`_items` / `_active`).
 */
export function publishMentionMenu(items: MentionOption[], active: number): void {
  autocompleteStore.set({ mention: { items, active } });
}

export function publishRefMenu(items: RefOption[], active: number): void {
  autocompleteStore.set({ ref: { items, active } });
}

if (typeof window !== 'undefined') {
  const w = window as unknown as { UsernodeReact?: Record<string, unknown> };
  w.UsernodeReact = w.UsernodeReact || {};
  (w.UsernodeReact as Record<string, unknown>).groupChat = {
    mountTranscript,
    unmountTranscript,
    publishTranscript,
    appendTranscriptMessage,
    patchTranscriptMessage,
    mountMentionMenu,
    mountRefMenu,
    publishMentionMenu,
    publishRefMenu,
  };
}
