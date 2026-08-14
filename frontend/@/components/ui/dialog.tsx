import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The shell's dialog chassis: the backdrop root and the card that floats on
 * it, which all nine dialogs spelled out by hand until this slice.
 *
 * ── Why this is NOT @radix-ui/react-dialog ─────────────────────────────
 *
 * Stock shadcn's Dialog is a Radix wrapper, and Radix's `Dialog.Content`
 * renders through a PORTAL into `document.body`. Three separate things in this
 * shell break if it does:
 *
 *   * `public/index.html` is PRERENDERED with `renderToStaticMarkup`. A
 *     portal emits nothing during that pass, so nine roots would vanish from
 *     the built document — and `tests/baselines/shell-markup.json` pins their
 *     ids, `tests/dapp-selectors-resolve.test.js` resolves selector chains
 *     into them, and a first paint would flash without them.
 *   * the native kit does its OWN reparenting. `useStaticModal` lifts the card
 *     out of the root into `PlatformUI.modal()`'s shell and writes
 *     `platform-modal-adopted` to the root; a portal would be a second owner
 *     of the same move, which is precisely the split ownership #1078 chunk I
 *     removed.
 *   * `frontend/package.json` has no `@radix-ui/*` dependency and this slice
 *     does not add one. Every primitive in this directory is hand-rolled
 *     against the shell's own markup.
 *
 * So both components below render IN PLACE, exactly where the island sits in
 * the static tree, and the kit stays the only thing that moves them.
 *
 * ── Why DialogRoot takes no className ──────────────────────────────────
 *
 * The kit writes `platform-modal-adopted` to the root at runtime and
 * `useStaticModal` toggles `hidden` there through `classList`. React must
 * therefore render that node's class attribute to the SAME string on every
 * pass — an unequal string means React writes the attribute and the kit's
 * class is gone. A `className` prop is the obvious way for a caller to break
 * that, so there isn't one: `layout` picks between the two roots the shell
 * actually ships and nothing else can reach the attribute.
 *
 * (cva itself is fine here. It returns a fresh string each call, but with
 * identical CONTENT while `layout` is constant, and React compares className
 * by value — equal strings, no DOM write.)
 *
 * `hidden` leads the base string because that is where the hand-written shell
 * put it, and `tests/dialog-components.test.js` asserts the prerendered roots
 * start with it.
 */
const dialogRootVariants = cva('hidden fixed inset-0 z-50', {
  variants: {
    layout: {
      /**
       * Eight of the nine. The card can be taller than the viewport, so the
       * root scrolls and a wrapper centres the card within `min-h-full`.
       */
      scroll: 'overflow-y-auto overscroll-contain bg-black/60',
      /**
       * #app-secrets-modal, which caps its own height at `80vh` and scrolls
       * its rows internally, so the root centres it directly and never
       * scrolls.
       */
      centered: 'flex items-center justify-center bg-black/60',
    },
  },
  defaultVariants: { layout: 'scroll' },
});

/**
 * The card. Three widths, and two independent flags for the two dialogs that
 * need more than a width.
 *
 * `shadow-xl` sits inside `relative` rather than in the base string because
 * the shell writes the pair in that order (`… shadow-xl relative`) and cva
 * emits groups in declaration order — see button.tsx's header for why that
 * ordering rule is the whole mechanism here.
 */
const dialogCardVariants = cva('bg-white dark:bg-zinc-900 rounded-xl p-6 w-full', {
  variants: {
    size: {
      // rename, close-issue, fork, members, feedback, create.
      sm: 'max-w-sm',
      // import-pr, share.
      md: 'max-w-md',
      // app-secrets, which also gutters itself because its root does not.
      lg: 'max-w-lg mx-4',
    },
    /** For the two cards with an absolutely-positioned close button. */
    relative: { true: 'shadow-xl relative', false: 'shadow-xl' },
    /** #app-secrets-modal's internally-scrolling body. */
    scroll: { true: 'max-h-[80vh] flex flex-col', false: '' },
  },
  defaultVariants: { size: 'sm', relative: false, scroll: false },
});

export interface DialogRootProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className'>,
    VariantProps<typeof dialogRootVariants> {}

/**
 * The backdrop root, plus — for `layout="scroll"` — the centring wrapper that
 * carries `data-modal-backdrop`. That wrapper is part of the chassis, not of
 * any dialog's content: `useDialog`'s dismiss rule looks for exactly that
 * attribute, and eight dialogs had transcribed the same `<div>` for it.
 */
const DialogRoot = React.forwardRef<HTMLDivElement, DialogRootProps>(
  ({ layout, children, ...props }, ref) => (
    // `{...props}` before className so `id` and the `data-*` attributes
    // serialize ahead of `class`, as they do in the hand-written shell.
    <div ref={ref} {...props} className={dialogRootVariants({ layout })}>
      {layout === 'centered' ? (
        children
      ) : (
        <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
          {children}
        </div>
      )}
    </div>
  ),
);
DialogRoot.displayName = 'DialogRoot';

export interface DialogCardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof dialogCardVariants> {}

/**
 * The card. Unlike the root this DOES take className and arbitrary props —
 * #create-card mirrors `data-mode` / `data-import-state` onto itself, and
 * nothing at runtime writes classes to this node.
 */
const DialogCard = React.forwardRef<HTMLDivElement, DialogCardProps>(
  ({ className, size, relative, scroll, ...props }, ref) => (
    <div
      ref={ref}
      {...props}
      className={cn(dialogCardVariants({ size, relative, scroll }), className)}
    />
  ),
);
DialogCard.displayName = 'DialogCard';

export { DialogRoot, DialogCard, dialogRootVariants, dialogCardVariants };
