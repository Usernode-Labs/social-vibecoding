/**
 * The Dev screen's two body-mounted modals, as plain view models.
 *
 * Each is the same shape: `public/js/app-view.js` creates a scrim `<div>` at
 * `z-[60]`, appends it to `<body>`, owns its dismissal (backdrop click,
 * Escape) and removes it — the body-mounted floating-host seam the group
 * chat's menus established. React owns only the CHILDREN of that scrim.
 *
 * ── One dialog, drawn twice ────────────────────────────────────────────
 *
 * They share the centring wrapper, the white/zinc-900 card and the
 * two-button footer, in the widget language's one spelling of each
 * (`DialogCard`, `<Button>`, `<Button variant="neutral" ink="neutral">`):
 * the language never draws an OUTLINED secondary on a floating card.
 *
 * ── Resolved data in, markup out ───────────────────────────────────────
 *
 * Every decision stays in app-view.js: which capacity branch the consent
 * dialog is in, whether the BYOK checkbox is forced. The component receives the ANSWER.
 * app-view.js is a classic script the bundle cannot import, and Tailwind's
 * extractor is a regex over source text, so a table copied into a component
 * would exist twice with only one copy able to change.
 */

/**
 * The app-permission prompt (#2219).
 *
 * Every string here is RESOLVED: app-view.js has already picked the
 * sentence, the note and the button label from the catalogue and from
 * whether this grant needs the app reopened. The card renders them.
 */
export interface PermissionConsentModalView {
  /** Permissions Policy token, e.g. "microphone". Identity, not copy. */
  capability: string;
  /** The catalogue's short name for the chip, e.g. "Microphone". */
  label: string;
  /** The whole question, e.g. "Allow Notes to record audio from your microphone?" */
  title: string;
  /** The app's own one-line reason from its dapp.json, in quotes. */
  reason: string | null;
  /** What granting means: scope, how to undo it, and any reopen to come. */
  note: string;
  /**
   * "Always allow" where "Allow this time" is also offered (the App tab);
   * elsewhere "Allow", or "Allow and reopen" when the frame must re-navigate.
   */
  confirmLabel: string;
  /** "Allow this time": a grant for as long as the app stays open, never stored. Null where it cannot apply. */
  onceLabel?: string | null;
}

export interface LlmConsentModalView {
  appName: string;
  /** `appName` is the "This app" stand-in: the title uses its unnamed wording. */
  appUnnamed?: boolean;
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
