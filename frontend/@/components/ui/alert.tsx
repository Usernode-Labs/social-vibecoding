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
 *                     text-amber-800 dark:text-amber-200 text-xs text-center
 *                     px-3 py-1.5
 *
 * The dark ink is the one value that has MOVED since that transcription. The
 * banner shipped `dark:text-amber-400` against a light `text-amber-800`, and
 * under APCA those are not the same ink: amber-400 on the dark card is the
 * larger-or-bolder tier while amber-800 on white is body-preferred, and this
 * strip is 12px centred text. amber-200 is the step tailwind.config.js solved
 * as amber's dark-mode ink (200 does double duty — a pale tint in light, the
 * readable ink on a dark ground), which is where the rest of the product's
 * warn inks are going.
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
    // Declared BEFORE `variant` on purpose. cva emits variant groups in
    // declaration order, so this puts `hidden` at the FRONT of the class
    // string — which is where the hand-written shell had it, and what keeps
    // the prerendered public/index.html byte-identical. It is a variant rather
    // than a caller-supplied `className` for the same reason: `cn(variants,
    // className)` would append it and reverse the order.
    //
    // This is the element's INITIAL, prerendered visibility only. Once
    // hydrated, the class is owned by a ref (see lib/legacy-dom.ts) — a
    // re-render must not rewrite the whole `class` attribute on a node
    // public/js/** also writes to.
    startHidden: { true: 'hidden', false: '' },
    variant: {
      // #offline-banner — a full-bleed strip under the header. `shrink-0`
      // keeps it out of the flex column's height negotiation.
      banner:
        'shrink-0 bg-amber-500/15 border-b border-amber-500/30 text-amber-800 dark:text-amber-200 text-xs text-center px-3 py-1.5',
    },
  },
  defaultVariants: { variant: 'banner', startHidden: false },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {}

// `{...props}` is spread BEFORE className (stock shadcn does the reverse).
// React serializes attributes in prop order, so this emits `id` ahead of
// `class` — again, the order the hand-written markup had. className is
// destructured out above, so the spread can never clobber it.
const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, startHidden, ...props }, ref) => (
    <div
      ref={ref}
      {...props}
      className={cn(alertVariants({ variant, startHidden }), className)}
    />
  ),
);
Alert.displayName = 'Alert';

export { Alert, alertVariants };
