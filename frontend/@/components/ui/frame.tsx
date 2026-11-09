/**
 * The one frame (docs/superpowers/specs/2026-11-08-one-frame-glass-spec.md,
 * rules 1, 3 and 4): every page is a title, one sentence saying what it is
 * for, at most one primary action, then a stack of labelled groups in a
 * 720px column with context in a 320px column beside it, which moves above
 * or below on a phone.
 *
 *   PageFrame   the header and the columns.
 *   Columns     720 / 320 from md; one column before, the side after the
 *               main (or before it with `sideFirst`).
 *   Group       a label over one surface: under glass a frosted pane with a
 *               ring and a glow, under the standard look the plane colour
 *               with its hairline (the tokens decide, see app.css "SKIN
 *               TOKEN DEFAULTS").
 *   PrimaryButton / QuietButton  the two buttons a page may carry.
 *
 * The frame has nine looks (lib/skin.ts FRAME_SKINS). The classes here are
 * the kit's NEUTRAL geometry and read colours from the --fr-* tokens only;
 * what a look draws differently it says in app.css ("THE FRAME'S LOOKS"),
 * as tokens or as a rule on one of the hooks every element here carries:
 * fr-page, fr-title, fr-purpose, fr-cols, fr-main, fr-side, fr-group,
 * fr-label, fr-card, fr-btn, fr-btn-quiet (and status.tsx's fr-row,
 * fr-row-sm, fr-row-tx, fr-row-t, fr-row-s, fr-pill). A look's rule is
 * html[data-skin="…"] .fr-x, which outranks any utility here, so never
 * add a look's value as a class.
 *
 * Spacing is logical (ps-/pe-/ms-/me-, start/end), so the frame mirrors in
 * a right-to-left language without a second set of rules. Every class is a
 * complete literal (Tailwind's extractor).
 */
import * as React from 'react';

import { cn } from '@/lib/utils';
import { SectionHeader } from './grouped-list';

const BUTTON = 'fr-btn inline-flex h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full px-5 text-[15px] font-[650] leading-none transition-[transform,opacity] active:scale-[0.98] disabled:opacity-50';

export function PrimaryButton({ className, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(BUTTON, 'bg-[color:var(--fr-acc)] text-[color:var(--fr-acc-ink)]', className)}
      {...props}
    />
  );
}

export function QuietButton({ className, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(BUTTON, 'fr-btn-quiet bg-[color:var(--fr-sunk)] text-[color:var(--fr-ink)]', className)}
      {...props}
    />
  );
}

export function Columns({ main, side, sideFirst = false, className }: {
  main: React.ReactNode;
  side?: React.ReactNode;
  sideFirst?: boolean;
  className?: string;
}) {
  if (!side) {
    return <div className={cn('fr-main w-full min-w-0 max-w-[720px]', className)}>{main}</div>;
  }
  return (
    <div className={cn('fr-cols grid grid-cols-1 gap-6 md:grid-cols-[minmax(0,720px)_320px]', className)}>
      <div className="fr-main min-w-0">{main}</div>
      <aside className={cn('fr-side min-w-0', sideFirst && 'order-first md:order-none')}>{side}</aside>
    </div>
  );
}

export function Group({ label, action, children, id, className }: {
  label: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={cn('fr-group flex flex-col', className)}>
      <div className="flex items-baseline justify-between gap-4 pe-4">
        {/* The group's label, over the card-group label's own gutter: the
            kit's small caps in the muted ink; most looks set it in sentence
            case at their own size (spec rule 8). The dark: class outranks
            SectionHeader's own dark ink. */}
        <SectionHeader className="fr-label text-[color:var(--fr-mut)] dark:text-[color:var(--fr-mut)]">
          {label}
        </SectionHeader>
        {action ? <div className="shrink-0 pt-6 text-[13px] font-semibold text-[color:var(--fr-acc)]">{action}</div> : null}
      </div>
      <div className="fr-card overflow-hidden rounded-[20px] bg-[color:var(--fr-surface)] [backdrop-filter:var(--fr-blur)] [box-shadow:inset_0_0_0_1px_var(--fr-ring),var(--fr-glow)]">
        {children}
      </div>
    </section>
  );
}

export function PageFrame({ title, purpose, primary, tabs, children, side, sideFirst, className }: {
  title: React.ReactNode;
  purpose?: React.ReactNode;
  /** A string becomes the page's one PrimaryButton; an element is used as given. */
  primary?: React.ReactNode;
  tabs?: React.ReactNode;
  children: React.ReactNode;
  side?: React.ReactNode;
  sideFirst?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('fr-page flex flex-col gap-6 px-3 pb-12 pt-5 md:px-8', className)}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="fr-title text-[24px] md:text-[28px] font-bold tracking-[-0.02em] leading-[1.15] text-[color:var(--fr-ink)] [text-wrap:balance]">{title}</h1>
          {purpose ? <p className="fr-purpose mt-2 max-w-[60ch] text-[15px] leading-snug text-[color:var(--fr-mut)]">{purpose}</p> : null}
        </div>
        {primary ? (
          <div className="shrink-0">
            {typeof primary === 'string' ? <PrimaryButton>{primary}</PrimaryButton> : primary}
          </div>
        ) : null}
      </header>
      {tabs}
      <Columns main={children} side={side} sideFirst={sideFirst} />
    </div>
  );
}
