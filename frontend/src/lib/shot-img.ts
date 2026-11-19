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

/** The thumbnail's own address, for a slot that must never load more than that. */
export function shotThumb(image: ShotImage | null | undefined): string | null {
  const thumb = (image?.sizes || []).find((copy) => copy && copy.size === 'thumb' && shotUrlOk(copy.url));
  return thumb ? thumb.url : (shotUrlOk(image?.url) ? image!.url : null);
}
