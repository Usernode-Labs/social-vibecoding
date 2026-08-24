import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn's Input, RESTYLED TO THE PLATFORM'S EXISTING TOKENS.
 *
 * Same rules as button.tsx: `cssVariables: false`, so stock shadcn's
 * `bg-background` / `ring-offset-background` / `file:` vocabulary does not
 * exist here, and every class below is transcribed from a text field that
 * already ships in the shell. Nothing stock is added — no `h-10`, no
 * `disabled:cursor-not-allowed`, no `placeholder:text-muted-foreground` — each
 * would be a visual change, and chunk D makes none.
 *
 * The variant table reproduces, exactly, the field box the settings screen has
 * used since it was a modal:
 *
 *   rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300
 *   dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100
 *
 * ── Why `width`, `mono` and `ring` are variants rather than className ──
 *
 * cva emits the base string, then each variant group IN DECLARATION ORDER,
 * then whatever `cn` appends from className. So the only way to reproduce a
 * hand-written class string byte for byte is to declare the groups in the
 * order those strings were written in. The three groups here exist for exactly
 * that reason:
 *
 *   width  `w-full` / `flex-1 min-w-0` lead every one of these strings.
 *   mono   #connector-url writes `font-mono` BEFORE the focus ring;
 *          #settings-api-key and #settings-openrouter-key write it after. The
 *          prop is the first spelling, `className="font-mono"` the second, so
 *          both render unchanged. (Two hand-authored strings, one accidental
 *          difference — normalising it is a byte change for no benefit, and a
 *          byte change is the one thing a like-for-like conversion cannot
 *          make.)
 *   ring   the shell's focus treatment, absent from #agent-files-name and its
 *          sibling in the pending-upload form, and carrying
 *          `focus:border-transparent` on the dialogs' fields.
 *   hint   the placeholder colour, which the dialogs and the auth screens
 *          spell differently.
 *
 * `box` grew the same way: `dialog`, `tight` and `auth` are three more real
 * field boxes, not three opinions about one. Where two of them differ only by
 * an accident of authoring they are still kept apart — reconciling them is a
 * visual change with its own evidence to gather, and a byte change is the one
 * thing a like-for-like conversion cannot make.
 *
 * Keep every class name a COMPLETE literal — Tailwind's extractor is a regex
 * over source text, and tests/tailwind-build.test.js fails the suite on a
 * class name assembled from fragments.
 */
const inputVariants = cva('', {
  variants: {
    /**
     * A styling class from app.css that LEADS the string, ahead of everything
     * this table draws. It is a variant rather than a `className` for the one
     * reason every group here exists: className lands LAST, and this does not.
     *
     * `composer` is `.gc-composer-input` — the group chat's two composers,
     * whose only rule is `line-height: 1.5`, tuned against the wrapped
     * multi-line box the auto-grow produces. Call site:
     * features/group-chat/composer.tsx.
     */
    lead: { composer: 'gc-composer-input', none: '' },
    // Leads the string on the two fields inside #agent-files-form, which sit
    // under their own label text rather than beside it.
    spacing: { mt1: 'mt-1', none: '' },
    width: {
      full: 'w-full',
      flex: 'flex-1 min-w-0',
      // #share-url-input, which sits in a `flex gap-2` row with no long value
      // to shrink around.
      flex1: 'flex-1',
      // #members-approvals-n, the approvals-threshold number field.
      hiddenW16: 'hidden w-16',
      // #llm-consent-cap, the app-consent dialog's dollars-per-day field —
      // wide enough for "1000.00" and no wider, so it reads as an amount
      // rather than as a text field.
      w32: 'w-32',
      none: '',
    },
    box: {
      // The settings screen's standard field.
      default:
        'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100',
      // The dialogs' field: the same box, but inheriting its text size from
      // the card rather than setting `text-sm` itself.
      dialog:
        'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100',
      // #members-approvals-n — the same box at number-field size.
      tight:
        'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm text-zinc-900 dark:text-zinc-100',
      // The auth screens' field. A darker dark-mode fill than the settings
      // one (`zinc-900`, against the auth card's `zinc-800`), and no text
      // size of its own. Kept separate rather than normalised onto
      // `default`: they are two different rendered strings today.
      auth:
        'rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-zinc-900 dark:text-zinc-100',
      // The compact field inside #agent-files-form's inline card — a lighter
      // fill on the card's darker one, and a smaller box to match its text-xs
      // container.
      inset:
        'rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1',
      // A field inside a native-kit inset-grouped row (#1285): the ROW is the
      // box. `.un-group` draws the card fill and radius, `.un-group-row` the
      // hairline and the `px-4` that lines it up, so the field itself
      // contributes no fill, no border and no horizontal padding — anything it
      // did contribute would draw a second box inside the first. Pair it with
      // `ring={false}`: `.un-group` is `overflow: hidden`, which clips an
      // outward focus ring, so the focus cue is a `focus-within:` tint on the
      // row instead.
      //
      // Call sites: #profile-edit-name, #profile-edit-bio (through Textarea),
      // #profile-edit-github, #profile-edit-x and #profile-edit-username, all
      // in features/profile/profile-edit-sheet.tsx.
      groupRow:
        'bg-transparent border-0 px-0 py-2 text-sm text-zinc-900 dark:text-zinc-100',
      // The group chat composer. `auth`'s darker dark-mode fill (the composer
      // sits on the chat pane, not on a card) with the settings box's
      // `text-sm`, and the two shape utilities the field needs BEFORE its
      // radius — a composer never shows a resize grip, and it scrolls inside
      // its own height cap rather than growing past it.
      //
      // Two values, not one plus padding through className, because className
      // lands after the focus ring and the padding is part of the box.
      // `composer` is the general composer and the topic thread's; `composerTight`
      // is the boxed inline thread layout. Both in
      // features/group-chat/composer.tsx.
      composer:
        'resize-none overflow-y-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100',
      composerTight:
        'resize-none overflow-y-auto rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100',
    },
    // The placeholder colour, written between the box and the focus ring in
    // every string that has it. Named `hint`, not `placeholder`, because
    // `placeholder` is a real attribute on this element and a variant group
    // of that name would shadow it at every call site.
    hint: {
      none: '',
      // The dialogs.
      muted: 'placeholder-zinc-400 dark:placeholder-zinc-500',
      // The auth screens.
      dim: 'placeholder-zinc-500',
    },
    mono: { true: 'font-mono', false: '' },
    ring: {
      true: 'focus:outline-none focus:ring-2 focus:ring-violet-500',
      false: '',
      // The dialogs' fields also drop the border colour while focused, so the
      // ring reads as the only edge.
      seamless:
        'focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-transparent',
    },
    // Only the `inset` box carries its text colour after the two groups above;
    // `default` has it inline, where the hand-written string put it.
    text: { true: 'text-zinc-900 dark:text-zinc-100', false: '' },
  },
  defaultVariants: {
    lead: 'none',
    spacing: 'none',
    width: 'full',
    box: 'default',
    hint: 'none',
    mono: false,
    ring: true,
    text: false,
  },
});

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'width'>,
    VariantProps<typeof inputVariants> {}

// `{...props}` is spread BEFORE className, like Alert: React serializes
// attributes in prop order, and the hand-written markup writes `id` and `type`
// ahead of `class`. className is destructured out above, so the spread can
// never clobber it.
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, lead, spacing, width, box, hint, mono, ring, text, ...props }, ref) => (
    <input
      ref={ref}
      {...props}
      className={cn(
        inputVariants({ lead, spacing, width, box, hint, mono, ring, text }),
        className,
      )}
    />
  ),
);
Input.displayName = 'Input';

export { Input, inputVariants };
