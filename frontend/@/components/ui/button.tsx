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
      // #waiting-continue.
      blockFull: 'block w-full',
      // The landing page's inline call to action.
      inlineBlock: 'inline-block',
      // #settings-save, #settings-openrouter-save, #connector-add — beside a
      // flex-1 field.
      shrink: 'shrink-0',
      // #settings-remove.
      hiddenShrink: 'hidden shrink-0',
      // #members-invite-confirm.
      hidden: 'hidden',
      // #password-change-submit.
      stacked: 'mt-2 w-full',
      // #password-set-submit, revealed only for passwordless accounts.
      hiddenStacked: 'hidden mt-2 w-full',
    },
    /** Radius + surface. Radius leads the box in every shell button. */
    variant: {
      // The primary action, everywhere.
      default: 'rounded-lg bg-violet-600 hover:bg-violet-500',
      // #agent-files-save — the same action inside a `text-xs` inline card,
      // where the smaller radius matches the card.
      compact: 'rounded bg-violet-600 hover:bg-violet-500',
      // #agent-files-cancel — the neutral bordered sibling of `compact`.
      outline: 'rounded border border-zinc-300 dark:border-zinc-700',
      // #settings-remove — the bordered destructive button.
      destructive: 'rounded-lg border border-red-400 dark:border-red-700',
      // Buttons that carry no box of their own (header icon buttons, text
      // links); they bring their own utilities through className.
      unstyled: '',
    },
    /** The leading spelling of the disabled treatment. */
    disabled: {
      off: '',
      // #waitlist-submit, #more-submit.
      dim: 'disabled:opacity-50',
      // #create-app-import-check.
      block: 'disabled:opacity-50 disabled:cursor-not-allowed',
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
      // The members dialog's row actions.
      sm: 'px-3 py-1.5 text-sm font-medium',
      // #agent-files-save / #agent-files-cancel.
      xs: 'px-3 py-1 font-medium',
      // The landing page and waitlist call to action.
      lg: 'px-5 py-2 text-sm font-medium',
      // #more-submit.
      xl: 'px-6 py-2 text-sm font-medium',
      // Icon buttons carry their own sizing from the surrounding layout.
      icon: '',
      // Text-only controls add no box of their own.
      inline: 'text-sm',
    },
    /** Text colour, hover fill where the surface has none, and the transition. */
    ink: {
      none: '',
      solid: 'text-white transition-colors',
      // The auth screens' spelling of the same pair — see the header.
      solidLate: 'transition-colors text-white',
      // #agent-files-cancel.
      muted:
        'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors',
      // #settings-remove.
      danger:
        'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 transition-colors',
    },
  },
  defaultVariants: {
    layout: 'none',
    variant: 'default',
    disabled: 'off',
    size: 'default',
    ink: 'solid',
  },
});

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'disabled'>,
    VariantProps<typeof buttonVariants> {
  /**
   * The real DOM attribute. `disabled` is taken by the variant group above,
   * so the attribute is spelled out separately rather than shadowed — a
   * button that is styled for the disabled state and a button that IS
   * disabled are different things, and several call sites want only the
   * former (the state arrives later, from a legacy module).
   */
  isDisabled?: boolean;
}

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
  ({ className, layout, variant, disabled, size, ink, isDisabled, ...props }, ref) => (
    <button
      ref={ref}
      {...props}
      disabled={isDisabled}
      className={cn(
        buttonVariants({ layout, variant, disabled, size, ink }),
        className,
      )}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
