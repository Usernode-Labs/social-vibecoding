/**
 * #6825: the smaller copies of a before/after still, and the blurred
 * preview a slot draws until one arrives.
 *
 * The server makes a thumbnail (600 px on its long side) and a screen-size
 * copy (1200 px wide) when a still is saved, and lists them as `sizes` in the
 * shots view (services/shots-view.js); the original PNG is still `url`, and
 * zoom and the full view keep it. A slot takes the smallest copy that is
 * sharp for it through `srcset`, and fills with `placeholder` (a 20 px wide
 * WebP, inside the shots view) while the copy loads.
 */

/** One smaller copy of a still, at its own address. */
export type ShotSize = { size: 'thumb' | 'screen'; url: string; width: number; height: number };

/** What a slot needs to pick a copy: the artifact's own url, its pixels, its copies and preview. */
export type ShotImage = {
  url: string;
  width?: number | null;
  height?: number | null;
  sizes?: ShotSize[];
  placeholder?: string | null;
};

/** Only this proposal's own shots route, with the copy's own query. */
const SHOT_PATH = /^\/api\/apps\/[^/?#]+\/proposals\/\d+\/shots\/[0-9a-f]{32}(?:\?(?:density=device|size=(?:thumb|screen)))?$/;
/** The preview is the one the server sent: a 20 px WebP data URI, under 1.4 KB. */
const PLACEHOLDER = /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/;

export function shotUrlOk(url: unknown): url is string {
  return typeof url === 'string' && SHOT_PATH.test(url);
}

/**
 * `"thumb 277w, screen 750w, /shots/<id> 1170w"`, smallest first: the browser
 * takes the smallest copy sharp for the slot and the screen. Undefined when
 * the still has no smaller copy (a run from before them), so the slot loads
 * its one url, exactly as it always did.
 */
export function shotSrcSet(image: ShotImage | null | undefined): string | undefined {
  const sizes = (image?.sizes || []).filter((copy) => copy && shotUrlOk(copy.url) && copy.width > 0);
  if (!sizes.length || !image || !shotUrlOk(image.url)) return undefined;
  const own = Number(image.width) > 0 ? Number(image.width) : null;
  const parts = sizes.map((copy) => `${copy.url} ${Math.round(copy.width)}w`);
  if (own) parts.push(`${image.url} ${own}w`);
  return parts.join(', ');
}

/**
 * The background a slot draws until the still decodes, or undefined.
 *
 * `stretch` fills the whole box instead of covering it: a placed (zoomed)
 * still is the whole screen transformed, so its preview has to line up with
 * that same box, exactly.
 */
export function shotPreview(
  image: ShotImage | null | undefined,
  { stretch = false }: { stretch?: boolean } = {},
): { backgroundImage: string; backgroundSize: string; backgroundPosition: string } | undefined {
  const value = typeof image?.placeholder === 'string' && image.placeholder.length <= 1400
    && PLACEHOLDER.test(image.placeholder) ? image.placeholder : null;
  return value
    ? {
        backgroundImage: `url("${value}")`,
        backgroundSize: stretch ? '100% 100%' : 'cover',
        backgroundPosition: stretch ? '0 0' : 'center',
      }
    : undefined;
}

/** How many times a slot asks again for a still that ended with no picture. */
export const SHOT_RETRIES = 2;
/** How often a slot looks at a still that has not shown yet, in ms. */
export const SHOT_CHECK_MS = 1500;

type ShotElement = EventTarget & { complete: boolean; naturalWidth: number };

/**
 * Whether a still's load is over with nothing to show. WebKit fires neither
 * `load` nor `error` when an image's load is cancelled from outside the
 * element (ImageLoader::notifyFinished returns early on `wasCanceled()`):
 * the element is complete, has no pixels, and nothing else happens.
 */
export function shotBroken(img: ShotElement | null | undefined): boolean {
  return !!img && img.complete && !(img.naturalWidth > 0);
}

/**
 * Watches one still until it shows. When its load is over with no picture,
 * `retry` is called so the slot can mount a new element, which asks again:
 * at most `budget.left` times across the slot's elements, and that budget
 * is full again when the page comes back (shown again, or back online), the
 * moment a load cut off while it was away is found. Without this the slot
 * kept its blurred preview, and the alt text over it, until another screen
 * was opened and this one again (the 20 Nov report). Returns the cleanup.
 */
export function watchShot(
  img: ShotElement,
  budget: { left: number },
  retry: () => void,
  {
    max = SHOT_RETRIES,
    every = SHOT_CHECK_MS,
    win = (typeof window !== 'undefined' ? window : null) as EventTarget | null,
    doc = (typeof document !== 'undefined' ? document : null) as (EventTarget & { visibilityState?: string }) | null,
    timers = globalThis as { setInterval: typeof setInterval; clearInterval: typeof clearInterval },
  } = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let done = false;
  const away = () => !!doc && doc.visibilityState === 'hidden';
  const stop = () => {
    if (done) return;
    done = true;
    if (timer != null) timers.clearInterval(timer);
    timer = null;
    img.removeEventListener('load', look);
    win?.removeEventListener('online', back);
    win?.removeEventListener('pageshow', back);
    doc?.removeEventListener('visibilitychange', back);
  };
  function look() {
    if (done) return;
    if (img.complete && img.naturalWidth > 0) { stop(); return; }
    if (away() || !shotBroken(img)) return;
    if (budget.left <= 0) {
      // Out of tries: stop looking, but a comeback still asks again.
      if (timer != null) timers.clearInterval(timer);
      timer = null;
      return;
    }
    budget.left -= 1;
    stop();
    retry();
  }
  function back() {
    if (done || away()) return;
    budget.left = Math.max(budget.left, max);
    look();
  }
  img.addEventListener('load', look);
  win?.addEventListener('online', back);
  win?.addEventListener('pageshow', back);
  doc?.addEventListener('visibilitychange', back);
  timer = timers.setInterval(look, every);
  return stop;
}

/** The thumbnail's own address, for a slot that must never load more than that. */
export function shotThumb(image: ShotImage | null | undefined): string | null {
  const thumb = (image?.sizes || []).find((copy) => copy && copy.size === 'thumb' && shotUrlOk(copy.url));
  return thumb ? thumb.url : (shotUrlOk(image?.url) ? image!.url : null);
}
