# public/fonts/geist — the Geist typeface, self-hosted

Geist is the sans-serif of the Homeroom brand kit. The shell draws words in
it where `public/css/app.css` names it (`--wip-font`, `--site-sans`, a
request's or a change's page), declared by the `@font-face` there.

Served from our own origin, like `public/vendor/`, so the shell still makes
no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package, not from a CDN. The package is not a
dependency: it declares Next.js as a peer, and one font file does not
justify pulling a framework into the lockfile.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `Geist-Variable.woff2` | `geist` | 1.8.1 | `dist/fonts/geist-sans/Geist-Variable.woff2` | `bUOkhcCOv0A6hGA9b5d5Tw1AL+HA4YxnMFKiYOfmmi04FLltPc8/w8hWBdXGzq2P` | 67.9 KB |
| `LICENSE.txt` | `geist` | 1.8.1 | `LICENSE.txt` | | 4.3 KB |

Re-verify against npm with:

    npm pack geist@1.8.1   # then sha384 the dist file

## Licence

SIL Open Font License 1.1 (`LICENSE.txt`, copied from the package). The OFL
asks that the licence travel with the font, so keep the two files together.
