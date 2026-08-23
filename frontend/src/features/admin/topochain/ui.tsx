'use strict';

import type {
  InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes,
} from 'react';

// React chrome for the programme console's screens (#1120 slice 24).
//
// These are the components the innerHTML screens in admin-topochain.js build
// with _screenHeader(), _panel(), _field() and friends, rendering the SAME
// markup from the SAME class strings (./tokens.ts). They exist so a converted
// screen and an unconverted one look identical while the conversion runs, and
// so converting the next screen is a renderer swap rather than a restyle.
//
// The helpers they mirror take `already-escaped html` strings; these take
// children, which is the one real difference — React escapes text children, so
// the escaping half of each helper simply has no counterpart here. The
// module's esc() survives only inside admin-topochain.js, for the screens that
// still build strings.
//
// AGENTS.md's density boundary applies unchanged: nothing here may import from
// `@/components/ui/**`. The console has its own vocabulary and its own tap
// targets, and tests/admin-ui-registry.test.js holds the line.

import { BTN, FIELD_CLS, PANEL_CLS, TEXTAREA_CLS } from './tokens.ts';

// The heading strip at the top of a screen: title on the left, toolbar on the
// right. Stacks below sm: so a long title and three buttons don't fight over
// one line on a phone. Mirrors AdminTopochain._screenHeader.
export function ScreenHeader(
  { title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode },
) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div>
      ) : null}
    </div>
  );
}

// Every create, edit, import, detail and console surface renders through this,
// so they all get the same border, padding, header treatment and dismiss
// control. The header is `sticky top-0` inside the panel: on a long form the
// title and the ✕ stay put while the fields scroll past, so "how do I get out
// of this" is always answerable without scrolling back up. Mirrors
// AdminTopochain._panel — `onClose` stands in for its `closeId`, since a React
// screen wires the handler here instead of looking the button up afterwards.
export function Panel({
  title, subtitle, children, footer, tone, className, onClose, closeLabel,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  tone?: 'danger';
  className?: string;
  onClose?: () => void;
  closeLabel?: string;
}) {
  const headTone = tone === 'danger'
    ? 'bg-red-50/90 dark:bg-red-950/40 border-red-200 dark:border-red-900'
    : 'bg-white/90 dark:bg-zinc-900/90 border-zinc-200 dark:border-zinc-800';
  const label = closeLabel || 'Close';
  return (
    <section className={`${PANEL_CLS} overflow-hidden mb-4 ${className || ''}`}>
      <header className={`sticky top-0 z-10 flex items-start justify-between gap-3 border-b px-4 py-3 sm:px-5 backdrop-blur ${headTone}`}>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate">{title}</h3>
          {subtitle ? (
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>
          ) : null}
        </div>
        {onClose ? (
          <button type="button" className={BTN.close} aria-label={label} title={label} onClick={onClose}>
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        ) : null}
      </header>
      <div className="px-4 py-4 sm:px-5">{children}</div>
      {footer ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 sm:px-5">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

// The three field controls, so a screen never hand-writes FIELD_CLS. Each
// takes the rest of its props straight through, which is how a screen adds
// `font-mono`, `placeholder`, `rows` or a `disabled` without a prop per case.
type InputProps = InputHTMLAttributes<HTMLInputElement> & { className?: string };
export function Input({ className, ...rest }: InputProps) {
  return <input className={className ? `${FIELD_CLS} ${className}` : FIELD_CLS} {...rest} />;
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { className?: string };
export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={className ? `${FIELD_CLS} ${className}` : FIELD_CLS} {...rest}>
      {children}
    </select>
  );
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { className?: string };
export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={className ? `${TEXTAREA_CLS} ${className}` : TEXTAREA_CLS} {...rest} />;
}
