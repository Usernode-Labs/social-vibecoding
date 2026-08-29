'use strict';

import { Fragment } from 'react';
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

import { BTN, BTN_BASE, BTN_SM, FIELD_CLS, PANEL_CLS, TEXTAREA_CLS } from './tokens.ts';

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

// The console's dismiss control. The one place in the programme console that
// inlines SVG path data, and it is a PORT: the same path AdminTopochain._panel()
// has always written into its header, kept byte-identical so a converted screen
// and an unconverted one show the same ✕ while the conversion runs. Importing
// from @/components/ui/icons.tsx is not the alternative — AGENTS.md's density
// boundary forbids an admin source from reaching into the shell's primitives.
// tests/shell-icon-set.test.js exempts this file alone, and says so.
export function CloseButton(
  { id, label, onClick }: { id?: string; label: string; onClick: () => void },
) {
  return (
    <button
      id={id}
      type="button"
      className={BTN.close}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
      </svg>
    </button>
  );
}

// The console's "back to the list" control, for a nested screen. The second
// and last glyph this file inlines — same reasoning as CloseButton above: a
// port kept in ONE place so no screen re-inlines it and lets the two drift.
export function BackButton({ id, children, onClick }: {
  id?: string;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button id={id} type="button" className={`${BTN.back} mb-2`} onClick={onClick}>
      <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z" clipRule="evenodd" />
      </svg>
      {children}
    </button>
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
        {onClose ? <CloseButton label={label} onClick={onClose} /> : null}
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

// Loading placeholder shaped like the rows it is standing in for, so the
// layout doesn't jump when the data lands. Mirrors AdminTopochain._skeleton.
export function Skeleton({ rows }: { rows?: number }) {
  const n = Math.max(1, Math.min(rows == null ? 4 : rows, 10));
  const widths = ['w-3/4', 'w-full', 'w-5/6', 'w-2/3'];
  return (
    <>
      <div className="animate-pulse space-y-2 py-2" aria-hidden="true">
        {Array.from({ length: n }, (_, i) => (
          <div key={i} className={`h-4 ${widths[i % 4]} rounded bg-zinc-200 dark:bg-zinc-800`} />
        ))}
      </div>
      <p className="sr-only" role="status">Loading…</p>
    </>
  );
}

// "Nothing here yet" — a title, an optional explanation, and an optional call
// to action. Mirrors AdminTopochain._empty. The action is the caller's to omit
// for a view-only admin, exactly as the string helper made it: an empty state
// whose only affordance 403s is worse than no affordance.
export function EmptyState(
  { title, body, action }: { title?: string; body?: ReactNode; action?: ReactNode },
) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 px-4 py-10 text-center">
      <p className="text-sm font-medium text-zinc-600 dark:text-zinc-300">
        {title || 'Nothing here yet'}
      </p>
      {body ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{body}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

// "The request failed" — visually distinct from empty (red, not dashed-grey)
// and always retryable. Mirrors AdminTopochain._error; a status of 0 means the
// request never got an answer at all (offline / server down), which is worth
// saying. `onRetry` stands in for its `retryId` + _wireRetry pair.
export function ErrorState({
  title, status, message, onRetry,
}: {
  title?: string;
  status?: number;
  message?: string | null;
  onRetry?: () => void;
}) {
  const detail = status === 0
    ? "Couldn't reach the server."
    : (message || `Request failed${status ? ` (HTTP ${status})` : ''}.`);
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 px-4 py-8 text-center">
      <p className="text-sm font-medium text-red-700 dark:text-red-300">
        {title || "Couldn't load this"}
      </p>
      <p className="mt-1 text-xs text-red-700 dark:text-red-400">{detail}</p>
      {onRetry ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={onRetry}
            className={`${BTN_BASE} ${BTN_SM} border border-red-300 dark:border-red-800 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/60`}
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ── The shared responsive list ─────────────────────────────────────────
//
// ONE column definition renders BOTH layouts: a real <table> at md+ (where
// there is room for it) and a stack of cards below, where a table could only
// ever be scrolled sideways one column at a time. Mirrors AdminTopochain._list.
//
// The one thing that changes in React: the string version had to put every
// data-* hook in the DOM TWICE and wire handlers with querySelectorAll,
// because both layouts are always present with one hidden by a breakpoint.
// A cell is a React node here, so a button in it carries its own handler and
// exists twice with no wiring to keep in step.

export type Column<T> = {
  label: string;
  cell: (item: T) => ReactNode;
  /** Titles the card. Falls back to the first column. */
  primary?: boolean;
  hideOnCard?: boolean;
  thClass?: string;
  tdClass?: string;
};

export function List<T>({
  items, columns, rowKey, actions, extra, rowClass,
}: {
  items: T[];
  columns: Column<T>[];
  /** Stable identity for the row — React's key in both layouts. */
  rowKey: (item: T, index: number) => string | number;
  actions?: (item: T) => ReactNode;
  extra?: (item: T) => ReactNode;
  rowClass?: (item: T) => string;
}) {
  const act = actions || (() => null);
  const ex = extra || (() => null);
  const cls = rowClass || (() => '');
  const anyActions = items.some((it) => !!act(it));
  const span = columns.length + (anyActions ? 1 : 0);
  const primary = columns.find((c) => c.primary) || columns[0];

  return (
    <>
      <div className="hidden md:block overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            <tr>
              {columns.map((c) => (
                <th key={c.label} className={`px-3 py-2 text-left font-medium ${c.thClass || ''}`}>
                  {c.label}
                </th>
              ))}
              {anyActions ? <th className="px-3 py-2 text-right font-medium">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const key = rowKey(it, i);
              const below = ex(it);
              return (
                <Fragment key={key}>
                  <tr className={`border-t border-zinc-100 dark:border-zinc-800 ${cls(it)}`}>
                    {columns.map((c) => (
                      <td key={c.label} className={`px-3 py-2 ${c.tdClass || ''}`}>{c.cell(it)}</td>
                    ))}
                    {anyActions ? (
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">{act(it)}</div>
                      </td>
                    ) : null}
                  </tr>
                  {below ? (
                    <tr className="border-t border-zinc-100 dark:border-zinc-800">
                      <td colSpan={span} className="px-3 py-3">{below}</td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="md:hidden space-y-2">
        {items.map((it, i) => {
          const rowActions = act(it);
          const below = ex(it);
          return (
            <div key={rowKey(it, i)} className={`${PANEL_CLS} px-4 py-3 ${cls(it)}`}>
              <p className="text-sm font-medium break-words">{primary ? primary.cell(it) : null}</p>
              <dl className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">
                {columns.filter((c) => c !== primary && !c.hideOnCard).map((c) => (
                  <div key={c.label} className="flex items-start justify-between gap-3 py-1">
                    <dt className="shrink-0 text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      {c.label}
                    </dt>
                    <dd className="min-w-0 text-right text-sm break-words">{c.cell(it)}</dd>
                  </div>
                ))}
              </dl>
              {rowActions ? (
                <div className="mt-2 flex flex-wrap gap-1 border-t border-zinc-100 dark:border-zinc-800 pt-2">
                  {rowActions}
                </div>
              ) : null}
              {below ? <div className="mt-2">{below}</div> : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

// Page N of M · T total, with Prev/Next. Mirrors AdminTopochain._pagerHtml +
// _wirePager, whose split existed only because the markup had to be built
// before its buttons could be found again.
export type PageMeta = { page: number; total_pages: number; total: number };

export function Pager({ meta, onPage }: { meta: PageMeta | null; onPage: (page: number) => void }) {
  if (!meta) return null;
  return (
    <div className="mt-4 flex flex-col gap-2 text-xs text-zinc-500 dark:text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
      <span>{`Page ${meta.page} of ${Math.max(meta.total_pages, 1)} · ${meta.total} total`}</span>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN.row}
          disabled={meta.page <= 1}
          onClick={() => { if (meta.page > 1) onPage(meta.page - 1); }}
        >
          Prev
        </button>
        <button
          type="button"
          className={BTN.row}
          disabled={meta.page >= meta.total_pages}
          onClick={() => { if (meta.page < meta.total_pages) onPage(meta.page + 1); }}
        >
          Next
        </button>
      </div>
    </div>
  );
}

// ── Form chrome ────────────────────────────────────────────────────────

// One labelled field. Mirrors AdminTopochain._field. `htmlFor` replaces the
// wrapping <label> the string helper used: it could not know the control's
// id, so it wrapped; a component is handed one.
export function Field({
  label, htmlFor, help, className, children,
}: {
  label: ReactNode;
  htmlFor?: string;
  help?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`block text-xs${className ? ` ${className}` : ''}`}>
      <label className="font-medium text-zinc-600 dark:text-zinc-400" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {help ? (
        <span className="block mt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{help}</span>
      ) : null}
    </div>
  );
}

// The field grid every form uses: one full-width column on a phone, two from
// md: up. `cols={3}` opts into a third at lg: for the short numeric forms.
// Fields that need the full width carry `md:col-span-2` themselves.
export function FormGrid({ cols, children }: { cols?: 2 | 3; children: ReactNode }) {
  const wide = cols === 3
    ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
    : 'grid-cols-1 md:grid-cols-2';
  return <div className={`grid gap-4 ${wide}`}>{children}</div>;
}

// Inline validation / submit-failure slot for a form panel. Renders nothing
// until there is something to say — the string version rendered an empty
// paragraph and toggled `hidden`, which is the same thing seen from the other
// side.
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p
      className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/40 px-3 py-2 text-xs text-red-700 dark:text-red-400"
      role="alert"
    >
      {message}
    </p>
  );
}

// Save / Cancel pair for a Panel footer, in that visual order with the primary
// first so it is under the thumb on a phone. Mirrors _formActions.
export function FormActions(
  { onSave, onCancel, saveLabel }: { onSave: () => void; onCancel: () => void; saveLabel?: string },
) {
  return (
    <>
      <button type="button" className={BTN.primary} onClick={onSave}>{saveLabel || 'Save'}</button>
      <button type="button" className={BTN.secondary} onClick={onCancel}>Cancel</button>
    </>
  );
}

// Formats an ISO timestamp for a table cell. Mirrors AdminTopochain._fmt.
export function fmt(iso?: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// A checkbox reads as a control plus its label, not as a label with a control
// under it, so it gets its own row shape with a tap target that covers the
// text as well as the box. Mirrors AdminTopochain._checkField.
export function CheckField({
  id, label, help, checked, onChange,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2.5 min-h-[44px] sm:min-h-[36px] py-2 cursor-pointer">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 dark:border-zinc-600 text-violet-700 focus:ring-2 focus:ring-violet-500 dark:text-violet-400"
      />
      <span className="text-xs">
        <span className="font-medium text-zinc-600 dark:text-zinc-400">{label}</span>
        {help ? (
          <span className="block mt-0.5 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{help}</span>
        ) : null}
      </span>
    </label>
  );
}

// A small status pill. Mirrors AdminTopochain._badgeHtml; the tone table is
// the same four, and an unknown tone falls back to zinc rather than
// disappearing.
const BADGE_TONES: Record<string, string> = {
  green: 'bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-400',
  amber: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-400',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
  zinc: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
};

export function Badge({ label, tone }: { label: ReactNode; tone?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone || 'zinc'] || BADGE_TONES.zinc}`}>
      {label}
    </span>
  );
}

// A labelled rule between groups of fields inside one panel. The long forms
// are otherwise a wall of inputs in which "which of these is the CTA?" has to
// be answered by reading every label. Mirrors AdminTopochain._formSection.
export function FormSection({ label }: { label: ReactNode }) {
  return (
    <p className="mt-5 mb-3 border-t border-zinc-200 dark:border-zinc-800 pt-4 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
      {label}
    </p>
  );
}

// A <select>'s options from a {value,label} list, with an optional leading
// blank. Mirrors the `blank` option of AdminTopochain._selectHtml.
export function Options(
  { options, blank }: { options: { value: string | number; label: string }[]; blank?: string },
) {
  return (
    <>
      {blank ? <option value="">{blank}</option> : null}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </>
  );
}

// ISO ↔ `datetime-local` input value. Mirrors AdminTopochain._isoToLocalInput
// and _localInputToIso: the control speaks the viewer's LOCAL wall clock and
// the API speaks UTC ISO, so both directions go through the Date constructor
// rather than string surgery.
export function isoToLocalInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
