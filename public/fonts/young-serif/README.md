# public/fonts/young-serif: the Young Serif typeface, self-hosted

Young Serif stands in for the serif of the Homeroom website. The **brand
look** ("Paper, simplified, with brand styling", one of the looks of
Settings › Experimental › Look) declares it in its block of
`public/css/app.css` and drew its titles in it at first. Its titles are
Geist now, and no rule of the look names the face. The declaration and the
file are kept for the signed-out pages' look, which draws its headlines in
it. A browser downloads the file only when a rule that names the face
matches something on the page.

Served from our own origin, like `public/fonts/geist/`, so the shell still
makes no cross-origin asset requests. Only the Latin subset is committed:
a title in another script falls back to the system serif.

## Provenance

Copied verbatim from the npm package, not from a CDN. The package is not a
dependency.

| File | Package | Version | Source path in package | sha384 (base64) | Size |
|---|---|---|---|---|---|
| `young-serif-latin-400-normal.woff2` | `@fontsource/young-serif` | 5.2.7 | `files/young-serif-latin-400-normal.woff2` | `mC26+gOPbM+kF3DtNSe058awroabPXu3/RV0slX2qPokKrPDFSRK0KpAd562gjTb` | 26.4 KB |
| `LICENSE.txt` | `@fontsource/young-serif` | 5.2.7 | `LICENSE` | | 4.3 KB |

Re-verify against npm with:

    npm pack @fontsource/young-serif@5.2.7   # then sha384 the file

## Licence

SIL Open Font License 1.1 (`LICENSE.txt`, copied from the package). The OFL
asks that the licence travel with the font, so keep the two files together.
