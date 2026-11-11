# public/fonts/ibm-plex-mono — the IBM Plex Mono typeface, self-hosted

IBM Plex Mono is the fixed-width face of the **Workbench look** (labels and numbers; one weight, 500), one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource/ibm-plex-mono`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
15 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `IBMPlexMono-500.woff2` | `@fontsource/ibm-plex-mono` | 5.3.0 | `files/ibm-plex-mono-latin-500-normal.woff2` | `Kw6LIdWT9s2TL76UbmD8dGxybSU6p0ogD2mOoYEcQkhnbbsTR0cK2Is2pVym8+QI` | 14888 B |
| `IBMPlexMono-500-latin-ext.woff2` | `@fontsource/ibm-plex-mono` | 5.3.0 | `files/ibm-plex-mono-latin-ext-500-normal.woff2` | `T/qFfmOeGmzD9vBdN1AA0ZVc8aBghH5cq9MHqsbiosKWXcWDeUjd56WCCocejnU4` | 13432 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/IBM/plex
