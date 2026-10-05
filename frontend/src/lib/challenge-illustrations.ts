import { t as tr } from "./i18n/runtime";
/**
 * Challenge illustrations: the one place that turns a template's
 * `illustration` slug into an image path and a tile tone.
 *
 * Two kinds of slug, and nothing else ever draws:
 *
 *   BUILT-IN  the ITERATION 03 board's artworks, committed as static files
 *             under `public/illustrations/challenges/<slug>.svg`, listed in
 *             ILLUSTRATIONS below with their label and tone. They are NOT
 *             imported through the bundle: Vite's `assetFileNames` collapses
 *             every emitted asset onto one name, and the test renderer
 *             (tests/lib/render-tsx.js) has no loader for them.
 *   UPLOADED  art an admin added in the template form's gallery, stored by
 *             the server and served at `/challenge-illustrations/<id>`. Its
 *             slug is `u-` plus that 32-hex id, so the path is DERIVED from a
 *             slug that passed UPLOADED_SLUG, never taken from a payload. Its
 *             tone travels in the payload beside the slug and is only honoured
 *             when it is one of TONES.
 *
 * A slug that is neither renders nothing rather than a guessed URL. The server
 * checks the slug's shape; this file decides whether it draws.
 *
 * The tone is a harmonic-palette name (`.home-tone-*` in public/css/app.css),
 * the vocabulary the featured illustration editor offers. Those classes only
 * set `--tint-*` custom properties, so whatever draws the tile reads
 * `--tint-art`. The class strings are complete literals, and TONES must stay
 * in step with features/home/panels/ui.tsx and the server's list (a test pins
 * all three).
 */

export const ILLUSTRATION_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const UPLOADED_SLUG = /^u-([a-f0-9]{32})$/;

export const TONES = [
  'cream', 'yellow', 'orange', 'coral', 'pink', 'purple',
  'indigo', 'blue', 'teal', 'mint', 'sage', 'gray',
] as const;
export type Tone = (typeof TONES)[number];

export const TONE_CLASS: Record<Tone, string> = {
  cream: 'home-tone-cream', yellow: 'home-tone-yellow', orange: 'home-tone-orange',
  coral: 'home-tone-coral', pink: 'home-tone-pink', purple: 'home-tone-purple',
  indigo: 'home-tone-indigo', blue: 'home-tone-blue', teal: 'home-tone-teal',
  mint: 'home-tone-mint', sage: 'home-tone-sage', gray: 'home-tone-gray',
};

export function isTone(value: unknown): value is Tone {
  return typeof value === 'string' && (TONES as readonly string[]).includes(value);
}

interface IllustrationEntry {
  /** What the admin gallery shows under the tile. */
  label: string;
  tone: Tone;
}

export const ILLUSTRATIONS: Record<string, IllustrationEntry> = {
  'try-three-apps': { get label() { return tr("core:try_three_apps_3b72d5bf"); }, tone: 'mint' },
  'make-a-proposal': { get label() { return tr("core:make_a_proposal_on_an_app_7ea80f60"); }, tone: 'mint' },
  'block-production': { get label() { return tr("core:take_part_in_block_production_98757687"); }, tone: 'mint' },
  'ten-minutes-in-apps': { get label() { return tr("core:spend_ten_minutes_a_week_in_apps_2d2a02f2"); }, tone: 'blue' },
  'proposal-accepted': { get label() { return tr("core:get_a_proposal_accepted_70cb262a"); }, tone: 'purple' },
  'useful-feedback': { get label() { return tr("core:send_useful_feedback_c3bcbc19"); }, tone: 'orange' },
  'network-participation': { get label() { return tr("core:turn_on_network_participation_5d047e01"); }, tone: 'orange' },
  'identity-level-one': { get label() { return tr("core:prove_who_you_are_level_one_521eaa94"); }, tone: 'blue' },
  'identity-level-two': { get label() { return tr("core:prove_who_you_are_level_two_da16989e"); }, tone: 'orange' },
  'connect-participants': { get label() { return tr("core:connect_with_other_participants_9dc0fb1c"); }, tone: 'mint' },
  'invite-to-network': { get label() { return tr("core:invite_someone_to_the_network_2b981a10"); }, tone: 'blue' },
};

export interface ResolvedIllustration {
  slug: string;
  /** The built-in's label; empty for uploaded art (the gallery has its own). */
  label: string;
  tone: Tone;
  toneClass: string;
  /** Same-origin path, derived only from a slug that passed the checks above. */
  src: string;
  uploaded: boolean;
}

/**
 * The illustration for a stored slug, or null when it draws nothing.
 * `tone` is the payload's tone for an UPLOADED slug; built-ins ignore it and
 * use their own. An uploaded slug with no valid tone falls back to gray.
 */
export function resolveIllustration(slug: unknown, tone?: unknown): ResolvedIllustration | null {
  if (typeof slug !== 'string' || !ILLUSTRATION_SLUG.test(slug)) return null;
  if (Object.prototype.hasOwnProperty.call(ILLUSTRATIONS, slug)) {
    const entry = ILLUSTRATIONS[slug];
    return {
      slug, label: entry.label, tone: entry.tone, toneClass: TONE_CLASS[entry.tone],
      src: `/illustrations/challenges/${slug}.svg`, uploaded: false,
    };
  }
  const m = UPLOADED_SLUG.exec(slug);
  if (!m) return null;
  const t: Tone = isTone(tone) ? tone : 'gray';
  return { slug, label: '', tone: t, toneClass: TONE_CLASS[t], src: `/challenge-illustrations/${m[1]}`, uploaded: true };
}

/** The built-ins, in table order, for the admin gallery. */
export function builtInIllustrations(): ResolvedIllustration[] {
  return Object.keys(ILLUSTRATIONS).map((slug) => resolveIllustration(slug) as ResolvedIllustration);
}
