/**
 * The dev chat's session header strip, as a view model.
 *
 * `#dc-session-header` is the one row that survives every swap below it: the
 * launchpad replaces the composer for the three hand-off venues (#1281), the
 * banners come and go, the transcript is rebuilt — and the back control, the
 * session's name, its pull request, its lifecycle pill and the venue dropdown
 * stay put. That is what makes it a clean first boundary in `renderChatView`.
 *
 * ── The ELEMENT stays the module's ────────────────────────────────────
 *
 * Only the children are React's. `PlatformUI.attachScreenFx` writes a
 * hairline/blur class onto the header element itself once the chat scrolls, so
 * a rendered `className` there would be a second author on the same attribute
 * — the rule `frontend/src/lib/legacy-dom.ts` exists for. `renderChatView`'s
 * template keeps writing the element; this fills it.
 *
 * ── Why the venue button is rendered here and not handed in ───────────
 *
 * `dapp.json` selects it as
 * `#dc-session-header > button#dc-venue-select…:last-child` — a DIRECT child,
 * and the last one. `BuildVenues.selectorHtml` used to build that button as a
 * string and the template interpolated it, which a conversion cannot preserve
 * through a wrapped `dangerouslySetInnerHTML` sink: the wrapper would become
 * the direct child and the button a grandchild. So the button is JSX, built
 * from the `BuildVenues.venue()` spec the string builder read, and
 * `selectorHtml` is retired — it had one production caller.
 *
 * ── The lifecycle pill is DATA, not markup ────────────────────────────
 *
 * `MergeStatus.lifecycle(session)` returns a plain descriptor and
 * `MergeStatus.pillHtml` draws it; the descriptor travels and the component
 * draws it instead. `badgeHtml`'s own callers are untouched and still build
 * strings — this converts one of the two shapes, not the module.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * `MergeStatus.lifecycle()`'s descriptor, as much of it as the pill draws.
 * A plain object already, which is why it can cross the store unchanged.
 */
export interface MergeLife {
  key: string;
  label: string;
  tone: string;
  spinner?: boolean;
  glyph?: string;
  title?: string;
  votes?: { yes: number; majority: number; advisory: number } | null;
}

/** The venue dropdown, resolved from `BuildVenues.venue(id)`. */
export interface VenueButton {
  id: string;
  label: string;
  title: string;
  /** Mid-turn the venue cannot change: a running turn holds the worker. */
  disabled: boolean;
}

export interface SessionHeaderState {
  /**
   * `#app/<slug>/dev`, or '' when there is no app in scope. Empty renders an
   * anchor with an empty href, exactly as the template did — the control is
   * still there, it just has nowhere to go.
   */
  backHref: string;
  /** The session's name, already resolved through its three fallbacks. */
  title: string;
  /** The branch name, which is what the title's tooltip shows. */
  branch: string;
  /** The pull request number, or null for the "New change" caption. */
  pr: number | null;
  prTitle: string;
  newChangeTitle: string;
  /** null when the session has no merge lifecycle worth a pill (paused, …). */
  life: MergeLife | null;
  /** null when BuildVenues is absent or the id resolves to no venue. */
  venue: VenueButton | null;
}

export const EMPTY_SESSION_HEADER: SessionHeaderState = {
  backHref: '',
  title: '',
  branch: '',
  pr: null,
  prTitle: '',
  newChangeTitle: '',
  life: null,
  venue: null,
};

export const sessionHeaderStore = createStore<SessionHeaderState>(EMPTY_SESSION_HEADER);
