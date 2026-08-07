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
 * every variant below is transcribed from a real button that already exists
 * in the shell. The `default` variant + `default` size reproduce, exactly:
 *
 *   rounded-lg bg-violet-600 hover:bg-violet-500 px-4 py-2 text-sm
 *   font-medium text-white transition-colors
 *
 * which is the class string on `#settings-save` — the one live conversion
 * step 1 lands (see Shell.tsx). Its rendered DOM is therefore byte-identical
 * to the hand-written button it replaced, which is what makes the
 * screenshot-parity gate a real test of the shadcn wiring rather than an
 * assertion about it.
 *
 * ── Rules for editing this file ────────────────────────────────────────
 *
 * - Do NOT add utilities the shell doesn't already apply to that element.
 *   Stock shadcn's focus-ring and disabled-opacity utilities would each be a
 *   visual change, and step 1's whole contract is that there are none. They
 *   belong in a step-2 slice with its own before/after evidence. (Don't name
 *   such a utility literally in a comment either: Tailwind's extractor is a
 *   regex over source text and would compile a rule for it.)
 * - Keep every class name a COMPLETE literal. Tailwind's extractor is a
 *   regex over source text, and tests/tailwind-build.test.js fails the
 *   suite on a class name assembled from fragments.
 * - The other variants below are transcribed from existing shell buttons so
 *   step-2 conversions have somewhere to land; they are unused today.
 */
const buttonVariants = cva('font-medium transition-colors', {
  variants: {
    variant: {
      // #settings-save, #cp-save, #wallet-link-btn — the primary action.
      default: 'bg-violet-600 hover:bg-violet-500 text-white',
      // #agent-files-cancel, #waiting-logout — the neutral bordered button.
      outline:
        'border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-900',
      // #settings-remove — the bordered destructive button.
      destructive:
        'border border-red-400 dark:border-red-700 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950',
      // Header icon buttons (#feedback-btn, #notifications-btn, …).
      ghost: 'text-zinc-400 hover:text-zinc-200',
      // #btn-otp-back, #wallet-link-cancel — the quiet text link.
      link: 'text-zinc-500 hover:text-zinc-300',
    },
    size: {
      default: 'rounded-lg px-4 py-2 text-sm',
      sm: 'rounded px-3 py-1',
      // Icon buttons carry their own sizing from the surrounding layout.
      icon: '',
      // Text-only controls add no box of their own.
      inline: 'text-sm',
    },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, ...props }, ref) => (
    <button
      ref={ref}
      // The shell's markup omits `type`, so its buttons default to `submit`.
      // Defaulting to `button` here would change form behaviour, which is a
      // behavioural change step 1 does not make. Pass it through untouched.
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button, buttonVariants };
