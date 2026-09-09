/**
 * The four banners between the dev chat's session header and its panes, as
 * view models.
 *
 * ── Why they convert together ─────────────────────────────────────────
 *
 * Not because they are similar — the sync banner is about the branch and the
 * credits pair is about money — but because they share ONE slot and three
 * copies of the same in-place dance. Each had an `_apply*Banner` that read the
 * current element, replaced its `outerHTML` when there was still something to
 * say, `remove()`d it when there was not, and `insertAdjacentHTML`'d it back
 * before `.dc-session-body` when it had to reappear. `_applySyncBanner` could
 * not even do the last part and fell through to a whole `renderChatView`.
 *
 * That dance exists because a banner must be able to appear, change and vanish
 * mid-session WITHOUT re-rendering the transcript under an in-flight stream.
 * A store does that by construction: one publish, four independent slots, and
 * the message list is not in the subtree.
 *
 * ── The host is `display: contents` ───────────────────────────────────
 *
 * `#dc-view` is a flex column and the banners were its direct flex children.
 * A plain wrapper would take their place in that box tree and the banners
 * would become block children of it — a different layout for the same markup.
 * `#dc-banners` is `class="contents"`, so it generates no box at all and each
 * banner stays exactly the flex child it was. Same trick, same reason, for the
 * `CreditOptions.bannerActionsHtml` sink below.
 *
 * ── What stays another module's ───────────────────────────────────────
 *
 * `CreditOptions.bannerActionsHtml` builds the route buttons for both credits
 * banners, and `CreditOptions.wire` binds ONE delegated click per mounted
 * node to run them. A declared check selects into that markup
 * (`#dc-credits-banner .dc-credits-banner-actions > button#dc-credits-add-key
 * + button[data-credits-venue="1"]:last-child`), so it arrives whole, through
 * a `display: contents` sink, and the component calls `wire` on the banner
 * element from a ref — `wire` is idempotent per element (`__creditOptionsWired`)
 * and adding a listener is not a DOM write, so there is no second author here.
 */

import { createStore } from '../../lib/plain-store.js';

/** The sync-with-main banner, in its four states. */
export type SyncBannerView =
  /** A sync is running somewhere — this tab, another, the resume trigger. */
  | { kind: 'inflight'; message: string }
  /** It finished cleanly. Auto-dismissed by the timer in `_setSyncTerminal`. */
  | { kind: 'ok'; message: string }
  /** It failed, and the message stays put with a re-enabled button. */
  | { kind: 'failed'; message: string; busy: boolean }
  /** Nothing in flight; the branch is simply behind. */
  | { kind: 'behind'; behind: number; busy: boolean };

/** "This change has been proposed / merged — start a new change." */
export interface NewChangeBannerView {
  /** Already composed: "proposed to the group (PR #12)" / "merged (PR #12)". */
  stateLabel: string;
  /** The click is in flight. Was `btn.disabled` + `btn.textContent`, written
   *  onto the element by id — a second author on a node this now renders. */
  pending: boolean;
}

/**
 * The credits pair. ONE shape, because they are one banner in two tenses:
 * the red one says the allowance is gone, the amber one says it is nearly
 * gone, and the locked / unavailable variants are the red one's other two
 * reasons. Writing them as four templates is what let their copy drift.
 */
export interface CreditsBannerView {
  /** Which element this is — a declared check selects each by id. */
  id: 'dc-credits-banner' | 'dc-credits-low-banner';
  tone: 'amber' | 'red';
  /** 'person' for the unlock-by-connecting variant; null for unavailable. */
  icon: 'person' | 'warn' | 'clock' | null;
  /** The bold opener. RAW text — React escapes it, so no entities here. */
  lead: string;
  /** The low banner's lead carries `data-credits-low-lead`; a check reads it. */
  leadTagged: boolean;
  /** The reset sentence, in its own `[data-credits-reset]` span, or null. */
  reset: string | null;
  /** Everything after the reset span. */
  tail: string;
  /** `CreditOptions.bannerActionsHtml`'s markup, carried whole. */
  actionsHtml: string;
  /** Which refusal the venue sheet should mark as blocked when opened here. */
  blockedVenue: boolean;
}

export interface BannersState {
  sync: SyncBannerView | null;
  newChange: NewChangeBannerView | null;
  credits: CreditsBannerView | null;
  creditsLow: CreditsBannerView | null;
}

export const NO_BANNERS: BannersState = {
  sync: null, newChange: null, credits: null, creditsLow: null,
};

export const bannersStore = createStore<BannersState>(NO_BANNERS);
