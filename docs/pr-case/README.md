# Pull-request case

This directory is the reviewer-facing case for the React design-system
migration. Every comparison is pinned to:

- main: `92b1fb50d5265af56db86c7ba74867629a45091f`
- integrated branch: `51c95ab2e45b99259b947205762a78e5dab7f6e8`

Open `index.html` for the self-contained interactive deck. Use the arrow keys,
Page Up, Page Down, Home, or End to move between slides. `pr-case.pdf` is the
portable document. The five `images/pr-case-*.png` files are the selected
pull-request-description exports.

## Reproduce

Run from `frontend/`:

```sh
npm run build:pr-case
npm run export:pr-case
npm run verify:pr-case
```

`npm run capture:pr-case` regenerates the four route captures from the pinned
main archive and the integrated React route. It uses a fixed fixture, blocked
service workers, and the frozen browser-compiler response documented under
`capture-fixtures/`.

`check:design-system` verifies that the generated page and every exported file
still match their tracked hashes. Builds do not mutate these files.
