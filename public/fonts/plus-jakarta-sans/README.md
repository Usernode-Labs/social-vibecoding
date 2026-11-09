# public/fonts/plus-jakarta-sans — the Plus Jakarta Sans typeface, self-hosted

Plus Jakarta Sans is the sans-serif of the **Sunrise look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/plus-jakarta-sans`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
27 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `PlusJakartaSans-Variable.woff2` | `@fontsource-variable/plus-jakarta-sans` | 5.3.0 | `files/plus-jakarta-sans-latin-wght-normal.woff2` | `PLr9Pw5Kj/wYLXprEoC4H+A67gWdr/vTHwjvixEXhBKOSEkgKsA9wRwZRvAEnGeN` | 27348 B |
| `PlusJakartaSans-Variable-latin-ext.woff2` | `@fontsource-variable/plus-jakarta-sans` | 5.3.0 | `files/plus-jakarta-sans-latin-ext-wght-normal.woff2` | `YEgChAoYNVoWusG3QRillTHqLx/4d4yiobHamK1BGpCrERveCLISj8XaL4z3SWhb` | 21728 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/tokotype/PlusJakartaSans
