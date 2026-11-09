# public/fonts/geist-mono: the Geist Mono typeface, self-hosted

Geist Mono is the monospace of the Geist family. The shell uses it only for
the **new look**, an experiment that is off by default (Settings ›
Experimental; the head's `window.Skin` sets `data-skin="brand"` on `<html>`),
and there only for counts, so the figures in a row line up. The
`@font-face` in `public/css/app.css` is used only by rules scoped to that
attribute, so a browser with the experiment off never downloads the file.

Served from our own origin, like `public/fonts/geist/`, so the shell still
makes no cross-origin asset requests.

## Provenance

Copied verbatim from the same npm package and version as Geist
(`public/fonts/geist/README.md`), not from a CDN.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `GeistMono-Variable.woff2` | `geist` | 1.8.1 | `dist/fonts/geist-mono/GeistMono-Variable.woff2` | `371qMwnuxzpspWDAR1gBJgz702OoauX8T/AWRARnwN335JyAW8QP+8NulJRXzybU` | 69.6 KB |
| `LICENSE.txt` | `geist` | 1.8.1 | `LICENSE.txt` | | 4.3 KB |

Re-verify against npm with:

    npm pack geist@1.8.1   # then sha384 the dist file

## Licence

SIL Open Font License 1.1 (`LICENSE.txt`, copied from the package). The OFL
asks that the licence travel with the font, so keep the two files together.
