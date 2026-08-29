import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The three pieces of form furniture the settings screen repeats in every
 * section. Not shadcn components — shadcn has no equivalent of any of them —
 * but the same authoring rules apply: `cssVariables: false`, complete literal
 * class names, and nothing the shell does not already write.
 *
 *   SectionHeading  the `<h3>` + blurb `<p>` pair every section opens with.
 *                   Sixteen copies of one class string, in one place.
 *   StatusLine      the "settings.js writes the result of your last action
 *                   here" node. Fourteen of them, all shipping `hidden`, all
 *                   revealed and filled by id.
 *   Field           a `<label>` that WRAPS its control, as the two fields in
 *                   #agent-files-form's inline card do.
 */

/**
 * ── KNOWN, DELIBERATELY UNFIXED: SectionHeading's margins have no root ──
 *
 * SectionHeading returns a FRAGMENT, so its `mb-1` and `mb-3` land directly in
 * each of the eighteen callers' block flow with no element of this component's
 * own to own them. That is the same disease as a caller hand-writing a margin
 * on an invocation, only pointing the other way, and it is invisible to every
 * scan — there is no `<SectionHeading className="mb-3">` anywhere to find.
 *
 * It is recorded rather than fixed because both fixes cost more than the
 * defect. Wrapping the pair in a `<div>` is a rendered-DOM change at eighteen
 * call sites, and `space-y-*`'s selector is `> :not([hidden]) ~ :not([hidden])`
 * — collapsing two children into one silently changes spacing under any parent
 * that uses it. Moving the margins to the callers puts eighteen hand-written
 * utilities back, which is the thing this pass is removing. The real fix is a
 * root element landed with the settings sections, not ahead of them.
 */
export interface SectionHeadingProps {
  /** Rendered into the `<h3>`. */
  title: React.ReactNode;
  /** Rendered into the blurb `<p>`; omit for a heading with no blurb. */
  children?: React.ReactNode;
  /** Extra utilities on the blurb (`leading-relaxed` on the longer ones). */
  blurbClassName?: string;
}

function SectionHeading({ title, children, blurbClassName }: SectionHeadingProps) {
  return (
    <>
      <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 mb-1">
        {title}
      </h3>
      {children === undefined ? null : (
        <p className={cn('text-xs text-zinc-500 dark:text-zinc-300 mb-3', blurbClassName)}>
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

export interface FieldProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** The label text, rendered before the control. */
  label: React.ReactNode;
  /**
   * Ship `hidden` on the label itself, appended AFTER `cn`.
   *
   * #agent-files-desc-wrap is the deliberate display-utility conflict alert.tsx
   * warns about: it is written `block … hidden`, both the base's `block` and
   * the trailing `hidden` in one string, and tailwind-merge treats them as one
   * group — so passing `hidden` through className collapses the pair and drops
   * `block`. Appending it outside the merge keeps the rendered attribute
   * exactly as the hand-written shell wrote it. (The pair is redundant CSS
   * either way: Tailwind emits `hidden` after `block`, so `hidden` wins. It is
   * reproduced rather than tidied because chunk D changes no bytes.)
   */
  startHidden?: boolean;
  /**
   * The gap under a Field that STACKS above the next one. Both fields in
   * #agent-files-form's inline card spelled `className="mb-2"` by hand, which
   * is the caller reaching into this component's layout; the rhythm is named
   * here instead. `none` is the default — a lone Field has no sibling to
   * separate from and takes no margin.
   */
  spacing?: 'none' | 'stacked';
}

// `{...props}` is spread BEFORE className: the one Field with an id
// (#agent-files-desc-wrap) writes `id` ahead of `class`. Label, in label.tsx,
// does the reverse — its hand-written strings write `class` ahead of `for`.
function Field({ className, label, children, startHidden, spacing, ...props }: FieldProps) {
  // `'mb-2'` is a complete literal, not a lookup: Tailwind's extractor is a
  // regex over source text and a computed class name compiles to nothing.
  const base = cn(
    'block text-zinc-600 dark:text-zinc-300',
    spacing === 'stacked' && 'mb-2',
    className,
  );
  return (
    <label {...props} className={startHidden ? `${base} hidden` : base}>
      {label}
      {children}
    </label>
  );
}

export { Field, SectionHeading, StatusLine, statusLineVariants };
