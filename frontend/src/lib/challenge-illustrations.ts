/**
 * Challenge illustrations: the allowlist a challenge template's
 * `illustration` slug is picked from, and the one place that turns a slug into
 * an image path and a tile tone.
 *
 * The files are the ITERATION 03 board's artworks, committed as static files
 * under `public/illustrations/challenges/<slug>.svg` and served like
 * `public/icons/`. They are NOT imported through the bundle: Vite's
 * `assetFileNames` collapses every emitted asset onto one name, and the test
 * renderer (tests/lib/render-tsx.js) has no loader for them.
 *
 * A slug is only ever resolved by MEMBERSHIP here, so a stored value that is
 * not in this table renders nothing rather than a guessed URL. The server
 * checks the slug's shape; this table decides whether it draws.
 *
 * The tone is a harmonic-palette name (`.home-tone-*` in public/css/app.css),
 * the same vocabulary the featured illustration editor offers. Those classes
 * only set `--tint-*` custom properties, so whatever draws the tile reads
 * `--tint-art`. The class strings are complete literals.
 */

export const ILLUSTRATION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

type ToneClass = 'home-tone-mint' | 'home-tone-blue' | 'home-tone-purple' | 'home-tone-orange';

interface IllustrationEntry {
  /** What the admin picker lists. */
  label: string;
  /** The tile's harmonic tone, as its complete class name. */
  toneClass: ToneClass;
}

export const ILLUSTRATIONS: Record<string, IllustrationEntry> = {
  'try-three-apps': { label: 'Try three apps', toneClass: 'home-tone-mint' },
  'make-a-proposal': { label: 'Make a proposal on an app', toneClass: 'home-tone-mint' },
  'block-production': { label: 'Take part in block production', toneClass: 'home-tone-mint' },
  'ten-minutes-in-apps': { label: 'Spend ten minutes a week in apps', toneClass: 'home-tone-blue' },
  'proposal-accepted': { label: 'Get a proposal accepted', toneClass: 'home-tone-purple' },
  'useful-feedback': { label: 'Send useful feedback', toneClass: 'home-tone-orange' },
  'network-participation': { label: 'Turn on network participation', toneClass: 'home-tone-orange' },
  'identity-level-one': { label: 'Prove who you are: level one', toneClass: 'home-tone-blue' },
  'identity-level-two': { label: 'Prove who you are: level two', toneClass: 'home-tone-orange' },
};

export interface ResolvedIllustration {
  slug: string;
  label: string;
  toneClass: ToneClass;
  /** Same-origin static path. Never built from anything but a member slug. */
  src: string;
}

/** The illustration for a stored slug, or null when it is not in the table. */
export function resolveIllustration(slug: unknown): ResolvedIllustration | null {
  if (typeof slug !== 'string' || !ILLUSTRATION_SLUG.test(slug)) return null;
  if (!Object.prototype.hasOwnProperty.call(ILLUSTRATIONS, slug)) return null;
  const entry = ILLUSTRATIONS[slug];
  return { slug, label: entry.label, toneClass: entry.toneClass, src: `/illustrations/challenges/${slug}.svg` };
}

/** The admin picker's options, in table order. */
export function illustrationOptions(): { value: string; label: string }[] {
  return Object.entries(ILLUSTRATIONS).map(([value, entry]) => ({ value, label: entry.label }));
}
