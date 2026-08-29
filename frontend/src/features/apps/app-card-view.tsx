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

import { useState, type ReactNode } from 'react';

import { Glyph } from '@/components/ui/icons';

import { openmojiSrcFor } from '../../lib/openmoji';
import {
  appPillsFor,
  iconViewFor,
  CHIP_BASE_CLS,
  VIS_CHIP_CLS,
  VIS_CHIP_SHAPES,
} from './app-card.js';

type AppRecord = Record<string, any>;

/**
 * An emoji tile's glyph, upgraded to its vendored OpenMoji illustration when
 * the curated slice covers it (lib/openmoji.js) — the subtle-y2k treatment.
 * The text span is the fallback for anything outside the slice, styled by
 * `textClass` exactly as each surface drew it before. Every React tile
 * surface renders its emoji through this one component so the upgrade (and
 * its fallback rule) cannot drift between the launcher grid, the widget
 * strip, Discover, the landing grid and the shared AppIconContent; the
 * string renderer in ./app-card.js is the same pair of branches as HTML.
 */
export function EmojiTileGlyph({ emoji, textClass, imgClass = 'w-full h-full object-contain p-1' }: {
  emoji: string;
  textClass: string;
  imgClass?: string;
}): ReactNode {
  // A manifest hit is a promise the FILE resolves, not that this load will:
  // offline before the SW has the SVG cached, the <img> would otherwise
  // render as a blank tile (alt="" aria-hidden). onError falls back to the
  // same text glyph an uncovered emoji gets — a miss and a failure degrade
  // identically.
  const [failed, setFailed] = useState(false);
  const src = failed ? null : openmojiSrcFor(emoji);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        draggable="false"
        aria-hidden="true"
        className={imgClass}
        onError={() => setFailed(true)}
      />
    );
  }
  return <span className={textClass} aria-hidden="true">{emoji}</span>;
}

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
    return <EmojiTileGlyph emoji={icon.emoji} textClass="text-3xl leading-none" />;
  }
  return icon.letter;
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
export function AppPills({ app }: { app: AppRecord }): ReactNode {
  const { chips, vis } = appPillsFor(app) as {
    chips: Array<{ cls: string; label: string; tip: string }>;
    vis: { icon: 'lock' | 'mail'; label: string; tip: string } | null;
  };
  return (
    <>
      {chips.map((c) => (
        <span key={c.label} className={`${CHIP_BASE_CLS} ${c.cls}`} title={c.tip}>{c.label}</span>
      ))}
      {vis ? (
        <span className={VIS_CHIP_CLS} title={vis.tip}>
          {/* <Glyph>, not a named export: the two visibility glyphs live in
              app-card.js's VIS_CHIP_SHAPES because the string renderer there
              reads the same table, and one table beats two copies. */}
          <Glyph className="w-3 h-3 shrink-0" aria-hidden="true" shapes={VIS_CHIP_SHAPES[vis.icon]} />
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
