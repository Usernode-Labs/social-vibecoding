/**
 * The React half of the shared app-card primitives (#1191 slice 6, conv. 3).
 *
 * ./app-card.js decides WHAT an app record earns — which of image / emoji /
 * letter its tile draws, and which activity and visibility chips it carries.
 * That file keeps emitting the HTML strings the launcher grid and the app view
 * still splice in; this one renders the same two decisions as elements, for the
 * surfaces that are React now.
 *
 * Both renderers read the same descriptor functions, so a chip added in one
 * place appears in all four app surfaces and neither renderer can drift.
 *
 * The tile BOX stays each caller's own — a launcher tile is w-14, a browse row
 * w-11, the detail hero w-16 — so these components render the tile's CONTENTS
 * and the chip run, never the wrapper.
 */

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

import { Glyph } from '@/components/ui/icons';

import {
  appPillsFor,
  iconViewFor,
  CHIP_BASE_CLS,
  VIS_CHIP_CLS,
  VIS_CHIP_PATHS,
} from './app-card.js';

type AppRecord = Record<string, any>;

/**
 * The tile's inner markup. Carries no sizing of its own except the emoji's
 * `text-3xl` — the launcher tile's size, which the two browse surfaces
 * override on the wrapper, exactly as the string version documents.
 */
export function AppIconContent({ app }: { app: AppRecord }): ReactNode {
  const icon = iconViewFor(app) as
    { kind: 'image'; src: string } | { kind: 'emoji'; emoji: string } | { kind: 'letter'; letter: string };
  if (icon.kind === 'image') {
    // w-full/h-full (not w-14/h-14): the tile draws a 1px hairline border, so
    // the image fills the border box's content area and stays flush inside the
    // ring instead of being cropped.
    return (
      <img
        src={icon.src}
        alt=""
        loading="lazy"
        draggable="false"
        className="w-full h-full rounded-xl object-cover"
      />
    );
  }
  if (icon.kind === 'emoji') {
    return <span className="text-3xl leading-none" aria-hidden="true">{icon.emoji}</span>;
  }
  return icon.letter;
}

/** Where an app's icon goes: the app itself, the path its Open link uses. */
export function appOpenHref(slug: string): string {
  return `/app/${encodeURIComponent(slug)}`;
}

function openApp(event: MouseEvent | KeyboardEvent, slug: string, onOpen?: (slug: string) => void): void {
  // The icon may sit inside a card or row with its own destination: the tap
  // is the icon's, never also the card's.
  event.stopPropagation();
  const win = window as unknown as {
    NavLink?: { isNativeClick?: (e: unknown) => boolean };
    App?: { openAppTab?: (slug: string, tab: string) => void };
  };
  if (event.type === 'click' && event.currentTarget instanceof HTMLAnchorElement
      && win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  if (onOpen) onOpen(slug);
  else if (win.App?.openAppTab) win.App.openAppTab(slug, 'app');
  else window.location.assign(appOpenHref(slug));
}

/**
 * An app's icon tile that opens the app (#3365). It keeps the caller's tile
 * box exactly: `className` and `data-icon` are the ones the caller drew
 * before, and this only adds the link, the pointer and the label.
 *
 * `nested` is for a tile inside something that is already a link or button
 * going elsewhere (an inbox row, a Workshop row). An anchor inside an anchor
 * is invalid markup, so there the tile is a focusable `role="link"` span,
 * and either way the click stops at the tile. With no slug the tile renders
 * as the plain box it was.
 */
export function AppIconLink({
  slug, name, nested = false, onOpen, className, children, id, 'data-icon': dataIcon,
}: {
  slug: string | null | undefined;
  name: string | null | undefined;
  nested?: boolean;
  /** Replaces the default open, for a surface that must close first. */
  onOpen?: (slug: string) => void;
  className?: string;
  children: ReactNode;
  id?: string;
  'data-icon'?: string;
}): ReactNode {
  if (!slug) {
    return <span id={id} data-icon={dataIcon} className={className} aria-hidden="true">{children}</span>;
  }
  const label = `Open ${name || slug}`;
  const cls = `${className || ''} app-icon-link cursor-pointer`;
  if (nested) {
    return (
      <span
        id={id}
        role="link"
        tabIndex={0}
        aria-label={label}
        title={label}
        data-icon={dataIcon}
        data-app-icon-link={slug}
        className={cls}
        onClick={(event) => openApp(event, slug, onOpen)}
        onKeyDown={(event) => { if (event.key === 'Enter') openApp(event, slug, onOpen); }}
      >
        {children}
      </span>
    );
  }
  return (
    <a
      id={id}
      href={appOpenHref(slug)}
      aria-label={label}
      title={label}
      data-icon={dataIcon}
      data-app-icon-link={slug}
      className={cls}
      onClick={(event) => openApp(event, slug, onOpen)}
    >
      {children}
    </a>
  );
}

/** The `data-icon` kind that goes on the tile box, for app.css and the tests. */
export function appIconKind(app: AppRecord): string {
  return iconViewFor(app).kind;
}

/**
 * The activity + visibility chip run. Renders nothing for a quiet, fully
 * public app — callers check `hasAppPills` before drawing the wrapper, because
 * the wrapper's `mt-1` / `mt-2` is a gap nobody wants on an empty run.
 */
export function AppPills({ app, limit }: {
  app: AppRecord;
  /**
   * At most this many pills, taken in appPillsFor's order (what needs
   * attention first) with the visibility chip last. Unset: every pill.
   */
  limit?: number;
}): ReactNode {
  const all = appPillsFor(app) as {
    chips: Array<{ cls: string; label: string; tip: string }>;
    vis: { icon: 'lock' | 'mail'; label: string; tip: string } | null;
  };
  const max = limit == null ? Infinity : Math.max(0, limit);
  const chips = all.chips.slice(0, max);
  const vis = chips.length < max ? all.vis : null;
  return (
    <>
      {chips.map((c) => (
        <span key={c.label} className={`${CHIP_BASE_CLS} ${c.cls}`} title={c.tip}>{c.label}</span>
      ))}
      {vis ? (
        <span className={VIS_CHIP_CLS} title={vis.tip}>
          {/* <Glyph>, not a named export: the two visibility paths live in
              app-card.js's VIS_CHIP_PATHS because the string renderer there
              interpolates the same table, and one table beats two copies. */}
          <Glyph className="w-3 h-3 shrink-0" aria-hidden="true" d={VIS_CHIP_PATHS[vis.icon]} />
          {` ${vis.label}`}
        </span>
      ) : null}
    </>
  );
}

export function hasAppPills(app: AppRecord): boolean {
  const { chips, vis } = appPillsFor(app) as { chips: unknown[]; vis: unknown };
  return chips.length > 0 || !!vis;
}
