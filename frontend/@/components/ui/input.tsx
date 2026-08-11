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
 *          sibling in the pending-upload form.
 *
 * Keep every class name a COMPLETE literal — Tailwind's extractor is a regex
 * over source text, and tests/tailwind-build.test.js fails the suite on a
 * class name assembled from fragments.
 */
const inputVariants = cva('', {
  variants: {
    // Leads the string on the two fields inside #agent-files-form, which sit
    // under their own label text rather than beside it.
    spacing: { mt1: 'mt-1', none: '' },
    width: { full: 'w-full', flex: 'flex-1 min-w-0', none: '' },
    box: {
      // The settings screen's standard field.
      default:
        'rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100',
      // The compact field inside #agent-files-form's inline card — a lighter
      // fill on the card's darker one, and a smaller box to match its text-xs
      // container.
      inset:
        'rounded bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-2 py-1',
    },
    mono: { true: 'font-mono', false: '' },
    ring: {
      true: 'focus:outline-none focus:ring-2 focus:ring-violet-500',
      false: '',
    },
    // Only the `inset` box carries its text colour after the two groups above;
    // `default` has it inline, where the hand-written string put it.
    text: { true: 'text-zinc-900 dark:text-zinc-100', false: '' },
  },
  defaultVariants: {
    spacing: 'none',
    width: 'full',
    box: 'default',
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
  ({ className, spacing, width, box, mono, ring, text, ...props }, ref) => (
    <input
      ref={ref}
      {...props}
      className={cn(
        inputVariants({ spacing, width, box, mono, ring, text }),
        className,
      )}
    />
  ),
);
Input.displayName = 'Input';

export { Input, inputVariants };
