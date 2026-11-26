# public/fonts/geist-mono: the Geist Mono typeface, self-hosted

Geist Mono is the monospace of the Geist family. The shell uses it for
counts on a request's or a change's page, so the figures in a row line up
(the `@font-face` in `public/css/app.css`).

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
