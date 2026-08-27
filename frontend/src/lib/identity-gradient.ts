/**
 * The brand's identity gradients — a stable "who" for people without avatars.
 *
 * BRAND KIT 2026 formalises four radial gradient recipes (its Colors board's
 * fourth row) and the marketing site uses them as the identity mark in every
 * activity chip ("+Lukas voted yes on change") and ownership card. This module
 * is those recipes verbatim, hashed per name the same way the group-chat
 * swatches were, so the same person is the same gradient in every row without
 * the server storing anything.
 *
 * Two decisions worth their comments:
 *
 * - FOUR recipes × FOUR origins = sixteen identities, not four. The kit draws
 *   every gradient from the top-left corner; rotating the origin between the
 *   four corners multiplies distinguishability without inventing a single
 *   colour the kit doesn't have. (The predecessor system had six flat
 *   swatches; sixteen is a strict upgrade in collision terms.)
 *
 * - The initial's ink is PER RECIPE, decided by measurement at the point the
 *   glyph actually occupies. With a 200% radius drawn from a corner, the
 *   square's CENTRE samples the gradient at ~35% (sqrt(2)/2 of an edge over
 *   two edges), not at the 50% stop — and at 35% the violet recipe reads
 *   #4364fc, where near-black is 4.18:1 (fails) and white is 4.70:1. The
 *   other three recipes are bright at their centres and carry near-black at
 *   9.8–12.5:1. So: white on the violet recipe, near-black on the rest —
 *   the brand's black-ink rule holds everywhere the fill is a brand-bright,
 *   and the one recipe that dips dark at its centre flips, measured rather
 *   than assumed.
 *
 * Identity is NOT the accent and NOT a state: these recipes must never be
 * used for buttons, badges, or status. That rule carries over from the
 * swatch system this replaces.
 */

const RECIPES: { stops: string; ink: string }[] = [
  // violet → cyan. The one recipe whose centre dips dark — white ink (4.70:1
  // at the centre sample; near-black measures 4.18 there).
  {
    stops: '#6717fb 0%, #5a32fb 12.5%, #4e4dfc 25%, #3484fc 50%, #1bbafd 75%, #0fd5fd 87.5%, #02f0fd 100%',
    ink: '#ffffff',
  },
  // green → lime (near-black at 9.8:1)
  { stops: '#41b24a 0%, #66c459 25%, #8bd669 50%, #b0e878 75%, #d6fa87 100%', ink: '#0c0b09' },
  // pink → orange (near-black at 5.8:1)
  {
    stops: '#fb179d 0%, #fc3776 25%, #fc5750 50%, #fd7629 75%, #fd8615 87.5%, #fd9602 100%',
    ink: '#0c0b09',
  },
  // amber → yellow — terminates at the brand yellow #ffee6f (near-black 12.5:1)
  { stops: '#ffae2b 0%, #ffce4d 50%, #ffee6f 100%', ink: '#0c0b09' },
];

const ORIGINS = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];

function hash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
}

/** CSS background-image for a name's identity gradient. */
export function identityGradient(name: string): string {
  const h = hash(name);
  const recipe = RECIPES[h % RECIPES.length];
  const at = ORIGINS[(h >>> 2) % ORIGINS.length];
  // 200% radius: the kit's gradients span roughly twice the square's edge,
  // so the far corner still carries colour instead of clipping to the last
  // stop early.
  return `radial-gradient(200% 200% at ${at}, ${recipe.stops})`;
}

/**
 * Convenience for React consumers: the pair of inline styles an identity
 * surface needs. Spread it onto the element that used to take a
 * backgroundColor.
 */
export function identityStyle(name: string): { backgroundImage: string; color: string } {
  const h = hash(name);
  const recipe = RECIPES[h % RECIPES.length];
  const at = ORIGINS[(h >>> 2) % ORIGINS.length];
  return {
    backgroundImage: `radial-gradient(200% 200% at ${at}, ${recipe.stops})`,
    color: recipe.ink,
  };
}
