import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The platform's toggle switch: an `<input type="checkbox">` wearing the
 * `un-switch` class, which public/css/app.css restyles into a track and knob.
 *
 * ── Why this is NOT @radix-ui/react-switch ─────────────────────────────
 *
 * Stock shadcn's Switch renders a `<button role="switch">` with a span thumb
 * and holds its state in React. Every switch on this screen is read and
 * written by settings.js through `.checked` on the element it finds by id
 * (#devchat-alerts-toggle, #dev-console-always-show, #ai-progress-estimate,
 * #view-as-non-admin) or by `[data-mobile-push-category] input`, and the
 * `un-switch` styling is a stylesheet the whole app already ships. Swapping
 * the element would break both at once and restyle four controls, which is
 * three more visual changes than chunk D is allowed to make.
 *
 * So the primitive is what the shell already writes — the class string, in one
 * place, instead of five copies — and the state stays where it is.
 *
 * SwitchRow is the enclosing `<label>` those four switches share: a full-width
 * click target with the switch first and its caption after. The mobile-push
 * rows in the alerts section are a DIFFERENT shape (caption block first,
 * switch right-aligned and top-aligned) and stay written out where they are.
 */

export type SwitchProps = React.InputHTMLAttributes<HTMLInputElement>;

const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, ...props }, ref) => (
    <input ref={ref} {...props} type="checkbox" className={cn('un-switch', className)} />
  ),
);
Switch.displayName = 'Switch';

export interface SwitchRowProps {
  /** The switch's id — settings.js binds every one of them by id. */
  id: string;
  children: React.ReactNode;
}

function SwitchRow({ id, children }: SwitchRowProps) {
  return (
    <label className="flex items-center gap-2 cursor-pointer select-none">
      <Switch id={id} />
      <span className="text-sm text-zinc-800 dark:text-zinc-200">
        {children}
      </span>
    </label>
  );
}

export { Switch, SwitchRow };
