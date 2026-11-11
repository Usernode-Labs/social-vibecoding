# public/fonts/nunito — the Nunito typeface, self-hosted

Nunito is the sans-serif of the **Playground look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/nunito`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
38 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `Nunito-Variable.woff2` | `@fontsource-variable/nunito` | 5.3.0 | `files/nunito-latin-wght-normal.woff2` | `TWd3PH4EGnohqki2EDBpXSMYXeH117J7U9BY50pL/4f4GvA2rBfiJWv3s1SKZIsv` | 39128 B |
| `Nunito-Variable-latin-ext.woff2` | `@fontsource-variable/nunito` | 5.3.0 | `files/nunito-latin-ext-wght-normal.woff2` | `MBPoN6KZCN35qoZlx0O1QY9vwHS7dyh5slFbGS0LZ6ATaYJScTAEJ2PVUE+ZyUqa` | 35588 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/googlefonts/nunito
