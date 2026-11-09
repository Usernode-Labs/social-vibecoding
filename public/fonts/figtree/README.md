# public/fonts/figtree — the Figtree typeface, self-hosted

Figtree is the sans-serif of the **Today look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/figtree`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
20 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `Figtree-Variable.woff2` | `@fontsource-variable/figtree` | 5.3.0 | `files/figtree-latin-wght-normal.woff2` | `d6yvnpflv3m5EhqKK5tQtz0HGXMOiCO1F3+L6ha906VSjNeZv+OL3TCteJovhzem` | 20156 B |
| `Figtree-Variable-latin-ext.woff2` | `@fontsource-variable/figtree` | 5.3.0 | `files/figtree-latin-ext-wght-normal.woff2` | `9KSE+iGQ6oJir2yKgmVPQ/gODeYwkECMhN0JLI++3ClZD+uwv045wTApXF0Xeydb` | 10280 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/erikdkennedy/figtree
