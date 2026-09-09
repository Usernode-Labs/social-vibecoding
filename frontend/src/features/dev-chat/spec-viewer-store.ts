/**
 * `#dc-spec-viewer`'s children — the shared-spec reader — as a view model.
 *
 * ── The last controller host on this screen ───────────────────────────
 *
 * When `#dc-view` converted, three hosts inside it stayed legacy-owned and
 * this was the only one of the three that was a genuine CONTROLLER host:
 * `_renderSpecViewer` assigned its `innerHTML` and then bound six listeners
 * to the nodes that assignment had just written. The other two are a slot an
 * overlay is positioned over and an element whose class the kit writes.
 *
 * So the pane is an ordinary parent now and this is its child. What that
 * folds away is not one string but a whole render-pass idiom: every piece of
 * the panel's own state — the copy button's flash, the share popover's open
 * flag, its typed username, its error line, its suggestion list — lived in
 * closures over ONE `_renderSpecViewer` call, and any repaint (a version
 * switch, a `spec_updated` push, a frozen-version fetch landing) threw all of
 * it away because the nodes it closed over were gone. That state is the
 * component's now, and it survives a repaint because a repaint is a
 * reconcile.
 *
 * ── What stays the module's ───────────────────────────────────────────
 *
 * Everything that is not markup. `specViewer` is still one global slot in
 * dev-chat.js — the open flag, the fetched versions, the cached content, the
 * selected version and the selected tab — because five other places read and
 * write it (`openSession`'s #233 reset, `openSpecViewer`, `openStagingPanel`,
 * `_handleSpecUpdated`, the width/open localStorage pair). The fetches stay
 * there too: `_loadSpecViewer`, `_loadSpecVersion`, `_shareSpecVersion` and
 * `_shareSpecToUser` are the module's, and each ends in a publish.
 *
 * The MARKDOWN arrives rendered. `DevChat.renderMarkdown` is marked + DOMPurify
 * behind a module-local cache, and it is not something this bundle can import
 * — dev-chat.js is loaded as a classic script by a dozen `vm`-based tests.
 * Same seam as the transcript's bubbles: resolved HTML in, `dangerouslySet`
 * out.
 */

import { createStore } from '../../lib/plain-store.js';

/** One `<option>` in the version picker, already labelled. */
export interface SpecVersionOption {
  /**
   * `'latest'` for the highest version — the sentinel that keeps FOLLOWING
   * the newest one as Mayor edits create them — or the version number for a
   * frozen older snapshot.
   */
  value: string;
  label: string;
}

/**
 * A header action button's three states.
 *
 *   - `absent` — a non-owner never sees it. Both share routes are
 *     owner-scoped server-side, so for anyone else the button could only
 *     ever fail.
 *   - `blank` — there is no version, or nothing in it. Rendered disabled and
 *     WITHOUT an id, exactly as the template did: the id is what the
 *     handlers bound to, and a disabled placeholder has none.
 *   - `live` — pressable.
 */
export type SpecAction =
  | { kind: 'absent' }
  | { kind: 'blank' }
  | { kind: 'live' };

/** The group share adds one more bit: it can be live but already spent. */
export type SpecGroupShare =
  | { kind: 'absent' }
  | { kind: 'blank' }
  | { kind: 'live'; shared: boolean };

/**
 * The panel's body.
 *
 * `split` is #196's two-section spec: a conforming doc (both marker headings
 * present — see public/js/spec-sections.js) reads as two tabs so a
 * non-technical reader lands on the plain-language half. `plain` is the
 * legacy single-body doc. An empty-but-present half still gets its tab, so
 * `halfHtml` is `''` rather than the tab disappearing between versions.
 */
export type SpecBody =
  | { kind: 'loading' }
  | { kind: 'empty'; copy: string }
  | { kind: 'split'; preambleHtml: string; tab: 'user' | 'tech'; halfHtml: string }
  | { kind: 'plain'; html: string };

export type SpecViewerState =
  /**
   * Closed, or fail-closed. #233: the viewer is ONE global slot, so a render
   * whose `specViewer.sessionId` does not match the open session draws
   * nothing rather than the previous session's spec. That used to be a bare
   * `return` out of `_renderSpecViewer`, which read as blank only because
   * `renderChatView` had just rebuilt the pane empty; the pane reconciles
   * now, so the guard has to SAY nothing rather than decline to speak.
   */
  | { kind: 'closed' }
  | {
    kind: 'open';
    /** DESC by version. Empty renders the disabled "No versions yet". */
    versions: SpecVersionOption[];
    /** The `<select>`'s value — always one of `versions`, or `''`. */
    selected: string;
    /** The version number the two share buttons act on. */
    version: number | null;
    /**
     * The WHOLE selected version, raw. #1012: "Copy markdown" yields both
     * halves plus their marker headings, so it deliberately ignores the
     * split and the active tab.
     */
    raw: string;
    body: SpecBody;
    copy: SpecAction;
    userShare: SpecAction;
    groupShare: SpecGroupShare;
    /**
     * Spec planning and building are two steps. Shown to the owner on a
     * non-empty latest version, where the next action is to ask for a build.
     */
    buildHint: boolean;
  };

export const specViewerStore = createStore<SpecViewerState>({ kind: 'closed' });
