# public/fonts/ibm-plex-sans — the IBM Plex Sans typeface, self-hosted

IBM Plex Sans is the sans-serif of the **Workbench look**, one of the frame's nine looks: an
admin's preview, off by default (Settings › Experimental; the head's
`window.Skin` sets `data-skin` on `<html>`). The `@font-face` rules in
`public/css/app.css` are used only by rules scoped to that attribute, so a
browser with the look off never downloads these files.

Served from our own origin, like `public/vendor/` and `public/fonts/geist/`,
so the shell still makes no cross-origin asset requests.

## Provenance

Copied verbatim from the npm package `@fontsource-variable/ibm-plex-sans`, not from a
CDN. The package is not a dependency: two font files do not justify an entry
in the lockfile. Two unicode subsets ship, latin and latin-ext, with the
package's own `unicode-range` lines, so a page in English downloads one
45 KB file.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `IBMPlexSans-Variable.woff2` | `@fontsource-variable/ibm-plex-sans` | 5.3.0 | `files/ibm-plex-sans-latin-wght-normal.woff2` | `NanSx7VQkdhkOlSmALxwm5pyrMgPPIJHAx5L3FG82xDqDRATAy8ZzJJ3Ih3nwzJy` | 45712 B |
| `IBMPlexSans-Variable-latin-ext.woff2` | `@fontsource-variable/ibm-plex-sans` | 5.3.0 | `files/ibm-plex-sans-latin-ext-wght-normal.woff2` | `4TBULo6jPS4OrjG4pJYDg9NP+zFmachnYJ2m46uMGoBiWpOHHN0+BPLDT4iQKpW8` | 30964 B |

Licence: SIL Open Font License 1.1 (`LICENSE.txt`, the package's own copy).
Upstream: https://github.com/IBM/plex
