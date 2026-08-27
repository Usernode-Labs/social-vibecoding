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

import type { ReactNode } from 'react';

import { Glyph } from '@/components/ui/icons';

import { openmojiUrl } from '../../lib/openmoji';

import {
  appPillsFor,
  iconViewFor,
  CHIP_BASE_CLS,
  VIS_CHIP_CLS,
  VIS_CHIP_PATHS,
} from './app-card.js';

type AppRecord = Record<string, any>;

/**
 * The emoji identity mark — OpenMoji where vendored, the plain character where
 * not. ONE definition, because it was two: the launcher grid kept its own copy
 * of this branch, so the platform-font drift this fixes would have survived on
 * the single most-looked-at surface in the product.
 *
 * `size` is the text-size class the fallback `<span>` uses; the <img> sizes
 * itself to the tile at 88% (see the note below), so callers pass the class
 * they already had.
 */
export function EmojiMark({ emoji, size = 'text-3xl' }: { emoji: string; size?: string }): ReactNode {
  // 88% (not 100%) because OpenMoji's artboard has less internal padding than
  // a system emoji's em-box: at full bleed the artwork touches the tile's
  // hairline, where the text glyph it replaces sat visually inset.
  //
  // The <span> is NOT a degraded path — it is exactly what this rendered
  // before, so an unvendored pick is the status quo rather than a broken
  // image. See lib/openmoji.ts.
  const src = openmojiUrl(emoji);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        draggable="false"
        className="w-[88%] h-[88%] object-contain"
      />
    );
  }
  return <span className={`${size} leading-none`} aria-hidden="true">{emoji}</span>;
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
        className="w-full h-full rounded-md object-cover"
      />
    );
  }
  if (icon.kind === 'emoji') {
    return <EmojiMark emoji={icon.emoji} />;
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
