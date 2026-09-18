import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * A native `<select>`, styled with the shell's own field tokens.
 *
 * ── Why this is NOT @radix-ui/react-select ─────────────────────────────
 *
 * Stock shadcn's Select renders a `<button role="combobox">` plus a portalled
 * listbox — no `<select>` element and no `<option>`s anywhere in the document.
 * The three selects on this screen cannot survive that:
 *
 *   #settings-locale              settings.js reads `.value` and writes
 *                                 `.value` on it, and dapp.json anchors a
 *                                 rendered check on the element itself
 *   #settings-openrouter-model    settings.js BUILDS its <option> list from
 *                                 the catalogue response
 *   #settings-openrouter-reasoning  settings.js reads/writes `.value`
 *
 * A portalled combobox would move the control out of its section, break every
 * one of those id-bound reads, and change the rendered DOM on a screen whose
 * whole contract this chunk is "the DOM does not change". Radix Select is a
 * real improvement to reach for later — behind its own before/after evidence,
 * once the surrounding behaviour lives in React and can hand it value/onChange
 * — not a free swap inside a like-for-like conversion.
 *
 * Same authoring rules as button.tsx: `cssVariables: false`, complete literal
 * class names, and nothing the shell does not already apply.
 */
const selectVariants = cva('w-full rounded-lg', {
  variants: {
    variant: {
      // #settings-openrouter-model / -reasoning — the filled field box, same
      // fill and focus ring as Input's `default`.
      default:
        'bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500',
      // #settings-locale — a lighter fill and no focus ring. Kept as its own
      // variant rather than normalised onto `default`: they are two different
      // rendered strings today, and reconciling them is a visual change with
      // its own evidence to gather.
      plain:
        'bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200',
      // The waitlist surveys' select — #waitlist-country, #more-group-size,
      // #more-group-role — and the exact `<select>` counterpart of Input's
      // `authWhite` box with its `bordered` ring, which is why it carries the
      // focused border colour `default` and `plain` do not (#1529: iOS Safari
      // paints no box-shadow on a natively-styled control, and a select is the
      // control that report actually named).
      //
      // Pairing note: these three selects and the thirteen inputs beside them
      // are ONE field shape, so the two tables have to be read together. Both
      // are spread from `SURVEY_FIELD` / `SURVEY_SELECT` in
      // features/auth/waitlist-shared.tsx rather than named at each call site,
      // so the pair cannot drift apart a screen at a time.
      authWhite:
        'bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:border-violet-500',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface SelectProps
  extends React.SelectHTMLAttributes<HTMLSelectElement>,
    VariantProps<typeof selectVariants> {}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, variant, ...props }, ref) => (
    <select
      ref={ref}
      {...props}
      className={cn(selectVariants({ variant }), className)}
    />
  ),
);
Select.displayName = 'Select';

export { Select, selectVariants };
