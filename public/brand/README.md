# public/brand — the brand artwork the shell draws

HAND-EXPORTED and hand-committed. Nothing regenerates this directory: there is
no `npm run` that rewrites these files or this README, and the repository
carries no image tooling at all (no `sharp`, `imagemin`, `pngquant` or `svgo`
in either `package.json`, and the Docker build never touches an image). So the
only record of where a file came from and how it was made is the table below —
keep it true by hand, or the next person re-derives it from scratch.

Only ONE of the two brand marks is a file here. The logotype ships as SOURCE,
inlined as eight `<path>` elements in
`frontend/@/components/ui/wordmark.tsx`, because `fill="currentColor"` lets
one drawing take the ink of wherever it sits — the landing header, the sign-in
card, the home header's app chip at 20px — with no dark variant, no second
file and no second request. Its own header explains the split. This note is
here so someone looking for the logo in the obvious place finds it.

## Provenance

| File | Figma file key | Node id | Export | Dimensions | Size |
|---|---|---|---|---|---|
| `people.png` | `4kAYqXh9NhpoCU44QwWvYo` | `1246:166` | the node's raw image fill, downsampled and quantised (below) | 816 × 612, 8-bit palette PNG with `tRNS`, sRGB | 87.9 KB |

There is no `sha384` column, and the omission is deliberate rather than an
oversight. `public/vendor/README.md` records a digest per file because each of
those is a copy of a published npm artefact and the digest is re-verifiable
against upstream. A design export has no upstream to check against: a digest
here would prove only that nobody has changed the file since it was written
down, which the diff already proves. The file key plus the node id plus the
export recipe below IS the reproducibility claim.

**How `people.png` was made, and why not simply "export the node".** The
node's own PNG export bakes an opaque `#FFFEEA` frame background into the
image, which would draw as a cream rectangle on the dark ground — and the
illustration is specified to sit straight on the ground in both themes, with
no plate. So the export is the node's raw uploaded image fill instead, which
is transparent: 1448 × 1086 RGBA, Lanczos-downsampled to 816 px wide and
quantised with

    pngquant --quality=70-95 --speed 1 64

`pngquant` is on a developer machine (Homebrew), not in CI — this is a one-off
local step whose OUTPUT is committed. Measured at export against the
unquantised 3× render, the quantisation costs RMSE 4.1/255, which is invisible
on this artwork and takes the file from roughly 605 KB to 87.9 KB.

**Why 816 px.** The landing draws the illustration in a 272 pt box, so 816 is
3× — sharp on a 3× phone, which is the screen this redesign was drawn for and
the only one it is judged on. The weight is the reason to state that
explicitly: 87.9 KB is several times the largest artwork committed anywhere
else in the tree (the nine challenge illustrations run 5.5–21 KB, capped at
64 KB by `tests/challenge-illustrations.test.js`). Nothing in the suite
enforces a budget on this file. It is the logged-out screen's one image, it
carries the whole first impression, and 2× would save about 40 KB and lose the
reason it is there — but it was a choice, and this paragraph is where it is
recorded.

## What each one is for

- **people.png** — the illustration on the logged-out landing screen,
  `frontend/src/features/auth/landing.tsx`, drawn as a plain `<img>` above the
  activity chips. Decorative: the heading beside it carries the meaning, so it
  ships with an empty `alt`.

## Offline

The shell DOES precache images — `public/sw.js`'s `SHELL_ASSETS` lists the
three PWA icons, and `classifyRequest` has the matching `/icons/` rule that
makes them read back out of the cache. Precaching is those two halves
together; an entry with no rule fills the cache on install and is never read
from, because anything `classifyRequest` calls `'bypass'` is handled by the
browser and never consults the worker.

`people.png` is on the precached side, and both halves belong to whichever
proposal first draws it. The contrast worth knowing is challenge artwork,
which is deliberately left to the network and pinned that way in
`tests/pwa-sw-classify.test.js`: an offline challenge card whose picture fails
to load draws its kind icon instead, so caching nine SVGs would buy nothing a
reader can tell apart. The landing has no such fallback. `/index.html` is
precached, so a signed-out visitor CAN reach the new landing offline — and
without this entry they would reach it with a hole where the illustration is.

## Replacing an asset

1. Re-export from the node id in the table above — the raw image fill, not the
   node's PNG export, for the transparency reason recorded above.
2. Re-run the downsample and `pngquant` line above, and measure the result
   with `ls -l` rather than predicting it.
3. Commit the new bytes and update this table's Dimensions and Size in the
   same commit.
4. Keep the file's `SHELL_ASSETS` entry and its `classifyRequest` rule in
   `public/sw.js`, and bump `SW_VERSION` there: an installed client holds the
   precached copy until the worker version changes, so replacing the bytes
   under the same URL otherwise reaches new visitors only.

There is no step here about editing `public/index.html`. That file is
generated from `frontend/` and gitignored — the vendor README's equivalent
step predates the React shell and must not be copied across.
