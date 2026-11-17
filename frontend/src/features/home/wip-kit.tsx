/**
 * Standard (WIP)'s kit: the few components Home draws only under that look
 * (lib/skin.ts 'wip').
 *
 * Each is a class from app.css's "STANDARD (WIP)" block, which reads every
 * colour, radius, size and gap from that block's tokens (`--wip-*`), and
 * those from the shell's own (`--dc-sheet-solid`, `--app-sheet-line`,
 * `--accent`, `--text-muted`). A piece of Home that needs a card, the page's
 * filled action or a heading's link under this look takes it from here
 * instead of spelling the classes again, so the look changes in one place.
 */
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

import { PlusWideIcon } from '@/components/ui/icons';

/** The look's card: the plane colour, the card radius, one inset hairline. */
export const WIP_CARD = 'wip-card';

/** A card. `on` false draws the bare box, for a caller mounted under every look. */
export function WipCard({ on = true, className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { on?: boolean }) {
  const cls = [on ? WIP_CARD : '', className || ''].filter(Boolean).join(' ');
  return <div className={cls || undefined} {...rest}>{children}</div>;
}

/** A filled action: the accent gradient pill and its words, after a plus unless `glyph` is false. */
export function WipCta({ children, glyph = true, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode; glyph?: boolean }) {
  return (
    <button type="button" className="wip-cta" {...rest}>
      {glyph ? <PlusWideIcon className="wip-cta-glyph" strokeWidth="2.6" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

/** A link riding a section's heading (Edit, See all): 14px semibold in the accent. */
export const WIP_HEAD_LINK = 'wip-head-link un-touch-target';
