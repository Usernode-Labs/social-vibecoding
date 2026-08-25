import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Screen chrome: the floating circular control, the bar it sits in, and the
 * three title treatments the deck uses.
 *
 * ── Why the buttons FLOAT rather than sit in a bar ────────────────────
 *
 * The pre-reskin shell has one opaque header strip with a bottom border, and
 * every control lives inside it. The language draws no strip at all: the page
 * ground runs to the top of the screen and the controls are white discs
 * floating on it. That is what makes the large-title screens read as one
 * continuous surface — there is no rule under the title to cut the page in
 * two.
 *
 * The consequence is that these components DO NOT REPLACE `#platform-header`,
 * and they still have no consumers. That bar carries three live affordances
 * (the Improve pill, the view toggle, the hamburger) plus a back glyph and a
 * title, against the one a floating-disc treatment has room for, and
 * reconciling that is a product decision, not a restyle.
 *
 * The bar HAS taken the language in every way that did not require that
 * decision — features/header/platform-header.tsx: the rule under it is gone
 * (the page ground runs to the top of the screen), its controls are inked
 * near-black instead of muted, and the hamburger is one of these discs in all
 * but name. What is still deferred is the SHAPE below the bar: `LargeTitle`
 * under a bare row of floating buttons, which is a layout change and needs
 * the four-affordance question answered first.
 *
 * So these stay the vocabulary for a screen that opts in, and the fact that
 * nothing has yet is the deferral, not an oversight.
 *
 * ── Three titles, not one with a `variant` ────────────────────────────
 *
 * `LargeTitle` (Home, Activity), `PillTitle` (the two chats) and
 * `StackedTitle` (the Changes list) differ in structure, not styling: one is a
 * block-level heading under the bar, one is a self-contained rounded object
 * INSIDE the bar carrying its own icon and status, one is centred text between
 * two buttons. A single component with a `variant` prop would be a switch
 * statement over three unrelated trees.
 */

export function CircleButton({
  className, children, ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return (
    <button
      type="button"
      className={cn(
        'flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm transition-colors hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 [&>svg]:h-6 [&>svg]:w-6',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * The top row. `center` is optional: with it the bar is a three-up flex whose
 * centre grows (the chat screens' pill); without it, `leading` and `trailing`
 * push apart (the large-title screens' logo and avatar).
 */
export function NavBar({
  className, leading, center, trailing, ...props
}: {
  leading?: React.ReactNode;
  center?: React.ReactNode;
  trailing?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-center gap-3 px-4 py-2', className)} {...props}>
      {/* Both edges render even when empty so the centre stays optically centred
          on a screen that has a back button but no trailing control. */}
      <div className="flex shrink-0 items-center gap-2">{leading}</div>
      {center ? <div className="flex min-w-0 flex-1 justify-center">{center}</div> : <div className="flex-1" />}
      <div className="flex shrink-0 items-center gap-2">{trailing}</div>
    </div>
  );
}

export function LargeTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cn('px-4 pb-2 pt-3 text-[2.75rem] font-bold leading-tight tracking-tight text-zinc-900 dark:text-zinc-100', className)}
      {...props}
    />
  );
}

/** Centred title over a lighter subtitle — the Changes list's "Recipe App / All Changes". */
export function StackedTitle({
  className, title, subtitle, ...props
}: { title: React.ReactNode; subtitle?: React.ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={cn('min-w-0 text-center', className)} {...props}>
      <div className="truncate text-[1.375rem] font-bold text-zinc-900 dark:text-zinc-100">{title}</div>
      {subtitle ? (
        <div className="truncate text-[1.0625rem] text-zinc-500 dark:text-zinc-500">{subtitle}</div>
      ) : null}
    </div>
  );
}

/**
 * The chat screens' self-contained header object: a rounded-full container
 * holding a small glyph tile, the conversation's name, its context line, and
 * an optional status dot.
 *
 * It is a `<button>` because in the deck it is tappable (it opens the
 * conversation's detail), and `max-w-full` + the inner truncation are what
 * keep a long name from pushing the dot out of the pill.
 */
export function PillTitle({
  className, icon, title, subtitle, dot, ...props
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  dot?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'title'>) {
  return (
    <button
      type="button"
      className={cn(
        'flex min-w-0 max-w-full items-center gap-2.5 rounded-full bg-zinc-200/60 py-1.5 pl-1.5 pr-4 text-left transition-colors hover:bg-zinc-200 dark:bg-zinc-800/60 dark:hover:bg-zinc-800',
        className,
      )}
      {...props}
    >
      {icon ? (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 [&>svg]:h-5 [&>svg]:w-5">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{title}</span>
          {dot ? (
            <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
          ) : null}
        </span>
        {subtitle ? (
          <span className="block truncate text-[0.9375rem] leading-tight text-zinc-500 dark:text-zinc-500">
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}
