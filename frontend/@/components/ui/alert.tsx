import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn's Alert, RESTYLED TO THE PLATFORM'S EXISTING TOKENS.
 *
 * Same rules as button.tsx, and for the same reason: this install runs with
 * `cssVariables: false`, so stock shadcn's `bg-background` /
 * `text-muted-foreground` / `border-destructive` vocabulary does not exist
 * here. Every variant below is transcribed from a banner that already ships in
 * the shell, so the rendered class string is byte-identical to the markup it
 * replaces.
 *
 * The `banner` variant reproduces, exactly:
 *
 *   #offline-banner   shrink-0 bg-amber-500/15 border-b border-amber-500/30
 *                     text-amber-600 dark:text-amber-400 text-xs text-center
 *                     px-3 py-1.5
 *
 * ── Why the OTHER amber banner is not in here ──────────────────────────
 *
 * `#view-as-non-admin-banner` looks like a sibling variant and deliberately
 * is not one. Its class string carries BOTH `hidden` and `flex`: it is hidden
 * by default and revealed by an app.css rule
 * (`body.is-view-as-non-admin #view-as-non-admin-banner { display: flex }`)
 * whose id+class specificity beats the utility. Those are the same
 * tailwind-merge group, so routing that string through `cn` collapses the
 * pair and silently drops one — which is why that banner renders a literal
 * class string instead (see features/shell/banners.tsx). Anything else with a
 * deliberate display-utility conflict belongs outside this primitive too.
 *
 * ── Rules for editing this file ────────────────────────────────────────
 *
 * - Do NOT add utilities the shell doesn't already apply to that element
 *   (stock shadcn's `relative w-full rounded-lg border p-4` box, its
 *   `[&>svg]` icon slots). Each would be a visual change.
 * - Keep every class name a COMPLETE literal — Tailwind's extractor is a
 *   regex over source text, and tests/tailwind-build.test.js fails the suite
 *   on a class name assembled from fragments.
 * - `role` is deliberately NOT set. The hand-written banners are plain divs,
 *   and adding `role="alert"` would change the rendered DOM (and make a
 *   screen reader announce a banner that has been on the page all along).
 *   Announcing them properly is a real accessibility improvement and belongs
 *   in its own slice, with its own before/after evidence.
 */
const alertVariants = cva('', {
  variants: {
    variant: {
      // #offline-banner — a full-bleed strip under the header. `shrink-0`
      // keeps it out of the flex column's height negotiation.
      banner:
        'shrink-0 bg-amber-500/15 border-b border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs text-center px-3 py-1.5',
    },
  },
  defaultVariants: { variant: 'banner' },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <div ref={ref} className={cn(alertVariants({ variant }), className)} {...props} />
  ),
);
Alert.displayName = 'Alert';

export { Alert, alertVariants };
