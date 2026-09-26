import * as React from 'react';

/**
 * The Homeroom mark — the script "H" with its four-point sparkle — as one
 * primitive.
 *
 * ── Why this exists beside wordmark.tsx, and not as the raster it replaces ──
 *
 * `../header/platform-mark.tsx` used to draw this as
 * `<img src="/brand/homeroom-mark.png">`, a two-colour lockup (cream on
 * near-black) that its own header comment justified as "a brand tile does not
 * re-colour per theme any more than an app's own icon does." That is still
 * true of the TILE; it stopped being true of the ink the day the mark's own
 * colour became the platform accent (`violet-600` / `--accent`, `#0a6ee0`)
 * rather than a fixed brand cream. An accent that lives in one file
 * (`tailwind.config.js`) and a raster that repeats it as baked-in pixels are
 * two sources of truth for the same colour, so the mark is inline source now,
 * exactly the reason `Wordmark` above it is: `fill="currentColor"` lets one
 * drawing take whatever ink its call site sets, with no second file and no
 * second request when the accent moves again.
 *
 * `public/brand/homeroom-mark.png` itself is UNCHANGED and still committed —
 * `../app-context/about-pane.tsx` and `../profile/profile-view.tsx` still draw
 * it, and neither is in scope here. Only the header's own use of it is
 * retired. See `public/brand/README.md`.
 *
 * ── Provenance ────────────────────────────────────────────────────────────
 *
 * The two `d` strings below are the same Figma vectors
 * `scripts/generate-pwa-icons.js` carries — file `4kAYqXh9NhpoCU44QwWvYo`,
 * frame `1246:179` ("A"): `1246:183` is the H, `1246:184` the sparkle — copied
 * verbatim so the app icon, the favicon and this header control are all the
 * same drawing rather than three redrawings of it. The generator's own header
 * comment records the export in full; this file does not repeat that, only
 * the paths themselves, since a copy of a copy drifts.
 *
 * They are named literals for the same reason `WORDMARK_PATHS`'s are:
 * `tests/shell-icon-set.test.js` reads a module's path data as its quoted
 * literals, and that test is what proves no path in the shipped document
 * drifted by a character. This file is the THIRD home it reads.
 */
const MARK_PATHS: readonly string[] = [
  // 1246:183 — the H.
  'M282.189 0.0184905C293.177 -0.604608 288.538 14.682 287.489 21.4275C285.905 32.2434 284 43.0111 281.788 53.7164L266.215 133.631C261.47 158.905 253.667 190.232 255.815 215.829C256.366 220.783 259.692 230.204 264.084 232.79C284.827 245.01 310.841 225.149 324.219 210.07C326.038 208.023 331.965 199.835 333.65 199.543C340.38 201.027 333.91 209.31 331.86 212.815C313.045 244.972 244.904 303.554 211.715 261.345C195.524 240.754 205.895 198.505 210.475 173.268C204.051 173.857 197.465 175.394 191.045 176.206C180.723 177.511 170.247 178.385 159.87 179.135C159.221 184.031 157.523 191.621 156.553 196.671L148.885 235.802L143.91 262.1C140.066 282.074 141.043 280.208 122.179 287.814C112.216 291.83 101.685 296.154 91.5309 300C89.6438 298.559 88.1998 297.774 88.4988 295.149C89.1308 289.592 90.3422 284.049 91.3923 278.551L98.8461 240.768C102.015 222.82 105.524 204.933 109.372 187.118L109.168 187.156C80.3032 192.726 41.3404 213.558 29.3653 242.87C28.5769 244.8 29.377 248.673 27.985 250.494C24.7479 254.747 19.1217 249.066 16.3538 246.979C-18.4859 220.706 8.61355 179.535 39.32 164.777C43.8661 162.592 48.4964 159.119 53.4817 157.03C73.6383 148.585 95.9044 143.669 117.64 141.63C124.515 122.017 126.011 95.8396 131.239 75.3085C132.63 69.8489 134.25 50.7848 138.789 47.8492C147.904 41.9529 160.588 38.3885 170.677 34.2403C175.511 32.2766 180.441 28.6401 185.528 27.9194C188.438 27.622 189.078 32.8134 188.795 34.7593C187.414 44.2622 184.895 53.5523 183.13 62.9997L168.863 138.998C175.211 138.852 184.739 138.113 191.045 137.184C208.259 133.879 201.647 135.532 217.82 130.139C222.813 102.028 228.072 73.9639 233.597 45.952C234.64 40.3911 237.641 18.3144 239.622 15.0434C240.826 13.0533 242.425 12.0757 244.507 11.1204C248.259 9.39657 252.598 8.66044 256.552 7.47947C265.06 4.94008 273.564 2.13776 282.189 0.0184905Z',
  // 1246:184 — the sparkle.
  'M332.573 79.3281C333.663 79.5987 333.906 79.7041 334.907 80.2198C335.932 81.6536 337.325 89.1733 338.107 91.4574C343.767 108.044 346.465 115.586 364.113 120.729C368.375 121.972 372.864 122.226 376.749 124.279C377.462 125.223 377.329 125.836 377.296 126.998C377.13 127.312 376.932 127.683 376.705 128.109C367.071 132.072 352.546 133.991 345.614 142.885C342.146 147.337 338.123 159.819 336.746 165.5C335.98 168.65 335.684 171.234 333.047 172.978L331.131 172.309C329.028 170.349 327.493 160.796 326.553 157.414C325.682 154.312 324.657 151.256 323.482 148.255C322.967 146.922 321.42 143.093 320.467 142.055C315.509 136.663 307.057 133.292 300.113 131.507C296.633 130.613 293.323 130.111 290.074 128.786C288.765 128.252 288.713 127.821 288.352 126.776C288.551 125.826 288.547 125.392 289.389 124.806C291.164 123.575 294.231 123.021 296.305 122.436C304.132 120.229 312.004 117.815 318.191 112.247C326.565 104.714 327.963 82.6316 332.573 79.3281Z',
];

export interface LogoMarkProps
  extends Omit<React.SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'fill' | 'stroke' | 'd'> {
  /**
   * The accessible name, for a site where the mark IS the name. Renders
   * `role="img" aria-label={title}`, the same pair `Wordmark` uses. Omit it
   * where a heading or an `sr-only` span already carries the name — the
   * header button does, via its own `aria-label` — and it renders
   * `aria-hidden="true"` instead.
   */
  title?: string;
}

export function LogoMark({ id, className, title, ...rest }: LogoMarkProps) {
  return (
    <svg
      id={id}
      className={className}
      fill="currentColor"
      viewBox="0 0 377.327 300"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : 'true'}
      {...rest}
    >
      {MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
LogoMark.displayName = 'LogoMark';
