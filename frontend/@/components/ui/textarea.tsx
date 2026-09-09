import * as React from 'react';
import type { VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

import { inputVariants } from './input';

/**
 * shadcn's Textarea — the same field box as Input, on a `<textarea>`.
 *
 * ── Why it re-uses inputVariants rather than declaring its own table ──
 *
 * The shell's two multi-line fields (#close-issue-reason, #feedback-text) are
 * written with EXACTLY the class strings their single-line neighbours use:
 * #close-issue-reason matches the dialogs' `dialog` box down to
 * `focus:border-transparent`, and #feedback-text matches the settings
 * screen's `default` box with `resize-none` appended. Giving this file its
 * own cva table would be two transcriptions of one recipe that must not be
 * allowed to drift, so it borrows Input's and only changes the element.
 *
 * `rows` is the one thing a textarea has that an input does not, and it stays
 * a plain attribute — the shell writes `rows={3}` / `rows={4}` inline and
 * there is no reason to promote a number to a variant.
 *
 * Same authoring rules as button.tsx: `cssVariables: false`, complete literal
 * class names, and nothing the shell does not already apply. Stock shadcn's
 * `min-h-[80px]` and `disabled:` utilities are deliberately absent — each
 * would be a visual change.
 */
export interface TextareaProps
  extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'width'>,
    VariantProps<typeof inputVariants> {}

// `{...props}` is spread BEFORE className, like Input: React serializes
// attributes in prop order, and the hand-written markup writes `id` and
// `rows` ahead of `class`.
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, lead, spacing, width, box, hint, mono, ring, text, ...props }, ref) => (
    <textarea
      ref={ref}
      {...props}
      className={cn(
        inputVariants({ lead, spacing, width, box, hint, mono, ring, text }),
        className,
      )}
    />
  ),
);
Textarea.displayName = 'Textarea';

export { Textarea };
