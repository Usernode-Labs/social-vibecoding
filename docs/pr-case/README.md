# Pull-request case

This directory is the reviewer-facing case for the staged React shell and its
governed interface system. Every comparison is pinned to:

- main: `472de79151060300df68fc6e98e242351d76eef0`
- integrated branch: `2f8605304ba9812474b2a8d8a8a0ff3fc3a83bf9`

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

`npm run capture:pr-case` regenerates four comparisons between legacy `/` at
the pinned main archive and staged React `/react/` at the integrated branch.
It uses a fixed fixture, blocked service workers, and the frozen
browser-compiler response documented under `capture-fixtures/`.

`check:design-system` verifies that the generated page and every exported file
still match their tracked hashes. Builds do not mutate these files.
