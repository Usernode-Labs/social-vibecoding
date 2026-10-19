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
  'try-three-apps': { label: 'Try three apps', tone: 'mint' },
  'make-a-proposal': { label: 'Make a proposal on an app', tone: 'mint' },
  'block-production': { label: 'Take part in block production', tone: 'mint' },
  'ten-minutes-in-apps': { label: 'Spend ten minutes a week in apps', tone: 'blue' },
  'proposal-accepted': { label: 'Get a proposal accepted', tone: 'purple' },
  'useful-feedback': { label: 'Send useful feedback', tone: 'orange' },
  'network-participation': { label: 'Turn on network participation', tone: 'orange' },
  'identity-level-one': { label: 'Prove who you are: level one', tone: 'blue' },
  'identity-level-two': { label: 'Prove who you are: level two', tone: 'orange' },
  'connect-participants': { label: 'Connect with other participants', tone: 'mint' },
  'invite-to-network': { label: 'Invite someone to the network', tone: 'blue' },
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

/**
 * DECODED BEFORE THE CARD DRAWS (#1 and #10, the polish board of 19 Oct
 * 2026). A challenge card drew on Home with an empty tone where its picture
 * goes, and the picture arrived a frame or more later: an <img> starts its
 * fetch when it is inserted, and paints once it has decoded. So Home's
 * panels decode the art its cards are about to show first, and draw them
 * after (features/home/home-panels.js `_warmArt`): an image this document has
 * decoded is in the browser's memory cache, and a new <img> of it paints in
 * the frame it is inserted. The built-ins come from the service worker's
 * release cache (public/sw.js), so this is a few milliseconds; `capMs` is the
 * most it waits, after which the cards draw and the art follows as it did.
 *
 * The decoded images are kept, so the memory cache keeps them too. A slug that
 * draws nothing, or art that fails, costs nothing. Resolves, never rejects.
 */
const warmed = new Map<string, HTMLImageElement>();

export function warmIllustrations(
  art: ReadonlyArray<{ slug?: unknown; tone?: unknown }>,
  capMs = 400,
): Promise<void> {
  if (typeof Image === 'undefined') return Promise.resolve();
  const srcs: string[] = [];
  for (const item of art) {
    const src = resolveIllustration(item && item.slug, item && item.tone)?.src;
    if (src && !warmed.has(src) && !srcs.includes(src)) srcs.push(src);
  }
  if (!srcs.length) return Promise.resolve();
  const decodeOne = (src: string) => new Promise<void>((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    const done = () => { warmed.set(src, img); resolve(); };
    img.onerror = () => resolve();
    img.src = src;
    if (typeof img.decode === 'function') img.decode().then(done, () => resolve());
    else img.onload = done;
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cap = new Promise<void>((resolve) => { timer = setTimeout(resolve, capMs); });
  return Promise.race([Promise.all(srcs.map(decodeOne)).then(() => undefined), cap])
    .then(() => { if (timer) clearTimeout(timer); });
}
