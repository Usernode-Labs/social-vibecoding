// An app's identity tint, as a pure function of its slug.
//
// This lives in lib/ rather than beside either of its two readers because it
// has two, in different worlds:
//
//   * @/components/ui/icon-tile.tsx, which turns a tint name into a Tailwind
//     class for the React surfaces (the launcher grid, the browse rows, the
//     detail hero);
//   * features/apps/app-card.js, which republishes it on `window.AppCard` for
//     the classic scripts — public/js/app-view.js needs it for the launch
//     cover and cannot `import`.
//
// One hash, one table, one answer to "what colour is this app". A second copy
// anywhere would show a different colour on some screen the day either moved.
//
// Framework-free and dependency-free on purpose: tests/helpers/app-card.js
// evaluates this as classic script text inside a vm sandbox, alongside
// app-card.js itself.

export const TILE_TINTS = ['lime', 'sky', 'amber', 'rose', 'lilac', 'sand'];

/**
 * Pick a stable tint for an app that has not chosen one. Same input → same
 * tint, so a launcher grid doesn't reshuffle its colours on every render.
 */
export function tintFor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TILE_TINTS[h % TILE_TINTS.length];
}
