/**
 * `#gc-spec-side-panel` — the shared-spec reader, as a view model.
 *
 * One host, two responsive layouts, and CSS switches between them: at ≥1024px
 * an inline side panel beside the chat, below that a fullscreen modal over the
 * `gc-tab-body` row. Neither covers the app header or the vote panel, because
 * the slot lives in the layout rather than in `body` — which is also why the
 * panel survives a re-render of the chat tab.
 *
 * ── What group-chat.js keeps ──────────────────────────────────────────
 *
 * The fetch, the per-app open-state and global width persistence, the
 * draggable divider, the Escape binding (document-level, not markup), and the
 * host's own `gc-spec-side-panel-open` class — which is the AUTHORITATIVE open
 * state for the resizer and the width restore, so it stays exactly where it
 * was. React owns what is inside the panel.
 */

import { createStore } from '../../lib/plain-store.js';

export type SpecPanelBody =
  /** A 404 or a load failure. Deliberately NOT markdown: formatting an error
   *  message turns it into something that looks like a spec. */
  | { kind: 'error'; text: string }
  /** Sanitized markdown, produced by `DevChat.renderMarkdown`. */
  | { kind: 'markdown'; html: string };

export interface SpecPanelState {
  open: boolean;
  title: string;
  /** "v3 · Mar 4, 09:12 · PR #128", or null when none of the three is known. */
  subtitle: string | null;
  /**
   * Whether to offer "Copy markdown". False for an error body and for the
   * reload-restore skeleton, whose placeholder "Loading…" must never be
   * copyable.
   */
  canCopy: boolean;
  body: SpecPanelBody | null;
}

export const CLOSED_SPEC_PANEL: SpecPanelState = {
  open: false,
  title: '',
  subtitle: null,
  canCopy: false,
  body: null,
};

export const specPanelStore = createStore<SpecPanelState>(CLOSED_SPEC_PANEL);
