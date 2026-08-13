import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn's Label, RESTYLED TO THE PLATFORM'S EXISTING TOKENS.
 *
 * Stock shadcn builds this on @radix-ui/react-label. That package renders the
 * same `<label>` element, but it also swallows the mousedown that would
 * otherwise select the label's text on a double click — a behavioural change,
 * on every labelled control in the app, that chunk D has no evidence for. The
 * platform's labels are plain `<label for=…>` elements and stay that way; the
 * dependency buys nothing the native element does not already do.
 *
 * `default` reproduces, exactly, the field label the settings screen uses:
 *
 *   block text-xs font-medium text-zinc-700 dark:text-zinc-300
 *
 * with the caller supplying the trailing margin (`mb-1`, `mt-2 mb-1`) that
 * varies per field. Keep every class name a COMPLETE literal.
 *
 * className is rendered BEFORE `{...props}` here, the reverse of Alert/Input:
 * React serializes attributes in prop order, and every hand-written label on
 * this screen writes `class` ahead of `for`. (Field, in field.tsx, spreads
 * first for the same reason — the one label with an id writes `id` ahead of
 * `class`.)
 */
const labelVariants = cva('block', {
  variants: {
    variant: {
      // Field labels across the settings screen.
      default: 'text-xs font-medium text-zinc-700 dark:text-zinc-300',
      // The quieter label inside #agent-files-form's inline card, which wraps
      // its control rather than pointing at it.
      inline: 'text-zinc-600 dark:text-zinc-400',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement>,
    VariantProps<typeof labelVariants> {}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, variant, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(labelVariants({ variant }), className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label, labelVariants };
