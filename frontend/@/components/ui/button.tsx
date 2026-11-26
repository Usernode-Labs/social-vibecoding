import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn's Button, RESTYLED TO THE PLATFORM'S EXISTING TOKENS.
 *
 * ── Why the variant table looks nothing like stock shadcn ──────────────
 *
 * shadcn normally ships a CSS-variable theme (`bg-primary`,
 * `text-primary-foreground`, `ring-ring`, `rounded-md`, `focus-visible:*`,
 * `disabled:opacity-50`, …). The platform shell has never used that
 * vocabulary: it writes literal utilities against a hand-tuned `zinc` /
 * `violet` palette that tailwind.config.js overrides, and it has no
 * `--background` / `--foreground` / `--radius` layer at all.
 *
 * So this install runs with `cssVariables: false` (see components.json) and
 * every value below is transcribed from a real button that already exists in
 * the shell — no value here is invented.
 *
 * ── Why five groups, in THIS order ─────────────────────────────────────
 *
 * cva emits the base string, then each variant group IN DECLARATION ORDER,
 * then whatever `cn` appends from className. The only way to reproduce a
 * hand-written class string byte for byte is therefore to declare the groups
 * in the order those strings were written in. Every primary button in the
 * shell is written in exactly this order:
 *
 *   [layout] [radius + surface] [disabled] [padding + weight] [ink]
 *   shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm
 *   font-medium text-white transition-colors
 *
 * so that is the group order. The base string is EMPTY: the old base led with
 * `font-medium transition-colors`, which no hand-written button in the shell
 * leads with, and that mismatch is precisely why 26 buttons could not route
 * through this primitive before (see the note this replaces in
 * features/settings/sections/api-key.tsx). Weight now travels with `size`,
 * where the shell writes it, and `transition-colors` with `ink`.
 *
 * Two spellings of the trailing pair exist in the shell and both are kept:
 * the dialogs and settings screens write `text-white transition-colors`, the
 * auth screens write `transition-colors text-white`. That is a hand-authored
 * accident, and normalising it would be a byte change for no benefit — so
 * `ink` carries `solid` and `solidLate` rather than one canonical spelling,
 * exactly as `input.tsx`'s `mono` group carries the same kind of split.
 *
 * `disabled` is the leading spelling only (`… hover:bg-violet-500
 * disabled:opacity-50 px-6 …`). Three buttons write those utilities at the
 * very END of the string instead; they pass them through `className`, which
 * lands last.
 *
 * ── The four kinds ─────────────────────────────────────────────────────
 *
 * A page's actions come in four kinds, and every one of them is drawn here
 * rather than as a hand-written <button> with its own class string
 * (tests/button-primitive-ratchet.test.js holds the number of those down).
 * The standard look's BUTTONS block in app.css draws each kind from the
 * classes a variant writes, so a kind is a `variant`, not a group of its own:
 *
 *   primary    the main action: the yellow pill with the dark sticker edge.
 *              `pillAccent` (and `default`, `pill`, `compact`, the boxes of
 *              the same accent fill); `sun` for the shared `.one-btn-1`
 *              recipe; `cta` for the page's top action (New project).
 *   secondary  the white pill beside it: `pillRaised`.
 *   quiet      the tinted pill (Invite, Skip, Decline): `pillNeutral` with
 *              ink `neutral` (and `neutral`, `pillOnCard`, the same tint on
 *              other grounds); `brandTint` in the header's own colours.
 *   link       words underlined (Settings' Change and Add): `link`.
 *
 * A NEW action picks the kind's variant and the size the screen needs. A
 * value is added only where no existing one writes the same classes, so a
 * converted button keeps every class it wore and looks exactly as it did.
 *
 * ── Rules for editing this file ────────────────────────────────────────
 *
 * - Do NOT add utilities the shell doesn't already apply to that element.
 *   Stock shadcn's focus-ring utilities would each be a visual change, and
 *   this slice's contract is that there are none. (Don't name such a utility
 *   literally in a comment either: Tailwind's extractor is a regex over
 *   source text and would compile a rule for it.)
 * - Keep every class name a COMPLETE literal. Tailwind's extractor is a
 *   regex over source text, and tests/tailwind-build.test.js fails the
 *   suite on a class name assembled from fragments.
 * - Add a value only with a call site to justify it, and name that call site
 *   in a comment — that is what keeps this table a transcription rather than
 *   a design system nobody agreed to.
 */
const buttonVariants = cva('', {
  variants: {
    /**
     * Utilities the shell writes BEFORE the box. Every value here leads a
     * real class string; there is no combinatorial expansion, only the pairs
     * that actually ship.
     */
    layout: {
      none: '',
      // #create-app-submit, #rename-app-save, #feedback-send, … — the right
      // half of a two-button dialog footer.
      flex: 'flex-1',
      // #wallet-link-btn, #register-submit, #login-submit.
      full: 'w-full',
      // The landing page's inline call to action.
      inlineBlock: 'inline-block',
      // #settings-save, #settings-openrouter-save, #connector-add — beside a
      // flex-1 field.
      shrink: 'shrink-0',
      // #settings-remove.
      hiddenShrink: 'hidden shrink-0',
      // #members-invite-confirm.
      hidden: 'hidden',
      // The profile screen writes its padding and its 44px tap target BEFORE
      // the box rather than after it, so on that button the padding travels
      // here and the `size` group contributes nothing. #profile-edit-save.
      tapFull: 'w-full px-4 min-h-[44px]',
      // A glyph beside a word, in a row of its own.
      iconRow: 'inline-flex items-center gap-2',
      // The landing site's pills (features/auth/story.tsx and
      // features/guest/guest-communities.tsx): a 44px row, its words on one
      // line. With variant `sitePrimary` or `siteSecondary`.
      site: 'inline-flex min-h-11 items-center justify-center whitespace-nowrap',
      // #improve-row-feedback — the Improve panel's "Give feedback" (#1367).
      // The same glyph-beside-a-word row as iconRow, spanning the panel's
      // width and centred in it, which is what makes it read as the panel's
      // one primary action rather than as another list row.
      fullIconRow: 'w-full inline-flex items-center justify-center gap-2',
    },
    /** Radius + surface. Radius leads the box in every shell button. */
    variant: {
      // The primary action, everywhere.
      default: 'rounded-lg bg-violet-600 hover:bg-violet-500',
      // The profile screen's spelling of the same box, one step darker on
      // hover. #profile-edit-save and the publish/unpublish button both write
      // it; normalising them to `default` would be a visual change, and this
      // slice's contract is that there are none.
      tapPrimary: 'rounded-lg bg-violet-600 hover:bg-violet-700',
      // The bell drawer's invite Accept button — a `text-xs` action row inside
      // the notifications panel, one radius step up from `compact`.
      pill: 'rounded-md bg-violet-600 hover:bg-violet-500',
      // The settings rows' Re-enable and Use defaults (grants-list.tsx,
      // app-permissions-list.tsx, notification-prefs-list.tsx) — the same
      // action inside a `text-xs` row card, where the smaller radius matches
      // the card.
      compact: 'rounded bg-violet-600 hover:bg-violet-500',
      // Radius only, the fill in `ink`: the hub's invite hero button
      // (features/dev-board/workshop/community-card.tsx, .dev-ws-invite-hero-btn).
      roundedFull: 'rounded-full',
      // PRIMARY, as the shared recipe draws it (app.css, ONE LOOK · SHARED
      // PARTS: `.one-btn.one-btn-1`, the sun with the sticker edge, 44px on a
      // phone and 36px from 768px). The recipe carries its own box, size and
      // ink, so it goes with size `none` and ink `none`. Call site: a
      // project's Open app (features/dev-board/workshop/community-card.tsx).
      sun: 'one-btn one-btn-1',
      // PRIMARY as the page's top action (app.css `.wip-cta`, and the ids'
      // own rules for New project and New community): the same recipe-only
      // shape as `sun`, with size `none` and ink `none`. Call site: WipCta
      // (features/home/wip-kit.tsx), Home's New project and Communities' New
      // community and Discover.
      cta: 'wip-cta',
      // QUIET in the header's own colours: the brand tint, its hairline and
      // (ink `brand`) its words. Call site: the header's Suggest
      // (features/header/in-app-actions.tsx, #header-in-app-suggest), which
      // the standard look redraws in the sky tint.
      brandTint: 'rounded-full border border-[color:var(--brand-line)] bg-[color:var(--brand-tint)]',
      // The landing site's own PRIMARY and SECONDARY (features/auth/story.tsx):
      // a pill on the site's ink outline with a hard edge under it, in the
      // sun or in the panel's white. With layout, size and ink `site`
      // (`siteOnSun` on the sun).
      sitePrimary: 'rounded-full shadow-[inset_0_0_0_1px_var(--site-line),0_2px_0_var(--site-line)] bg-[var(--site-sun)]',
      siteSecondary: 'rounded-full shadow-[inset_0_0_0_1px_var(--site-line),0_2px_0_var(--site-line)] bg-[var(--site-panel)]',
      // LINK: a word that acts, inside a row (app.css `.ui-link`, underlined
      // by the standard look's Settings rules). With size `link` and ink
      // `link`. Call site: Settings' sign-in rows' Change and Add
      // (features/settings/sections/sign-in-row.tsx RowAction).
      link: 'ui-link rounded-lg',
      // The neutral bordered sibling of `compact`: the Connectors pane's Copy
      // buttons and the welcome tour's Back.
      //
      // THIS VARIANT CARRIES NO INK, and the default ink is `solid` (white).
      // `variant="outline"` on its own therefore renders white text on a
      // white card — an invisible label, which is exactly how the three
      // messages dialogs shipped their Cancel/Done buttons until a contrast
      // sweep measured them at 1.00:1. Every call site must pass an ink;
      // `muted` is what the two that got it right pass.
      outline: 'rounded border border-zinc-300 dark:border-zinc-700',
      // The widget language's SECONDARY action: a filled neutral pill, not an
      // outline. The language separates by figure/ground rather than by rule,
      // and an outlined control on a floating white card is the one shape it
      // never draws — the same reason the cards themselves lost their borders.
      // Call sites: the profile screen's Edit profile, Preview, Open public
      // page, Copy public link, Reveal and Browse challenges, all of which
      // were `border border-zinc-300` or `border border-violet-500` boxes.
      neutral: 'rounded-lg bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700',
      // The widget language's filled pills (settings, sign-in, the bell):
      // the accent one for the primary act, the neutral one beside it, and
      // the danger tint for the one destructive control on a page — a tint,
      // not an outline, because the language fills its controls.
      pillAccent: 'rounded-full bg-violet-600 hover:bg-violet-500',
      pillNeutral: 'rounded-full bg-zinc-100 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700',
      // The neutral pill on a zinc-100 ground, where `pillNeutral`'s own
      // zinc-100 fill vanishes: white and lifted by a shadow in light, as the
      // made screen's second button is drawn, and `pillNeutral`'s fills in
      // dark. Call site: the first-session invite sheet's second button
      // (features/first-session/made.tsx InviteSheet, #4180).
      pillRaised: 'rounded-full bg-white shadow-sm hover:bg-zinc-50 dark:bg-zinc-800 dark:hover:bg-zinc-700',
      // The neutral pill on a card that is itself drawn in `pillNeutral`'s
      // fills: the messages surface (#2c2c2e in dark, the same as zinc-800)
      // and the white light card, where zinc-100 is a faint wash and the pill
      // read as a line of text (#4200). One step darker than the card in both
      // themes, still neutral: a secondary action, not the accent. Call site:
      // the Homeroom bot's activity card and tray tile links
      // (features/messages/bot-activity.tsx ActivityLink).
      pillOnCard: 'rounded-full bg-zinc-200 hover:bg-zinc-300 dark:bg-zinc-700 dark:hover:bg-zinc-600',
      pillDanger: 'rounded-full bg-red-500/10 hover:bg-red-500/15',
      // #settings-remove — the bordered destructive button.
      destructive: 'rounded-lg border border-red-400 dark:border-red-700',
      // Buttons that carry no box of their own (header icon buttons, text
      // links); they bring their own utilities through className.
      unstyled: '',
    },
    /**
     * The leading spelling of the disabled treatment. Named `disabledStyle`,
     * not `disabled`, so the DOM attribute keeps its own name: a button
     * STYLED for the disabled state and a button that IS disabled are
     * different things, and the group claiming `disabled` would force every
     * call site onto a renamed prop for the ordinary one.
     */
    disabledStyle: {
      off: '',
      // #waitlist-submit, #more-submit.
      dim: 'disabled:opacity-50',
      // #create-app-import-check.
      block: 'disabled:opacity-50 disabled:cursor-not-allowed',
      // The avatar crop dialog's Save (features/profile/avatar-crop-dialog.tsx),
      // which writes the same pair one step less dim.
      dim60: 'disabled:opacity-60 disabled:cursor-not-allowed',
    },
    /** Padding, optional text size, and weight — written as one run. */
    size: {
      // The standard button.
      default: 'px-4 py-2 text-sm font-medium',
      // The auth screens' buttons, which inherit their text size from the
      // form rather than setting it.
      plain: 'px-4 py-2 font-medium',
      // #settings-remove, beside a `px-4 py-2` primary.
      narrow: 'px-3 py-2 text-sm font-medium',
      // The native wallet sheet's actions (features/header/wallet-sheet-body.tsx).
      // Same box as `narrow`, one weight up: a bottom sheet's controls carry
      // more weight than a settings row's because the sheet IS the screen
      // while it is up. Transcribed from the buttons that module built
      // imperatively before it was a component, not invented for it.
      narrowBold: 'px-3 py-2 text-sm font-semibold',
      // The same weight with NO horizontal padding, for a button that fills a
      // flex cell and takes its width from the row rather than its own box —
      // the wallet sheet's Send / Receive pair.
      flushBold: 'py-2 text-sm font-semibold',
      // The members dialog's row actions.
      sm: 'px-3 py-1.5 text-sm font-medium',
      // The settings rows' compact Re-enable and Use defaults, and the board's
      // merges-paused Resume, which inherit their text size from the row.
      xs: 'px-3 py-1 font-medium',
      // The same box, with the text size the bell drawer's invite buttons
      // spell out rather than inherit.
      xsText: 'px-3 py-1 text-xs font-medium',
      // The landing page and waitlist call to action.
      lg: 'px-5 py-2 text-sm font-medium',
      // The pills' two heights: 40px beside a field, 48px as a screen's
      // primary button.
      pill: 'px-5 py-2.5 text-[15px] font-semibold',
      pillLg: 'px-5 py-3 text-[17px] font-semibold',
      // The 40px pill with the text size spelled `text-sm`: the bell drawer's
      // invite Decline (features/notifications/notifications-list.tsx).
      pillText: 'px-5 py-2.5 text-sm font-semibold',
      // The header's small pill: a pencil alone on a phone, with its word
      // from `sm` (#header-in-app-suggest).
      chip: 'px-1.5 sm:px-2.5 text-[0.8125rem] font-semibold',
      // A row's word action (variant `link`).
      link: 'px-2 py-1 text-[15px] font-medium',
      // The landing site's pills, in its display face (variant `sitePrimary`
      // or `siteSecondary`).
      site: 'px-[18px] py-2 text-center font-[family-name:var(--site-display)] text-[16px] leading-[22px] font-medium',
      // #more-submit.
      xl: 'px-6 py-2 text-sm font-medium',
      // Icon buttons carry their own sizing from the surrounding layout.
      icon: '',
      // Nothing to add: the box comes from elsewhere — the `tapFull` layout's
      // padding, a recipe variant's own box (`sun`, `cta`), or the call
      // site's className.
      none: '',
      // Text-only controls add no box of their own.
      inline: 'text-sm',
    },
    /** Text colour, hover fill where the surface has none, and the transition. */
    ink: {
      none: '',
      solid: 'text-white transition-colors',
      // #profile-edit-save and the profile's publish/unpublish button, which
      // fold the text size and weight into this trailing run and carry no
      // transition. Their `disabled:opacity-60` is written at the very end of
      // the string, so it rides in through className like the three buttons
      // named in the header.
      solidText: 'text-white text-sm font-medium',
      // The auth screens' spelling of the same pair — see the header.
      solidLate: 'transition-colors text-white',
      // The quiet secondary label: `outline`'s Copy and Back, and the
      // dialogs' Cancel and Done.
      muted:
        'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
      // The ink that goes with `variant: 'neutral'` — near-black, which is
      // what the language puts on a control you are meant to be able to hit.
      // The fill is already in `variant`, so this group only carries colour.
      neutral: 'text-zinc-900 dark:text-zinc-100 transition-colors',
      // #settings-remove.
      danger:
        'text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors',
      // Danger ink on the danger-tint pill, whose hover is the pill's own.
      dangerTint: 'text-red-700 dark:text-red-400 transition-colors',
      // The accent as ink, on a neutral fill: the accent's own colour, a
      // step lighter in dark mode. Call site: the app frame's status action
      // (features/app-frame/app-status.tsx), on `pillRaised`. It was made for
      // the Getting started card's outlined step buttons, retired with the
      // card (#4635).
      accent: 'text-violet-600 dark:text-violet-400 transition-colors',
      // The header's ink on `brandTint`.
      brand: 'text-[color:var(--brand-ink)]',
      // The landing site's ink, and its ink on the sun.
      site: 'text-[color:var(--site-ink)]',
      siteOnSun: 'text-[color:var(--site-on-sun)]',
      // The link's words, its hover a step lighter, and the keyboard's ring
      // as Settings' rows have always drawn it (variant `link`).
      link: 'text-violet-700 hover:text-violet-500 dark:text-violet-400 dark:hover:text-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
    },
  },
  defaultVariants: {
    layout: 'none',
    variant: 'default',
    disabledStyle: 'off',
    size: 'default',
    ink: 'solid',
  },
});

// `disabled` is the plain DOM attribute here, exactly as on a bare <button>.
// The styling arm is `disabledStyle`, so the two are independent: a call site
// can take the treatment without the attribute (the state arrives later, from
// a legacy module), or the attribute without the treatment.
export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

// `{...props}` is spread BEFORE className, like Input: React serializes
// attributes in prop order, and the hand-written markup writes `id` and
// `type` ahead of `class`. className is destructured out above, so the spread
// can never clobber it.
//
// The shell's markup omits `type`, so its buttons default to `submit`.
// Defaulting to `button` here would change form behaviour on every converted
// call site, which a like-for-like conversion does not do — `type` simply
// rides along in `props`.
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, layout, variant, disabledStyle, size, ink, disabled, ...props }, ref) => (
    <button
      ref={ref}
      {...props}
      disabled={disabled}
      className={cn(
        buttonVariants({ layout, variant, disabledStyle, size, ink }),
        className,
      )}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
