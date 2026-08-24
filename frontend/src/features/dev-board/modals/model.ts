/**
 * The Dev screen's three body-mounted modals, as plain view models.
 *
 * These are the last markup `public/js/app-view.js` builds by hand. Each is
 * the same shape: the module creates a scrim `<div>` at `z-[60]`, appends it
 * to `<body>`, owns its dismissal (backdrop click, Escape) and removes it —
 * the body-mounted floating-host seam the group chat's menus established.
 * React owns only the CHILDREN of that scrim.
 *
 * ── Why they convert together ──────────────────────────────────────────
 *
 * They are three copies of one dialog: the same centring wrapper, the same
 * white/zinc-900 card, and the same two-button footer written out three
 * times with three slightly different class strings. The widget language has
 * one spelling of each (`DialogCard`, `<Button>`, `<Button variant="neutral"
 * ink="neutral">`), and the difference between a converted dialog's footer
 * and these three is exactly the difference the reskin exists to remove: an
 * OUTLINED secondary on a floating card, which the language never draws.
 *
 * ── Resolved data in, markup out ───────────────────────────────────────
 *
 * Every decision stays in app-view.js: which copy an OpenRouter run gets,
 * what a model option is called (`DevChat.modelOptionText`), which capacity
 * branch the consent dialog is in, whether the BYOK checkbox is forced. The
 * component receives the ANSWER. app-view.js is a classic script the bundle
 * cannot import, and Tailwind's extractor is a regex over source text, so a
 * table copied into a component would exist twice with only one copy able to
 * change.
 */

/** A `<option>` in the Generate-proposal picker, with its caption. */
export interface ModelOption {
  id: string;
  label: string;
  /** The caption under the picker while this option is selected. */
  note: string;
  /** That caption's tooltip; empty on the OpenRouter branch. */
  noteTitle: string;
}

export interface AutoSessionModalView {
  issueNumber: number;
  /** The paragraph explaining what confirming does. Two branches, one string. */
  intro: string;
  /** "Building in <b>X</b> — your saved default. …", already split. */
  venue: { label: string; blurb: string } | null;
  /** 'Chat model' or 'OpenRouter model'. */
  pickerLabel: string;
  options: ModelOption[];
  preselect: string;
}

export interface CreditOptionsModalView {
  /**
   * `CreditOptions.cardHtml(state)` — another module's markup, sanitised
   * where it is built, and its own controller (`CreditOptions.wire`) keeps
   * reading inside it. A controller-host seam, not a second author.
   */
  cardHtml: string;
}

export interface LlmConsentModalView {
  appName: string;
  /** The app's own one-line reason, in quotes. */
  purpose: string | null;
  /** The sentence under the title; the BYOK-only branch reads differently. */
  intro: string;
  /**
   * `cap` is the ordinary dialog; `blocked` is the amber box that replaces
   * the whole field when no payer is available.
   */
  capacity:
    | { t: 'blocked'; eligibilityUnavailable: boolean }
    | {
      t: 'cap';
      /** Prefilled dollars, already divided and fixed to 2dp. */
      prefill: string;
      suggestedNote: string;
      /** The BYOK opt-in, absent when the account has no key. */
      byok: { checked: boolean; label: string } | null;
    };
}
