# public/fonts/dm-sans — the DM Sans typeface, self-hosted

DM Sans is the sans-serif of the **Pastel look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/dm-sans`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
36 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `DMSans-Variable.woff2` | `@fontsource-variable/dm-sans` | 5.3.0 | `files/dm-sans-latin-wght-normal.woff2` | `peHPb6JvfWdMLW/PEYQq9S2GB30qKCRhW6sS8gOYX0BWM0Asqyz/uKWHjG0grpQm` | 36932 B |
| `DMSans-Variable-latin-ext.woff2` | `@fontsource-variable/dm-sans` | 5.3.0 | `files/dm-sans-latin-ext-wght-normal.woff2` | `99hRQrmCD0F+VHK6iglLOLlHzWse6wivIuAcKzvJitsiLloGpC4rjq6npnrC+T/K` | 18228 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/googlefonts/dm-fonts
