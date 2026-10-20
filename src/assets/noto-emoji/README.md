# Noto Emoji pictures for the invite link preview

The emoji pictures `src/services/emoji-tile.js` lays on a project's colour
to draw its icon as a PNG, for the thumbnail of an invite link's preview
(`GET /api/public/invites/:token/icon.png`). The server reads them from
here; it fetches nothing from another site.

Each file is named by the emoji's code points, lowercase hex joined by `_`,
without U+FE0F (`codepointsOf` in emoji-tile.js): `1f4ca.png` is 📊. Each is
288 x 288 (`GLYPH`, 60% of the 480px tile), the emoji alone on a
transparent ground, in 256 colours with transparency (a third of the size,
and no different to the eye at a thumbnail's size).

## Provenance and licence

From [Noto Emoji](https://github.com/googlefonts/noto-emoji) by Google,
whose images are under the Apache License 2.0. Each is the project's 512px
PNG of that emoji (the one Google Fonts serves as
`notoemoji/latest/<code points>/512.png`), scaled to 288px by averaging the
pixels each new pixel covers, in premultiplied alpha, then reduced to 256
colours. Nothing else is changed.

## Which emoji

Every emoji a ready-made idea gives its project (the `icon` of each entry
in `src/services/app-templates.js`, and the `emoji` of each idea in
`frontend/src/features/first-session/examples.ts`).
`tests/emoji-tile.test.js` fails when one of them has no picture here, so a
new idea brings its picture with it. A project whose emoji has none (one a
person or Homeroom bot chose) keeps Homeroom's own icon as its thumbnail.
