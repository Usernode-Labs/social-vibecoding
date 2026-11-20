import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The two pieces of form furniture the settings screen repeats in every
 * section. Not shadcn components — shadcn has no equivalent of either —
 * but the same authoring rules apply: `cssVariables: false`, complete literal
 * class names, and nothing the shell does not already write.
 *
 *   SectionHeading  the `<h3>` + blurb `<p>` pair every section opens with.
 *                   Sixteen copies of one class string, in one place.
 *   StatusLine      the "settings.js writes the result of your last action
 *                   here" node. Fourteen of them, all shipping `hidden`, all
 *                   revealed and filled by id.
 */

export interface SectionHeadingProps {
  /** Rendered into the `<h3>`. */
  title: React.ReactNode;
  /** Rendered into the blurb `<p>`; omit for a heading with no blurb. */
  children?: React.ReactNode;
  /**
   * Extra utilities on the `<h3>`, merged over its defaults (`cn`, so
   * `mb-0` really does cancel the default `mb-1`).
   *
   * It exists for the heading that is an ITEM in a row rather than a block on
   * its own — the challenge page's participants line sits on one baseline
   * beside its points total and needs `shrink-0`. Without this a caller in
   * that position has no way in and re-declares the class string instead,
   * which is the duplication this primitive was extracted to end.
   */
  className?: string;
  /** Extra utilities on the blurb (`leading-relaxed` on the longer ones). */
  blurbClassName?: string;
}

function SectionHeading({ title, children, className, blurbClassName }: SectionHeadingProps) {
  return (
    <>
      <h3 className={cn('ui-sechead text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1', className)}>
        {title}
      </h3>
      {children === undefined ? null : (
        <p className={cn('ui-secblurb text-xs text-zinc-500 dark:text-zinc-400 mb-3', blurbClassName)}>
          {children}
        </p>
      )}
    </>
  );
}

/**
 * cva emits variant groups in declaration order, so `size` then `spacing` then
 * `hidden` is what reproduces `text-sm mt-3 hidden` and `text-xs mt-2 hidden`
 * byte for byte.
 *
 * `hidden` is the element's INITIAL, prerendered visibility only. settings.js
 * owns the class from init() onwards, which is exactly why these nodes are
 * rendered once and never reconciled.
 */
const statusLineVariants = cva('', {
  variants: {
    size: { sm: 'text-sm', xs: 'text-xs' },
    spacing: { 2: 'mt-2', 3: 'mt-3' },
    startHidden: { true: 'hidden', false: '' },
  },
  defaultVariants: { size: 'sm', spacing: 2, startHidden: true },
});

export interface StatusLineProps
  extends React.HTMLAttributes<HTMLElement>,
    VariantProps<typeof statusLineVariants> {
  id: string;
  /** `div` (the default) or `p`, matching whichever the shell shipped. */
  as?: 'div' | 'p';
}

function StatusLine({
  as: Tag = 'div',
  className,
  size,
  spacing,
  startHidden,
  ...props
}: StatusLineProps) {
  return (
    <Tag
      {...props}
      className={cn(statusLineVariants({ size, spacing, startHidden }), className)}
    />
  );
}

export { SectionHeading, StatusLine, statusLineVariants };
