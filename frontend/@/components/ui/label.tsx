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
 * This used to read "with the caller supplying the trailing margin (`mb-1`,
 * `mt-2 mb-1`) that varies per field", and that sentence is left here
 * CORRECTED rather than deleted because it was the instruction: eight of the
 * fourteen Label call sites hand-write a margin in `className`, and they do it
 * because this comment told them to. A component invoked with a margin in its
 * className is the caller reaching into the callee's layout. The rhythm is
 * named here now — `spacing="stacked"` for the `mb-1` a stacked field label
 * takes over its control, `spacing="stackedGap"` for the one field that also
 * opens a new group (#settings-openrouter-reasoning) — and a caller picks a
 * value instead of spelling a utility.
 *
 * `spacing` is NOT baked into the `default` VARIANT, and that is the whole
 * reason it is a second group rather than a wider `default`: six Labels are
 * ROW labels sitting beside their control (the five in
 * features/profile/profile-edit-sheet.tsx and #browse-sort-select's), and each
 * of them would gain a wrong 4px under the label. `none` stays the default.
 *
 * `spacing` is declared AFTER `variant` so the emitted string is
 * `block … dark:text-zinc-300 mb-1` — byte for byte what `cn(variants,
 * 'mb-1')` renders today, because cva emits groups in declaration order and
 * className lands last. Keep every class name a COMPLETE literal.
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
      inline: 'text-zinc-600 dark:text-zinc-300',
    },
    /**
     * The gap between a STACKED label and the control under it. A row label
     * beside its control takes `none`, which is the default — see the header
     * for why this is not folded into `variant`.
     */
    spacing: {
      none: '',
      // #settings-api-key, #settings-openrouter-key, #settings-openrouter-model,
      // #connector-url, #connector-name-spelling, #llm-consent-cap and
      // #auto-session-model.
      stacked: 'mb-1',
      // #settings-openrouter-reasoning, the one stacked label that also opens a
      // new group inside its section and so leads with its own 8px.
      stackedGap: 'mt-2 mb-1',
    },
  },
  defaultVariants: { variant: 'default', spacing: 'none' },
});

export interface LabelProps
  extends React.LabelHTMLAttributes<HTMLLabelElement>,
    VariantProps<typeof labelVariants> {}

const Label = React.forwardRef<HTMLLabelElement, LabelProps>(
  ({ className, variant, spacing, ...props }, ref) => (
    <label
      ref={ref}
      className={cn(labelVariants({ variant, spacing }), className)}
      {...props}
    />
  ),
);
Label.displayName = 'Label';

export { Label, labelVariants };
