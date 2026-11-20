# public/fonts/instrument-sans — the Instrument Sans typeface, self-hosted

Instrument Sans is the sans-serif of the **Paper look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/instrument-sans`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
29 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `InstrumentSans-Variable.woff2` | `@fontsource-variable/instrument-sans` | 5.3.0 | `files/instrument-sans-latin-wght-normal.woff2` | `AkSU/zowXNwJ1vhig5p+XWCurwt7W/yppqdvCVd9DzyBKedHAO/tTvD41/aA/StS` | 30092 B |
| `InstrumentSans-Variable-latin-ext.woff2` | `@fontsource-variable/instrument-sans` | 5.3.0 | `files/instrument-sans-latin-ext-wght-normal.woff2` | `pHcjIyjNS/dWX6K6Kbn1BuSfkv6IYcCtw2Fn7Hee8XEPgS98slLbE3tczYk5cIea` | 11144 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/Instrument/instrument-sans
