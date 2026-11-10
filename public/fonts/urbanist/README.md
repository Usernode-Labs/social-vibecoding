# public/fonts/urbanist — the Urbanist typeface, self-hosted

Urbanist is the sans-serif of the **Mosaic look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/urbanist`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
27 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `Urbanist-Variable.woff2` | `@fontsource-variable/urbanist` | 5.3.0 | `files/urbanist-latin-wght-normal.woff2` | `uT6FhRf0H7OPqP5pVDIj6f4F43FjYPCAdJ+Br5WNcbzKQIWbox8I/MB7FCctLYYR` | 27752 B |
| `Urbanist-Variable-latin-ext.woff2` | `@fontsource-variable/urbanist` | 5.3.0 | `files/urbanist-latin-ext-wght-normal.woff2` | `CLGjVji6S6oX2HN8knlk5pzUKx64Ah2s5CMLKQC2ceJ6s3wAi5GG+HDrvK6suPDe` | 16604 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/coreyhu/Urbanist
