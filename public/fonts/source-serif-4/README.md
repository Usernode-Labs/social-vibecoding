# public/fonts/source-serif-4 — the Source Serif 4 typeface, self-hosted

Source Serif 4 is the serif of the **Brand kit look** (titles and buttons; a stand-in for the licensed STK Bureau Serif, as the brand guide itself uses), one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/source-serif-4`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
50 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `SourceSerif4-Variable.woff2` | `@fontsource-variable/source-serif-4` | 5.3.0 | `files/source-serif-4-latin-wght-normal.woff2` | `/ILBFWoA8R8g72w1BqOrd5bgTucLXr2cEQuJRJYYBis65lbx1lxDDguUyyvvd3d+` | 50824 B |
| `SourceSerif4-Variable-latin-ext.woff2` | `@fontsource-variable/source-serif-4` | 5.3.0 | `files/source-serif-4-latin-ext-wght-normal.woff2` | `e66E1PoXgdpwO0WEtxyK3ndcjoosCWmAp/fpUndnX/NSDIOYUwTvD+CZNDSXfxef` | 42040 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy with
its copyright line corrected: the package's file opens with a placeholder,
"Google Inc.", and the OFL asks for the font's own notice, so the first line
is the one from the upstream `LICENSE.md`, Adobe's).
Upstream: https://github.com/adobe-fonts/source-serif
